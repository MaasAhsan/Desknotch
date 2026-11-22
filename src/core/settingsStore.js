'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 2,
  general: {
    launchAtLogin: false,
    idlePill: true,
    notificationsEnabled: true,
    autoHideSeconds: 30,
  },
  appearance: {
    theme: 'midnight',
    uiMode: 'system',
    accentColor: '#8b9cff',
    hoverOpacity: 0.5,
    animationScale: 1,
    islandWidth: 440,
  },
  notifications: {
    storeHistory: true,
    retentionDays: 30,
    defaultDurationSeconds: 7,
  },
  focus: {
    enabled: false,
    allowPriority: true,
    schedule: {
      enabled: false,
      start: '22:00',
      end: '07:00',
    },
  },
  display: {
    displayId: null,
    horizontalOffset: 0,
    topOffset: 10,
  },
  apps: {},
  appCatalog: {},
  integrations: {
    media: { enabled: false, showOnIsland: true },
    clipboard: { enabled: false, showOnIsland: false, retentionDays: 7, maxItems: 200 },
    calendar: { remindersEnabled: true, reminderMinutes: 10, refreshMinutes: 15 },
  },
});

const THEMES = new Set(['midnight', 'graphite', 'arctic', 'aurora', 'custom', 'glass']);
const UI_MODES = new Set(['system', 'light', 'dark']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : fallback;

function sanitizeRule(rule = {}) {
  return {
    enabled: rule.enabled !== false,
    priority: rule.priority === true,
    durationSeconds: rule.durationSeconds == null || rule.durationSeconds === ''
      ? null : Math.round(clamp(rule.durationSeconds, 3, 30)),
  };
}

function mergeSettings(current, patch) {
  if (!isObject(patch)) throw new TypeError('Settings update must be an object');
  const next = clone(current);

  if (isObject(patch.general)) {
    if (typeof patch.general.launchAtLogin === 'boolean') next.general.launchAtLogin = patch.general.launchAtLogin;
    if (typeof patch.general.idlePill === 'boolean') next.general.idlePill = patch.general.idlePill;
    if (typeof patch.general.notificationsEnabled === 'boolean') next.general.notificationsEnabled = patch.general.notificationsEnabled;
    if (patch.general.autoHideSeconds !== undefined) next.general.autoHideSeconds = Math.round(clamp(patch.general.autoHideSeconds, 0, 300));
  }

  if (isObject(patch.appearance)) {
    if (THEMES.has(patch.appearance.theme)) next.appearance.theme = patch.appearance.theme;
    if (UI_MODES.has(patch.appearance.uiMode)) next.appearance.uiMode = patch.appearance.uiMode;
    if (typeof patch.appearance.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(patch.appearance.accentColor)) {
      next.appearance.accentColor = patch.appearance.accentColor;
    }
    if (patch.appearance.hoverOpacity !== undefined) next.appearance.hoverOpacity = clamp(patch.appearance.hoverOpacity, 0.2, 1);
    if (patch.appearance.animationScale !== undefined) next.appearance.animationScale = clamp(patch.appearance.animationScale, 0.25, 2);
    if (patch.appearance.islandWidth !== undefined) next.appearance.islandWidth = Math.round(clamp(patch.appearance.islandWidth, 360, 500));
  }

  if (isObject(patch.notifications)) {
    if (typeof patch.notifications.storeHistory === 'boolean') next.notifications.storeHistory = patch.notifications.storeHistory;
    if (patch.notifications.retentionDays !== undefined) next.notifications.retentionDays = Math.round(clamp(patch.notifications.retentionDays, 1, 365));
    if (patch.notifications.defaultDurationSeconds !== undefined) next.notifications.defaultDurationSeconds = Math.round(clamp(patch.notifications.defaultDurationSeconds, 3, 30));
  }

  if (isObject(patch.focus)) {
    if (typeof patch.focus.enabled === 'boolean') next.focus.enabled = patch.focus.enabled;
    if (typeof patch.focus.allowPriority === 'boolean') next.focus.allowPriority = patch.focus.allowPriority;
    if (isObject(patch.focus.schedule)) {
      if (typeof patch.focus.schedule.enabled === 'boolean') next.focus.schedule.enabled = patch.focus.schedule.enabled;
      next.focus.schedule.start = validTime(patch.focus.schedule.start, next.focus.schedule.start);
      next.focus.schedule.end = validTime(patch.focus.schedule.end, next.focus.schedule.end);
    }
  }

  if (isObject(patch.display)) {
    if (patch.display.displayId === null || typeof patch.display.displayId === 'string' || typeof patch.display.displayId === 'number') {
      next.display.displayId = patch.display.displayId === null ? null : String(patch.display.displayId);
    }
    if (patch.display.horizontalOffset !== undefined) next.display.horizontalOffset = Math.round(clamp(patch.display.horizontalOffset, -500, 500));
    if (patch.display.topOffset !== undefined) next.display.topOffset = Math.round(clamp(patch.display.topOffset, 0, 200));
  }

  if (isObject(patch.apps)) {
    for (const [appId, rule] of Object.entries(patch.apps)) {
      if (!appId || appId.length > 256 || !isObject(rule)) continue;
      next.apps[appId] = sanitizeRule({ ...next.apps[appId], ...rule });
    }
  }

  if (isObject(patch.appCatalog)) {
    for (const [appId, appName] of Object.entries(patch.appCatalog)) {
      if (!appId || appId.length > 256 || typeof appName !== 'string') continue;
      next.appCatalog[appId] = appName.trim().slice(0, 80) || 'Notification';
    }
  }

  if (isObject(patch.integrations)) {
    for (const key of ['media', 'clipboard', 'calendar']) {
      if (!isObject(patch.integrations[key])) continue;
      const value = patch.integrations[key];
      if (key === 'media') {
        if (typeof value.enabled === 'boolean') next.integrations.media.enabled = value.enabled;
        if (typeof value.showOnIsland === 'boolean') next.integrations.media.showOnIsland = value.showOnIsland;
      } else if (key === 'clipboard') {
        if (typeof value.enabled === 'boolean') next.integrations.clipboard.enabled = value.enabled;
        if (typeof value.showOnIsland === 'boolean') next.integrations.clipboard.showOnIsland = value.showOnIsland;
        if (value.retentionDays !== undefined) next.integrations.clipboard.retentionDays = Math.round(clamp(value.retentionDays, 1, 90));
        if (value.maxItems !== undefined) next.integrations.clipboard.maxItems = Math.round(clamp(value.maxItems, 20, 1000));
      } else {
        if (typeof value.remindersEnabled === 'boolean') next.integrations.calendar.remindersEnabled = value.remindersEnabled;
        if (value.reminderMinutes !== undefined) next.integrations.calendar.reminderMinutes = Math.round(clamp(value.reminderMinutes, 1, 120));
        if (value.refreshMinutes !== undefined) next.integrations.calendar.refreshMinutes = Math.round(clamp(value.refreshMinutes, 5, 120));
      }
    }
  }

  next.schemaVersion = 2;
  return next;
}

class SettingsStore {
  constructor(filePath, { logger = () => {} } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.value = clone(DEFAULT_SETTINGS);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.value = mergeSettings(this.value, parsed);
      }
    } catch (error) {
      this.logger('settings load failed; defaults restored', { error: error.message });
      try {
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        fs.renameSync(this.filePath, backupPath);
        this.logger('corrupt settings moved aside', { backupPath });
      } catch (_) { /* The defaults can still be used if the file cannot be moved. */ }
      this.value = clone(DEFAULT_SETTINGS);
    }
    return this.get();
  }

  get() { return clone(this.value); }

  update(patch) {
    const next = mergeSettings(this.value, patch);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    this.value = next;
    return this.get();
  }

  rememberApp(appId, appName) {
    if (typeof appId !== 'string' || !appId.trim() || appId.length > 256) return false;
    const name = String(appName || 'Notification').trim().slice(0, 80) || 'Notification';
    if (this.value.appCatalog[appId] === name) return false;
    this.update({ appCatalog: { [appId]: name } });
    return true;
  }

  updateAppRule(appId, rule) {
    if (typeof appId !== 'string' || !appId.trim() || appId.length > 256) throw new TypeError('Invalid application identifier');
    return this.update({ apps: { [appId]: sanitizeRule({ ...this.value.apps[appId], ...rule }) } });
  }
}

module.exports = { SettingsStore, DEFAULT_SETTINGS, mergeSettings, sanitizeRule };
