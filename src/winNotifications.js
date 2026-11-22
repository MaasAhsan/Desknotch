'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function decode(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  const b = Buffer.from(p);
  // wpndatabase's PayloadType=Xml payloads are normally UTF-8. Keep a
  // UTF-16LE fallback for schema/build variants that store wide strings.
  const s = b.length > 1 && b[1] === 0 ? b.toString('utf16le') : b.toString('utf8');
  return s.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseToast(xml) {
  const texts = [...String(xml).matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => unescapeXml(m[1].trim()))
    .filter(Boolean);
  return { title: texts[0] || '', body: texts.slice(1, 3).join(' · ') };
}

function prettyApp(id) {
  if (!id) return 'Notification';
  let s = String(id);
  if (/[\\/]/.test(s)) s = path.win32.basename(s).replace(/\.exe$/i, '');
  s = s.split('!')[0].split('_')[0];
  const parts = s.split('.');
  return parts[parts.length - 1] || s;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
}

function inspectDatabase(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  if (!tables.has('Notification')) throw new Error('wpndatabase.db has no Notification table');

  const notification = tableColumns(db, 'Notification');
  const handler = tables.has('NotificationHandler') ? tableColumns(db, 'NotificationHandler') : new Set();
  for (const required of ['Type', 'Payload']) {
    if (!notification.has(required)) throw new Error(`Notification table is missing required column: ${required}`);
  }

  // `Order` is the SQLite insertion sequence. `Id` is a unique notification
  // identifier with ON CONFLICT REPLACE and is not a safe incremental cursor.
  const sequence = notification.has('Order') ? 'n."Order"' : 'n.rowid';
  const maxSequence = notification.has('Order') ? '"Order"' : 'rowid';
  const hasHandlerJoin = notification.has('HandlerId') && handler.has('RecordId') && handler.has('PrimaryId');
  const appExpr = hasHandlerJoin ? 'h.PrimaryId' : 'NULL';
  const join = hasHandlerJoin ? 'LEFT JOIN NotificationHandler h ON n.HandlerId = h.RecordId' : '';
  const idExpr = notification.has('Id') ? 'n.Id' : 'NULL';
  const payloadTypeExpr = notification.has('PayloadType') ? 'n.PayloadType' : 'NULL';

  return {
    tables: [...tables],
    notificationColumns: [...notification],
    handlerColumns: [...handler],
    sequenceColumn: notification.has('Order') ? 'Order' : 'rowid fallback',
    hasHandlerJoin,
    maxOrder(db) {
      return Number(db.prepare(`SELECT COALESCE(MAX(${maxSequence}), 0) AS m FROM Notification`).get().m || 0);
    },
    stats(db) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM Notification').get().n;
      const types = db.prepare("SELECT COALESCE(CAST(Type AS TEXT), '<NULL>') AS value, COUNT(*) AS count FROM Notification GROUP BY Type").all();
      const payloadTypes = notification.has('PayloadType')
        ? db.prepare("SELECT COALESCE(CAST(PayloadType AS TEXT), '<NULL>') AS value, COUNT(*) AS count FROM Notification GROUP BY PayloadType").all()
        : [];
      return { total, types, payloadTypes };
    },
    rowsAfter(db, cursor) {
      return db.prepare(
        `SELECT ${sequence} AS seq, ${idExpr} AS id, n.Type AS type, n.Payload AS payload,
                ${payloadTypeExpr} AS payloadType, ${appExpr} AS app
         FROM Notification n ${join}
         WHERE ${sequence} > ? ORDER BY ${sequence}`
      ).all(cursor);
    },
  };
}

function rawPayloadForLog(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  const bytes = Buffer.from(payload);
  return { utf8: decode(bytes), base64: bytes.toString('base64') };
}

class WinNotificationWatcher extends EventEmitter {
  constructor({ intervalMs = 1200, dbPath, logger = () => {}, allowNonWindows = false } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.dbPathOverride = dbPath;
    this.log = logger;
    this.allowNonWindows = allowNonWindows;
    this.timer = null;
    this.lastOrder = 0;
    this.errored = false;
    this.initialized = false;
    this.missingDbReported = false;
    this.schema = null;
    this.sqlite = null;
  }

  get dbPath() {
    return this.dbPathOverride || path.join(
      process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db'
    );
  }

