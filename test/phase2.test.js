'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/core/settingsStore');
const { ClipboardStore } = require('../src/core/clipboardStore');
const { CalendarStore } = require('../src/core/calendarStore');
const { parseCalendar } = require('../src/core/icsParser');
const { CalendarManager, assertPublicHttpsUrl, isPrivateAddress, readLimitedText } = require('../src/integrations/calendar/calendarManager');
const { ClipboardWatcher } = require('../src/integrations/clipboard/clipboardWatcher');
const { MediaManager } = require('../src/integrations/media/mediaManager');

async function run() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-phase2-'));

try {
  // Schema migration preserves the v1.1 settings while introducing UI modes and integrations.
  const configPath = path.join(temp, 'settings.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, appearance: { theme: 'aurora' }, general: { autoHideSeconds: 45 } }));
  const settings = new SettingsStore(configPath);
  let value = settings.get();
  assert.equal(value.appearance.theme, 'aurora');
  assert.equal(value.general.autoHideSeconds, 45);
  assert.equal(value.appearance.uiMode, 'system');
  settings.update({ appearance: { theme: 'glass', uiMode: 'light' }, integrations: {
    media: { enabled: true }, clipboard: { enabled: true, maxItems: 25 }, calendar: { reminderMinutes: 20 },
  } });
  value = settings.get();
  assert.equal(value.appearance.theme, 'glass');
  assert.equal(value.appearance.uiMode, 'light');
  assert.equal(value.integrations.media.enabled, true);
  assert.equal(value.integrations.clipboard.maxItems, 25);
  assert.equal(value.integrations.calendar.reminderMinutes, 20);

  // Clipboard store: duplicate suppression, copy retrieval, retention/count caps and deletion.
  const clipboardDb = new ClipboardStore(path.join(temp, 'clipboard.db'), { maxItems: 3, retentionDays: 7 });
  assert.equal(clipboardDb.record('existing clipboard text').content, 'existing clipboard text');
  assert.equal(clipboardDb.record('existing clipboard text'), null);
  clipboardDb.record('second text');
  const third = clipboardDb.record('third text');
  clipboardDb.record('fourth text');
  assert.equal(clipboardDb.list({ limit: 100 }).length, 3);
  assert.equal(clipboardDb.get(third.id).content, 'third text');
  clipboardDb.remove(third.id);
  assert.equal(clipboardDb.get(third.id), undefined);
  clipboardDb.clear();
  assert.equal(clipboardDb.list().length, 0);
  const encryptedDb = new ClipboardStore(path.join(temp, 'clipboard-encrypted.db'), {
    encryptContent: (content) => `ENC:${Buffer.from(content).toString('base64')}`,
    decryptContent: (content) => content.startsWith('ENC:') ? Buffer.from(content.slice(4), 'base64').toString('utf8') : content,
  });
  encryptedDb.record('private clipboard secret');
  const rawStoredClipboard = encryptedDb.db.prepare('SELECT content FROM clipboard_items LIMIT 1').get().content;
  assert.equal(rawStoredClipboard.includes('private clipboard secret'), false, 'clipboard text should be encrypted at rest when a secure codec is provided');
  assert.equal(encryptedDb.list()[0].content, 'private clipboard secret');
  encryptedDb.close();

  // Clipboard watcher seeds the current clipboard and only stores future changes.
  let clipboardValue = 'pre-existing';
  const watcherStore = new ClipboardStore(path.join(temp, 'watcher.db'));
  const watcher = new ClipboardWatcher({ readText: async () => clipboardValue, store: watcherStore, intervalMs: 5000 });
  await watcher.setEnabled(true);
  assert.equal(watcherStore.list().length, 0, 'existing clipboard text must not be recorded at opt-in');
  clipboardValue = 'new copied text';
  await watcher.tick();
  assert.equal(watcherStore.list()[0].content, 'new copied text');
  await watcher.tick();
  assert.equal(watcherStore.list().length, 1, 'unchanged clipboard should not create duplicates');
  watcher.stop();
  watcherStore.close();

  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:team-meeting-1\r\nDTSTART:20261201T030000Z\r\nDTEND:20261201T033000Z\r\nSUMMARY:Team\\, planning\r\nDESCRIPTION:Roadmap\\nReview\r\nLOCATION:Room 4\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:all-day-1\r\nDTSTART;VALUE=DATE:20261202\r\nSUMMARY:Company day\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const parsed = parseCalendar(ics, { now: Date.UTC(2026, 10, 30), daysAhead: 5 });
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].summary, 'Team, planning');
  assert.equal(parsed.events[0].description, 'Roadmap\nReview');
  assert.equal(parsed.events[0].location, 'Room 4');
  assert.equal(parsed.events[1].allDay, true);

  const recurring = parseCalendar(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:recurring\nDTSTART:20261201T100000Z\nRRULE:FREQ=WEEKLY;COUNT=4\nSUMMARY:Weekly\nEND:VEVENT\nEND:VCALENDAR`, { now: Date.UTC(2026, 10, 30), daysAhead: 24 });
  assert.equal(recurring.events.length, 4, 'simple weekly recurrence should expand upcoming occurrences');
  assert.equal(new Set(recurring.events.map((event) => event.uid)).size, 4, 'each generated recurrence should have a distinct local key');
  assert.equal(recurring.recurringSkipped, 0);
  const daily = parseCalendar(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:daily\nDTSTART;TZID=Asia/Jakarta:20261201T100000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Daily standup\nEND:VEVENT\nEND:VCALENDAR`, { now: Date.UTC(2026, 10, 30), daysAhead: 4 });
  assert.equal(daily.events.length, 3);
  assert.equal(new Date(daily.events[0].startAt).toISOString(), '2026-12-01T03:00:00.000Z', 'TZID values must convert to the represented UTC instant');

  assert.equal(assertPublicHttpsUrl('https://calendar.example.com/feed.ics'), 'https://calendar.example.com/feed.ics');
  assert.throws(() => assertPublicHttpsUrl('http://calendar.example.com/feed.ics'), /HTTPS/);
  assert.throws(() => assertPublicHttpsUrl('https://localhost/feed.ics'), /public HTTPS/);
  assert.throws(() => assertPublicHttpsUrl('https://user:pass@calendar.example.com/feed.ics'), /Credentials/);
  assert.equal(isPrivateAddress('192.168.1.10'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  await assert.rejects(() => readLimitedText({ headers: { get: () => '12' }, text: async () => 'too long' }, 5), /1.5 MB/);

  // Calendar store and reminder de-duplication.
  const calendarDb = new CalendarStore(path.join(temp, 'calendar.db'));
  const source = calendarDb.addSource('https://calendar.example.com/feed.ics', 'Work');
  const event = { uid: 'meeting', summary: 'Planning', description: '', location: '', startAt: Date.now() + 5 * 60_000, endAt: Date.now() + 35 * 60_000, allDay: false };
  calendarDb.replaceEvents(source.id, [event]);
  const saved = calendarDb.listEvents({ from: Date.now(), to: Date.now() + 60 * 60_000 })[0];
  assert.equal(saved.summary, 'Planning');
  assert.equal(calendarDb.claimReminder(saved, 10, saved.startAt - 5 * 60_000), true);
  assert.equal(calendarDb.claimReminder(saved, 10, saved.startAt - 4 * 60_000), false);
  calendarDb.removeSource(source.id);
  assert.equal(calendarDb.getSources().length, 0);
  assert.equal(calendarDb.listEvents().length, 0);

  // Manager rejects unsafe feeds before making any network request.
  const feedIcs = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:feed-event\nDTSTART:20261201T090000Z\nDTEND:20261201T093000Z\nSUMMARY:Feed event\nEND:VEVENT\nEND:VCALENDAR`;
  const manager = new CalendarManager(calendarDb, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => feedIcs }),
    resolveHost: async () => {},
    encryptUrl: (url) => `ENC:${Buffer.from(url).toString('base64')}`,
    decryptUrl: (value) => value.startsWith('ENC:') ? Buffer.from(value.slice(4), 'base64').toString('utf8') : value,
  });
  assert.throws(() => manager.addFeed('http://127.0.0.1/calendar.ics'), /HTTPS/);
  const addedFeed = manager.addFeed('https://calendar.example.com/private.ics?token=secret');
  assert.equal(addedFeed.displayUrl, 'https://calendar.example.com/…');
  assert.equal(JSON.stringify(manager.getData()).includes('token=secret'), false, 'private feed URL must not be exposed in UI data');
  assert.throws(() => manager.addFeed('https://calendar.example.com/private.ics?token=secret'), /already added/);
  assert.equal(manager.getData().sources.length, 1);
  const refreshResult = await manager.refreshAll();
  assert.equal(refreshResult.results[0].eventCount, 1);
  assert.equal(manager.getData().events[0].summary, 'Feed event');
  manager.removeFeed(addedFeed.id);
  manager.stop();
  calendarDb.close();
  clipboardDb.close();

  // On non-Windows platforms the media manager explains the limitation without spawning a process.
  if (process.platform !== 'win32') {
    const media = new MediaManager({ appPath: temp, resourcesPath: temp, logger: () => {} });
    const status = media.setEnabled(true);
    assert.equal(status.enabled, true);
    assert.equal(status.available, false);
    assert.match(status.message, /only on Windows/);
    media.stop();
  }

  // Media bridge protocol: it starts only when the optional helper exists, then exposes
  // session snapshots and forwards a narrow allowlist of playback commands.
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const helperDir = path.join(temp, 'resources', 'media-bridge');
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(path.join(helperDir, 'Desknotch.MediaBridge.exe'), 'test-helper');
  class FakeChild extends EventEmitter {
    constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.killed = false; }
    kill() { this.killed = true; this.emit('exit', 0); }
  }
  const child = new FakeChild();
  const commands = [];
  child.stdin.on('data', (chunk) => commands.push(...String(chunk).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  const media = new MediaManager({ appPath: temp, isPackaged: false, platform: 'win32', spawnImpl: () => child });
  const mediaStatus = media.setEnabled(true);
  assert.equal(mediaStatus.available, true);
  child.stdout.write('{"type":"ready","message":"ok"}\n');
  assert.equal(commands[0].action, 'snapshot');
  child.stdout.write('{"type":"snapshot","data":{"title":"Test song","artist":"Test artist","isPlaying":true}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.getStatus().session.title, 'Test song');
  media.command('next');
  assert.equal(commands.at(-1).action, 'next');
  assert.throws(() => media.command('delete'), /Unsupported/);
  media.stop();
  assert.equal(child.killed, true);

  const manifestHook = require('../scripts/injectGlobalMediaCapability');
  const appxXml = '<Package xmlns=\"urn:test\"><Capabilities><Capability Name=\"internetClient\" /></Capabilities></Package>';
  const patchedXml = manifestHook.patchManifestText(appxXml);
  assert.match(patchedXml, /xmlns:uap7=\"http:\/\/schemas.microsoft.com\/appx\/manifest\/uap\/windows10\/7\"/);
  assert.match(patchedXml, /IgnorableNamespaces=\"uap7\"/);
  assert.match(patchedXml, /<uap7:Capability Name=\"globalMediaControl\" \/>/);
  assert.equal(manifestHook.patchManifestText(patchedXml), patchedXml, 'AppX capability injection should be idempotent');

  console.log('Phase 2 integrations: settings migration, encrypted clipboard, calendar feeds/reminders, media bridge protocol and security tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
