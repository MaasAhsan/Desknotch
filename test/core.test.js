'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore, DEFAULT_SETTINGS, mergeSettings } = require('../src/core/settingsStore');
const { HistoryStore } = require('../src/core/historyStore');
const { minutesOfDay, isScheduleActive, isFocusActive, evaluateNotification } = require('../src/core/notificationPolicy');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-core-test-'));
try {
  // Settings defaults, validation, persistence and nested merges.
  const settingsPath = path.join(root, 'nested', 'settings.json');
  const store = new SettingsStore(settingsPath);
  assert.deepEqual(store.get(), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  let value = store.update({ general: { autoHideSeconds: 45 }, appearance: { theme: 'aurora', hoverOpacity: 0.65 } });
  assert.equal(value.general.autoHideSeconds, 45);
  assert.equal(value.general.idlePill, true, 'partial settings updates must preserve neighboring defaults');
  assert.equal(value.appearance.theme, 'aurora');
  assert.equal(value.appearance.hoverOpacity, 0.65);
  value = store.update({ appearance: { theme: 'not-a-theme', hoverOpacity: 5, accentColor: 'red' }, general: { autoHideSeconds: 999 } });
  assert.equal(value.appearance.theme, 'aurora', 'invalid theme should be ignored');
  assert.equal(value.appearance.hoverOpacity, 1, 'appearance values must be clamped');
  assert.equal(value.appearance.accentColor, DEFAULT_SETTINGS.appearance.accentColor, 'invalid colors should be ignored');
  assert.equal(value.general.autoHideSeconds, 300, 'auto-hide value must be clamped');
  assert.equal(store.rememberApp('Example.App!App', 'Example App'), true, 'app catalog should persist even when notification history is disabled');
  assert.equal(store.rememberApp('Example.App!App', 'Example App'), false, 'unchanged app names should not rewrite the catalog');
  store.updateAppRule('Example.App!App', { enabled: false, priority: true, durationSeconds: 11 });
  assert.deepEqual(store.get().apps['Example.App!App'], { enabled: false, priority: true, durationSeconds: 11 });
  const reloaded = new SettingsStore(settingsPath);
  assert.equal(reloaded.get().apps['Example.App!App'].enabled, false, 'settings must survive a reload');
  assert.equal(reloaded.get().appCatalog['Example.App!App'], 'Example App', 'detected apps should remain available for rules when history storage is off');
  assert.throws(() => mergeSettings(reloaded.get(), null), /object/);

  // Local notification history and privacy controls are exercised in the main process.
  const history = new HistoryStore(path.join(root, 'history.db'), { retentionDays: 30 });
  const baseTime = Date.now();
  history.record({ id: 'n1', appId: 'app.one', app: 'One', title: 'Hello', body: 'First message', receivedAt: baseTime, source: 'windows' }, { status: 'shown' });
  history.record({ id: 'n2', appId: 'app.two', app: 'Two', title: 'Meeting', body: 'Project review', receivedAt: baseTime + 1000, source: 'windows', }, { status: 'focus-muted', priority: false });
  assert.equal(history.list({ limit: 10 }).length, 2);
  assert.equal(history.list({ query: 'project' }).length, 1);
  assert.equal(history.list({ query: 'app.one' }).length, 1);
  assert.equal(history.get('n1').app_name, 'One', 'history entries should be retrievable for replay');
  assert.equal(history.apps().length, 2);
  history.prune(1);
  history.db.prepare('UPDATE notifications SET received_at = ? WHERE id = ?').run(Date.now() - 3 * 86400000, 'n1');
  history.prune(1);
  assert.equal(history.list({ limit: 10 }).length, 1, 'retention pruning should remove expired entries');
  history.clear();
  assert.equal(history.list().length, 0);
  history.close();

  // Focus policy, schedule ranges including crossing midnight, app blocks, priority bypass.
  assert.equal(minutesOfDay('23:30'), 1410);
  assert.equal(minutesOfDay('25:00'), null);
  assert.equal(isScheduleActive({ enabled: true, start: '22:00', end: '07:00' }, new Date('2026-11-22T23:00:00')) , true);
  assert.equal(isScheduleActive({ enabled: true, start: '22:00', end: '07:00' }, new Date('2026-11-22T06:30:00')) , true);
  assert.equal(isScheduleActive({ enabled: true, start: '22:00', end: '07:00' }, new Date('2026-11-22T12:00:00')) , false);
  const notification = { appId: 'important.app', app: 'Important' };
  const baseSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  baseSettings.focus.enabled = true;
  assert.equal(evaluateNotification(notification, baseSettings).display, false);
  baseSettings.apps['important.app'] = { enabled: true, priority: true };
  assert.equal(evaluateNotification(notification, baseSettings).display, true, 'priority apps can bypass focus when permitted');
  baseSettings.focus.allowPriority = false;
  assert.equal(evaluateNotification(notification, baseSettings).display, false, 'priority bypass can be disabled');
  baseSettings.focus.enabled = false;
  baseSettings.apps['important.app'].enabled = false;
  assert.equal(evaluateNotification(notification, baseSettings).status, 'app-blocked');
  baseSettings.apps['important.app'].enabled = true;
  baseSettings.general.notificationsEnabled = false;
  assert.equal(evaluateNotification(notification, baseSettings).status, 'notifications-disabled');
  assert.equal(isFocusActive({ focus: { enabled: false, schedule: { enabled: true, start: '08:00', end: '18:00' } } }, new Date('2026-11-22T12:00:00')), true);

  console.log('settings store, history store, and notification policy tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
