'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

class MediaManager extends EventEmitter {
  constructor({ appPath, resourcesPath, isPackaged = false, logger = () => {}, spawnImpl = spawn, platform = process.platform } = {}) {
    super();
    this.appPath = appPath;
    this.resourcesPath = resourcesPath;
    this.isPackaged = isPackaged;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.child = null;
    this.rl = null;
    this.pollTimer = null;
    this.ready = false;
    this.lastSnapshot = null;
    this.bridgeReportedError = false;
    this.status = { enabled: false, available: false, connected: false, message: 'Media integration is disabled.' };
  }

  helperPath() {
    return this.isPackaged
      ? path.join(this.resourcesPath, 'media-bridge', 'Desknotch.MediaBridge.exe')
      : path.join(this.appPath, 'resources', 'media-bridge', 'Desknotch.MediaBridge.exe');
  }

  getStatus() { return { ...this.status, session: this.lastSnapshot }; }

  setEnabled(enabled) {
    if (!enabled) {
      this.stop();
      this.status = { enabled: false, available: fs.existsSync(this.helperPath()), connected: false, message: 'Media integration is disabled.' };
      this.emit('changed', this.getStatus());
      return this.getStatus();
    }
    if (this.child) return this.getStatus();
    const exe = this.helperPath();
    if (this.platform !== 'win32') {
      this.status = { enabled: true, available: false, connected: false, message: 'System media sessions are available only on Windows.' };
      this.emit('changed', this.getStatus());
      return this.getStatus();
    }
    if (!fs.existsSync(exe)) {
      this.status = { enabled: true, available: false, connected: false, message: 'The Windows media bridge has not been built. Run npm run build:media-bridge on Windows with the .NET 9 SDK.' };
      this.emit('changed', this.getStatus());
      return this.getStatus();
    }

    try {
      this.bridgeReportedError = false;
      this.child = this.spawnImpl(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.rl = readline.createInterface({ input: this.child.stdout });
      this.rl.on('line', (line) => this.handleLine(line));
      this.child.stderr.on('data', (chunk) => this.logger('media bridge stderr', { message: String(chunk).slice(0, 1000) }));
      this.child.on('error', (error) => this.fail(error));
      this.child.on('exit', (code) => {
        this.ready = false;
        this.child = null;
        if (this.status.enabled && !this.bridgeReportedError) this.fail(new Error(`Media bridge exited (${code}).`));
      });
      this.status = { enabled: true, available: true, connected: false, message: 'Starting Windows media bridge…' };
      this.emit('changed', this.getStatus());
      return this.getStatus();
    } catch (error) {
      this.fail(error);
      return this.getStatus();
    }
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch (_) { this.logger('media bridge emitted invalid JSON', { line: line.slice(0, 400) }); return; }
    if (message.type === 'ready') {
      this.ready = true;
      this.status = { enabled: true, available: true, connected: true, message: message.message || 'Connected to Windows media sessions.' };
      this.emit('changed', this.getStatus());
      this.requestSnapshot();
      this.pollTimer = setInterval(() => this.requestSnapshot(), 2500);
    } else if (message.type === 'snapshot') {
      this.lastSnapshot = message.data || null;
      this.status = { ...this.status, connected: true, message: this.lastSnapshot?.title ? 'Media session connected.' : 'Waiting for a media session.' };
      this.emit('changed', this.getStatus());
    } else if (message.type === 'error') {
      this.bridgeReportedError = true;
      this.status = { enabled: true, available: true, connected: false, message: String(message.message || 'Windows denied access to media sessions.') };
      this.logger('media bridge reported an error', { message: this.status.message });
      this.emit('changed', this.getStatus());
    }
  }

  requestSnapshot() { this.write({ action: 'snapshot' }); }
  command(action) {
    if (!['playPause', 'next', 'previous'].includes(action)) throw new TypeError('Unsupported media action.');
    this.write({ action });
  }
  write(payload) {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  fail(error) {
    this.status = { enabled: this.status.enabled, available: !!this.child, connected: false, message: error?.message || String(error) };
    this.logger('media bridge unavailable', { message: this.status.message });
    this.emit('changed', this.getStatus());
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.ready = false;
    if (this.child) {
      try { this.write({ action: 'quit' }); } catch (_) { /* process may already be gone */ }
      try { this.child.kill(); } catch (_) { /* process may already be gone */ }
    }
    this.child = null;
    this.rl?.close();
    this.rl = null;
    this.lastSnapshot = null;
  }
}

module.exports = { MediaManager };
