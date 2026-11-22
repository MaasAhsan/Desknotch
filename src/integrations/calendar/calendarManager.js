'use strict';

const { EventEmitter } = require('node:events');
const net = require('node:net');
const dns = require('node:dns/promises');
const { parseCalendar } = require('../../core/icsParser');

function assertPublicHttpsUrl(input) {
  const value = String(input || '').trim().replace(/^webcal:/i, 'https:');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Calendar feeds must use HTTPS.');
  if (url.username || url.password) throw new Error('Credentials in calendar URLs are not supported.');
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Use a public HTTPS calendar URL.');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('Private network calendar URLs are not allowed.');
  return url.toString();
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  const lower = address.toLowerCase();
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedV4) return isPrivateAddress(mappedV4[1]);
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
}

async function assertResolvedPublicHost(hostname) {
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Calendar feed hostname resolves to a private or local network address.');
  }
}
async function readLimitedText(response, maxBytes = 1_500_000) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error('Calendar feed exceeds the 1.5 MB safety limit.');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('Calendar feed exceeds the 1.5 MB safety limit.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* stream already cancelled */ }
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Calendar feed exceeds the 1.5 MB safety limit.');
  return text;
}

class CalendarManager extends EventEmitter {
  constructor(store, { logger = () => {}, fetchImpl = globalThis.fetch, encryptUrl = (value) => value, decryptUrl = (value) => value, resolveHost = assertResolvedPublicHost } = {}) {
    super();
    this.store = store;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.encryptUrl = encryptUrl;
    this.decryptUrl = decryptUrl;
    this.resolveHost = resolveHost;
    this.timer = null;
    this.refreshing = false;
    this.warnings = [];
  }

  addFeed(url) {
    const safeUrl = assertPublicHttpsUrl(url);
    const duplicate = this.store.getSources().find((item) => {
      try { return this.decryptUrl(item.url) === safeUrl; } catch (_) { return false; }
    });
    if (duplicate) throw new Error('This calendar feed is already added.');
    const parsed = new URL(safeUrl);
    const source = this.store.addSource(this.encryptUrl(safeUrl), parsed.hostname);
    this.emit('changed', this.getData());
    return { id: source.id, name: source.name, displayUrl: `${parsed.origin}/…` };
  }

  removeFeed(id) {
    this.store.removeSource(id);
    this.emit('changed', this.getData());
  }

  getData() {
    const sources = this.store.getSources().map((source) => {
      let displayUrl = 'Private calendar feed';
      try { displayUrl = `${new URL(this.decryptUrl(source.url)).origin}/…`; } catch (_) { /* Do not expose encrypted or invalid values. */ }
      return { id: source.id, name: source.name, enabled: !!source.enabled, lastSync: source.lastSync, lastError: source.lastError, displayUrl };
    });
    return { sources, events: this.store.listEvents({}), warnings: [...this.warnings] };
  }

  async refreshSource(source) {
    try {
      const url = assertPublicHttpsUrl(this.decryptUrl(source.url));
      await this.resolveHost(new URL(url).hostname);
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'text/calendar, text/plain;q=0.9' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Calendar server returned HTTP ${response.status}.`);
      const text = await readLimitedText(response, 1_500_000);
      const parsed = parseCalendar(text);
      this.store.replaceEvents(source.id, parsed.events);
      this.logger('calendar feed refreshed', { sourceId: source.id, eventCount: parsed.events.length, recurringSkipped: parsed.recurringSkipped });
      return { sourceId: source.id, eventCount: parsed.events.length, recurringSkipped: parsed.recurringSkipped };
    } catch (error) {
      this.store.setError(source.id, error.message);
      this.logger('calendar feed refresh failed', { sourceId: source.id, error: error.message });
      return { sourceId: source.id, error: error.message };
    }
  }

  async refreshAll() {
    if (this.refreshing) return this.getData();
    this.refreshing = true;
    try {
      const results = await Promise.all(this.store.getSources().filter((source) => source.enabled).map((source) => this.refreshSource(source)));
      this.warnings = results.filter((result) => result.recurringSkipped > 0).map((result) => `${result.recurringSkipped} recurrence series skipped for calendar ${result.sourceId}`);
      this.emit('changed', this.getData());
      return { ...this.getData(), results };
    } finally {
      this.refreshing = false;
    this.warnings = [];
    }
  }

  start(refreshMinutes = 15, { refreshNow = true } = {}) {
    this.stop();
    const interval = Math.max(5, Number(refreshMinutes) || 15) * 60_000;
    if (refreshNow) this.refreshAll().catch((error) => this.logger('calendar refresh all failed', { error: error.message }));
    this.timer = setInterval(() => {
      this.refreshAll().catch((error) => this.logger('calendar scheduled refresh failed', { error: error.message }));
    }, interval);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { CalendarManager, assertPublicHttpsUrl, isPrivateAddress, assertResolvedPublicHost, readLimitedText };
