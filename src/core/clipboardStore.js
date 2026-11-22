'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

class ClipboardStore {
  constructor(filePath, { maxItems = 200, retentionDays = 7, encryptContent = (value) => value, decryptContent = (value) => value } = {}) {
    this.db = new DatabaseSync(filePath);
    this.maxItems = maxItems;
    this.retentionDays = retentionDays;
    this.encryptContent = encryptContent;
    this.decryptContent = decryptContent;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clipboard_items (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_items(created_at DESC);
    `);
  }

  record(content) {
    const text = String(content ?? '').replace(/\u0000/g, '').slice(0, 20_000);
    if (!text.trim()) return null;
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    const latest = this.db.prepare('SELECT content_hash FROM clipboard_items ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
    if (latest?.content_hash === contentHash) return null;
    const item = { id: crypto.randomUUID(), content: text, created_at: Date.now() };
    this.db.prepare('INSERT INTO clipboard_items (id, content, content_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(item.id, this.encryptContent(item.content), contentHash, item.created_at);
    this.prune();
    return item;
  }

  list({ query = '', limit = 100 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const q = String(query).trim().slice(0, 200).toLowerCase();
    const rows = this.db.prepare('SELECT id, content, created_at FROM clipboard_items ORDER BY created_at DESC, rowid DESC LIMIT 1000')
      .all().map((row) => ({ ...row, content: this.decryptContent(row.content) }));
    return (q ? rows.filter((row) => row.content.toLowerCase().includes(q)) : rows).slice(0, safeLimit);
  }

  get(id) {
    const row = this.db.prepare('SELECT id, content, created_at FROM clipboard_items WHERE id = ?').get(String(id));
    return row ? { ...row, content: this.decryptContent(row.content) } : undefined;
  }
  remove(id) { this.db.prepare('DELETE FROM clipboard_items WHERE id = ?').run(String(id)); }
  clear() { this.db.exec('DELETE FROM clipboard_items'); }

  prune({ retentionDays = this.retentionDays, maxItems = this.maxItems } = {}) {
    const cutoff = Date.now() - Math.max(1, Number(retentionDays) || 7) * 86_400_000;
    this.db.prepare('DELETE FROM clipboard_items WHERE created_at < ?').run(cutoff);
    this.db.prepare(`DELETE FROM clipboard_items WHERE id IN (
      SELECT id FROM clipboard_items ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(Math.max(1, Number(maxItems) || 200));
  }

  close() { try { this.db.close(); } catch (_) { /* already closed */ } }
}

module.exports = { ClipboardStore };
