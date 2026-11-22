'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

class HistoryStore {
  constructor(filePath, { retentionDays = 30 } = {}) {
    this.filePath = filePath;
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'windows',
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'shown'
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_app_id ON notifications(app_id);
    `);
    this.retentionDays = retentionDays;
    this.insertStatement = this.db.prepare(`
      INSERT OR IGNORE INTO notifications
      (id, app_id, app_name, title, body, received_at, source, priority, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  record(notification, { priority = false, status = 'shown' } = {}) {
    const receivedAt = Number(notification.receivedAt) || Date.now();
    const id = String(notification.id || crypto.randomUUID());
    this.insertStatement.run(
      id,
      String(notification.appId || notification.app || 'unknown').slice(0, 256),
      String(notification.app || 'Notification').slice(0, 80),
      String(notification.title || '').slice(0, 300),
      String(notification.body || '').slice(0, 2000),
      receivedAt,
      String(notification.source || 'windows').slice(0, 40),
      priority ? 1 : 0,
      String(status).slice(0, 40),
    );
    this.prune(this.retentionDays);
    return id;
  }

  list({ query = '', limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const q = String(query).trim().slice(0, 200);
    if (!q) {
      return this.db.prepare(`SELECT * FROM notifications ORDER BY received_at DESC LIMIT ? OFFSET ?`).all(safeLimit, safeOffset);
    }
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(`
      SELECT * FROM notifications
      WHERE app_name LIKE ? ESCAPE '\\' OR app_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
      ORDER BY received_at DESC LIMIT ? OFFSET ?
    `).all(pattern, pattern, pattern, pattern, safeLimit, safeOffset);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(String(id));
  }

  apps() {
    return this.db.prepare(`
      SELECT app_id AS appId, app_name AS appName, COUNT(*) AS count, MAX(received_at) AS lastSeen
      FROM notifications GROUP BY app_id ORDER BY lastSeen DESC
    `).all();
  }

  clear() { this.db.exec('DELETE FROM notifications'); }

  prune(days = this.retentionDays) {
    const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM notifications WHERE received_at < ?').run(cutoff);
  }

  close() {
    try { this.db.close(); } catch (_) { /* Already closed. */ }
  }
}

module.exports = { HistoryStore };