  _withDb(fn) {
    // Read the live database in SQLite read-only mode. Copying .db, -wal and
    // -shm independently can create an inconsistent snapshot while Windows
    // is writing a toast. SQLite itself provides a consistent WAL read view.
    const db = new this.sqlite.DatabaseSync(this.dbPath, { readOnly: true, timeout: 1000 });
    try { return fn(db); } finally { db.close(); }
  }

  start() {
    if (process.platform !== 'win32' && !this.allowNonWindows) {
      this.emit('unsupported', 'Reading system notifications is only implemented for Windows. The test button and local endpoint still work.');
      return;
    }
    try {
      this.sqlite = require('node:sqlite');
      this.log('node:sqlite loaded', { node: process.versions.node, electron: process.versions.electron || null });
    } catch (e) {
      this.emit('unsupported', `This Electron build has no usable node:sqlite: ${e.message}`);
      return;
    }

    // Retry database initialization if Windows is temporarily holding the file
    // or the database has not been created yet.
    this._initialize();
    this.timer = setInterval(() => {
      if (this.initialized) this._tick();
      else this._initialize();
    }, this.intervalMs);
  }

  _initialize() {
    if (!fs.existsSync(this.dbPath)) {
      if (!this.missingDbReported) {
        this.missingDbReported = true;
        this.log('notification database not found yet', { path: this.dbPath });
        this.emit('unsupported', `Windows notification database not found: ${this.dbPath}`);
      }
      return false;
    }
    try {
      this._withDb((db) => {
        this.schema = inspectDatabase(db);
        this.lastOrder = this.schema.maxOrder(db);
        this.log('notification database opened read-only', {
          path: this.dbPath,
          sequenceColumn: this.schema.sequenceColumn,
          hasHandlerJoin: this.schema.hasHandlerJoin,
          tables: this.schema.tables,
          notificationColumns: this.schema.notificationColumns,
          handlerColumns: this.schema.handlerColumns,
          cursorAtStartup: this.lastOrder,
          stats: this.schema.stats(db),
        });
      });
      this.initialized = true;
      this.errored = false;
      this.missingDbReported = false;
      this.emit('ready');
      return true;
    } catch (e) {
      this.log('notification database startup failed', { path: this.dbPath, error: e.stack || e.message });
      if (!this.errored) this.emit('error', e);
      this.errored = true;
      return false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _tick() {
    if (!this.initialized) return this._initialize();
    try {
      const result = this._withDb((db) => {
        const schema = inspectDatabase(db);
        const maxOrder = schema.maxOrder(db);
        const stats = maxOrder !== this.lastOrder ? schema.stats(db) : null;
        if (maxOrder < this.lastOrder) {
          this.log('notification sequence moved backwards; resetting cursor', { previous: this.lastOrder, current: maxOrder });
          this.lastOrder = 0;
        }
        const rows = schema.rowsAfter(db, this.lastOrder);
        return { rows, maxOrder, stats, schema };
      });

      this.schema = result.schema;
      if (result.stats) this.log('notification database changed', { maxOrder: result.maxOrder, stats: result.stats });
      for (const row of result.rows) {
        this.lastOrder = Number(row.seq);
        const payload = decode(row.payload);
        this.log('new notification database row', {
          order: row.seq,
          id: row.id,
          type: row.type,
          payloadType: row.payloadType,
          handlerPrimaryId: row.app,
          rawPayload: rawPayloadForLog(row.payload),
        });

        if (String(row.type || '').toLowerCase() !== 'toast') continue;
        if (row.payloadType && String(row.payloadType).toLowerCase() !== 'xml') {
          this.log('skipping non-XML toast payload', { order: row.seq, payloadType: row.payloadType });
          continue;
        }
        const { title, body } = parseToast(payload);
        if (!title && !body) {
          this.log('toast row had no parseable <text> nodes', { order: row.seq, decodedPayload: payload });
          continue;
        }
        this.emit('notification', {
          id: `windows:${row.seq}:${row.id ?? 'unknown'}`,
          source: 'windows',
          appId: String(row.app || 'unknown'),
          app: prettyApp(row.app),
          title,
          body,
          receivedAt: Date.now(),
        });
      }
      this.errored = false;
    } catch (e) {
      if (!this.errored) {
        this.errored = true;
        this.log('notification polling failed', { path: this.dbPath, error: e.stack || e.message });
        this.emit('error', e);
      }
    }
  }
}

module.exports = {
  WinNotificationWatcher,
  parseToast,
  prettyApp,
  decode,
  inspectDatabase,
  rawPayloadForLog,
};
