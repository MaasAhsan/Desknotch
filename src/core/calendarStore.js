'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

class CalendarStore {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS calendar_events (
        uid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        description TEXT NOT NULL,
        location TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, uid),
        FOREIGN KEY (source_id) REFERENCES calendar_sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_at);
      CREATE TABLE IF NOT EXISTS calendar_reminders (
        reminder_key TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL
      );
    `);
    this.db.exec('PRAGMA foreign_keys=ON;');
  }

  addSource(url, name = '') {
    const id = crypto.randomUUID();
    let fallbackName = 'Calendar';
    try { fallbackName = new URL(url).hostname; } catch (_) { /* encrypted stored URL; caller supplies name */ }
    const label = String(name || fallbackName).slice(0, 100);
    this.db.prepare('INSERT INTO calendar_sources (id, name, url, enabled) VALUES (?, ?, ?, 1)')
      .run(id, label, String(url));
    return this.getSources().find((source) => source.id === id);
  }

  getSources() {
    return this.db.prepare('SELECT id, name, url, enabled, last_sync AS lastSync, last_error AS lastError FROM calendar_sources ORDER BY name COLLATE NOCASE').all();
  }

  getSource(id) { return this.db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(String(id)); }

  removeSource(id) {
    this.db.prepare('DELETE FROM calendar_events WHERE source_id = ?').run(String(id));
    this.db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(String(id));
  }

  replaceEvents(sourceId, events) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM calendar_events WHERE source_id = ?').run(String(sourceId));
      const insert = this.db.prepare(`INSERT OR REPLACE INTO calendar_events
        (uid, source_id, summary, description, location, start_at, end_at, all_day)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const event of events) {
        insert.run(String(event.uid), String(sourceId), String(event.summary || 'Untitled event'),
          String(event.description || ''), String(event.location || ''), Number(event.startAt),
          Number(event.endAt), event.allDay ? 1 : 0);
      }
      this.db.prepare('UPDATE calendar_sources SET last_sync = ?, last_error = NULL WHERE id = ?').run(Date.now(), String(sourceId));
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* preserve original failure */ }
      throw error;
    }
  }

  setError(sourceId, error) {
    this.db.prepare('UPDATE calendar_sources SET last_error = ? WHERE id = ?').run(String(error).slice(0, 500), String(sourceId));
  }

  listEvents({ from = Date.now() - 3_600_000, to = Date.now() + 14 * 86_400_000, limit = 200 } = {}) {
    return this.db.prepare(`SELECT e.uid, e.source_id AS sourceId, s.name AS calendarName,
      e.summary, e.description, e.location, e.start_at AS startAt, e.end_at AS endAt,
      e.all_day AS allDay
      FROM calendar_events e JOIN calendar_sources s ON s.id = e.source_id
      WHERE e.start_at BETWEEN ? AND ? ORDER BY e.start_at LIMIT ?`)
      .all(Number(from), Number(to), Math.min(500, Math.max(1, Number(limit) || 200)))
      .map((event) => ({ ...event, allDay: !!event.allDay }));
  }

  claimReminder(event, leadMinutes, now = Date.now()) {
    const reminderAt = Number(event.startAt) - Number(leadMinutes) * 60_000;
    if (now < reminderAt || now >= Number(event.startAt)) return false;
    const key = `${event.sourceId}:${event.uid}:${Number(event.startAt)}:${Number(leadMinutes)}`;
    const result = this.db.prepare('INSERT OR IGNORE INTO calendar_reminders (reminder_key, sent_at) VALUES (?, ?)').run(key, now);
    return Number(result.changes) === 1;
  }

  pruneReminders(days = 30) {
    this.db.prepare('DELETE FROM calendar_reminders WHERE sent_at < ?').run(Date.now() - Math.max(1, days) * 86_400_000);
  }

  close() { try { this.db.close(); } catch (_) { /* already closed */ } }
}

module.exports = { CalendarStore };
