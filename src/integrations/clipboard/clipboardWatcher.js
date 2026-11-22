'use strict';

const { EventEmitter } = require('node:events');

class ClipboardWatcher extends EventEmitter {
  constructor({ readText, store, logger = () => {}, intervalMs = 850 } = {}) {
    super();
    if (typeof readText !== 'function') throw new TypeError('ClipboardWatcher requires readText().');
    if (!store) throw new TypeError('ClipboardWatcher requires a ClipboardStore.');
    this.readText = readText;
    this.store = store;
    this.logger = logger;
    this.intervalMs = Math.max(400, Number(intervalMs) || 850);
    this.lastValue = null;
    this.timer = null;
    this.busy = false;
    this.enabled = false;
  }

  async setEnabled(enabled) {
    if (enabled) {
      if (this.enabled) return;
      this.enabled = true;
      try { this.lastValue = await this.readText(); }
      catch (error) { this.logger('clipboard initial read failed', { error: error.message }); }
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      this.emit('status', this.getStatus());
      return;
    }
    this.stop();
  }

  async tick() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const text = await this.readText();
      if (text !== this.lastValue) {
        this.lastValue = text;
        const item = this.store.record(text);
        if (item) {
          // Never write clipboard text to diagnostic logs.
          this.logger('clipboard item captured', { id: item.id, length: item.content.length });
          this.emit('item', item);
        }
      }
    } catch (error) {
      this.logger('clipboard polling failed', { error: error.message });
      this.emit('error', error);
    } finally {
      this.busy = false;
    }
  }

  getStatus() { return { enabled: this.enabled, intervalMs: this.intervalMs }; }

  stop() {
    this.enabled = false;
    this.lastValue = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('status', this.getStatus());
  }
}

module.exports = { ClipboardWatcher };
