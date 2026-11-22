'use strict';

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { WinNotificationWatcher } = require('./src/winNotifications');
const { SettingsStore } = require('./src/core/settingsStore');
const { HistoryStore } = require('./src/core/historyStore');
const { evaluateNotification, isFocusActive } = require('./src/core/notificationPolicy');
const { ClipboardStore } = require('./src/core/clipboardStore');
const { CalendarStore } = require('./src/core/calendarStore');
const { ClipboardWatcher } = require('./src/integrations/clipboard/clipboardWatcher');
const { CalendarManager } = require('./src/integrations/calendar/calendarManager');
const { MediaManager } = require('./src/integrations/media/mediaManager');
const { migrateLegacyUserData } = require('./src/core/userDataMigration');
const { appendRotatingLog } = require('./src/core/rotatingLogger');

// Pin the new identity and data path before Electron resolves userData.
const APP_BRAND = 'Desknotch';
const appDataPath = app.getPath('appData');
const desknotchUserDataPath = path.join(appDataPath, APP_BRAND);
app.setName(APP_BRAND);
fs.mkdirSync(desknotchUserDataPath, { recursive: true });
app.setPath('userData', desknotchUserDataPath);
if (process.platform === 'win32') app.setAppUserModelId('com.desknotch.desktop');

const W = 520, H = 220, PORT = 47321;
let win, settingsWin, tray, watcher, server, logPath;
let settingsStore, historyStore, clipboardStore, calendarStore, clipboardWatcher, calendarManager, mediaManager;
let historyPruneTimer, calendarReminderTimer, updateCheckTimer, rendererRecoveryTimer;
let autoUpdater = null;
let updateDownloaded = false;
let shuttingDown = false;
const rendererCrashTimes = [];
let calendarRefreshMinutes = 15;
let lastMediaTrackKey = ''; 
let rendererReady = false;
let preloadReady = false;
const pendingNotifications = [];
const state = { paused: false };

function log(message, details) {
  const line = `[${new Date().toISOString()}] ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}\n`;
  try {
    if (logPath) appendRotatingLog(logPath, line, { maxBytes: 2 * 1024 * 1024, backups: 3 });
    else process.stderr.write(line);
  } catch (e) {
    process.stderr.write(`[Desknotch logger failed] ${e.message}\n${line}`);
  }
}

process.on('uncaughtException', (e) => log('uncaughtException', { error: e.stack || e.message }));
process.on('unhandledRejection', (e) => log('unhandledRejection', { error: e && (e.stack || e.message || String(e)) }));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const clip = (v, n) => String(v ?? '').slice(0, n);
  const currentSettings = () => settingsStore.get();

  function listDisplays() {
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: display.label || `Display ${index + 1}`,
      primary: display.id === screen.getPrimaryDisplay().id,
      bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
      scaleFactor: display.scaleFactor,
    }));
  }

  function listApps() {
    const catalog = currentSettings().appCatalog || {};
    const rows = new Map(historyStore.apps().map((item) => [item.appId, item]));
    for (const [appId, appName] of Object.entries(catalog)) {
      const existing = rows.get(appId);
      if (existing) existing.appName = appName || existing.appName;
      else rows.set(appId, { appId, appName, count: 0, lastSeen: 0 });
    }
    return [...rows.values()].sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
  }

  function overlayConfig() {
    return { settings: currentSettings(), displays: listDisplays() };
  }

  function sendOverlayConfig() {
    if (win && !win.isDestroyed() && rendererReady) {
      win.webContents.send('config', overlayConfig());
    }
  }

  function applySettings() {
    const settings = currentSettings();
    historyStore.retentionDays = settings.notifications.retentionDays;
    try { app.setLoginItemSettings({ openAtLogin: settings.general.launchAtLogin }); }
    catch (error) { log('login item setting failed', { error: error.message }); }
    placeWindow();
    sendOverlayConfig();
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', { ...overlayConfig(), apps: listApps() });
    if (tray) buildMenu();
    if (clipboardWatcher) {
      clipboardStore.retentionDays = settings.integrations.clipboard.retentionDays;
      clipboardStore.maxItems = settings.integrations.clipboard.maxItems;
      clipboardStore.prune(settings.integrations.clipboard);
      clipboardWatcher.setEnabled(settings.integrations.clipboard.enabled).catch((error) => log('clipboard monitor setup failed', { error: error.message }));
    }
    if (mediaManager) mediaManager.setEnabled(settings.integrations.media.enabled);
    if (calendarManager && settings.integrations.calendar.refreshMinutes !== calendarRefreshMinutes) {
      calendarRefreshMinutes = settings.integrations.calendar.refreshMinutes;
      calendarManager.start(calendarRefreshMinutes, { refreshNow: false });
    }
  }

  function placeWindow() {
    if (!win || win.isDestroyed() || !settingsStore) return;
    const settings = currentSettings();
    const displays = screen.getAllDisplays();
    const selected = displays.find((display) => String(display.id) === String(settings.display.displayId)) || screen.getPrimaryDisplay();
    const bounds = selected.bounds;
    const desiredX = Math.round(bounds.x + bounds.width / 2 - W / 2 + settings.display.horizontalOffset);
    const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - W, desiredX));
    // The BrowserWindow starts at the monitor's top edge; renderer topOffset
    // moves the visible pill within that transparent window only once.
    const y = Math.round(bounds.y);
    win.setBounds({ x, y, width: W, height: H });
  }

  function normalizeNotification(input) {
    const appName = clip(input.app || 'Notification', 80);
    const appId = clip(input.appId || appName, 256);
    return {
      id: clip(input.id || crypto.randomUUID(), 160),
      source: clip(input.source || 'local', 40),
      appId,
      app: appName,
      title: clip(input.title, 300),
      body: clip(input.body, 2000),
      receivedAt: Number(input.receivedAt) || Date.now(),
      durationMs: Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0
        ? Math.round(Math.max(2000, Math.min(30_000, Number(input.durationMs)))) : null,
      media: input.media && typeof input.media === 'object' ? {
        title: clip(input.media.title, 300), artist: clip(input.media.artist, 200), album: clip(input.media.album, 200),
        appId: clip(input.media.appId, 256), playbackStatus: clip(input.media.playbackStatus, 32),
        isPlaying: input.media.isPlaying === true, artworkBase64: clip(input.media.artworkBase64, 1_300_000),
        artworkMimeType: clip(input.media.artworkMimeType, 80),
      } : null,
    };
  }

  function push(input) {
    const notification = normalizeNotification(input || {});
    const settings = currentSettings();
    const integrationSource = ['media', 'clipboard'].includes(notification.source);
    const newApp = integrationSource ? false : settingsStore.rememberApp(notification.appId, notification.app);
    if (newApp && settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('settings:changed', { ...overlayConfig(), apps: listApps() });
    }
    const decision = evaluateNotification(notification, settings, { paused: state.paused });
    notification.priority = decision.priority;
    notification.durationMs = notification.durationMs || decision.durationMs;

    if (settings.notifications.storeHistory && !integrationSource) {
      try { historyStore.record(notification, { priority: decision.priority, status: decision.status }); }
      catch (error) { log('notification history write failed', { error: error.stack || error.message }); }
    }

    log('push notification', {
      id: notification.id,
      app: notification.app,
      appId: notification.appId,
      status: decision.status,
      display: decision.display,
      paused: state.paused,
      hasWindow: !!win,
      rendererReady,
    });
    if (!decision.display) return;

    if (!win || win.isDestroyed() || !rendererReady) {
      pendingNotifications.push(notification);
      if (pendingNotifications.length > 100) pendingNotifications.shift();
      return;
    }
    win.webContents.send('notify', notification);
  }

  function flushPending() {
    if (!rendererReady || !win || win.isDestroyed()) return;
    const count = pendingNotifications.length;
    while (pendingNotifications.length) win.webContents.send('notify', pendingNotifications.shift());
    log('notifications dispatched to renderer', { count });
  }

  function scheduleRendererRecovery(details) {
    if (shuttingDown) return;
    const now = Date.now();
    while (rendererCrashTimes.length && now - rendererCrashTimes[0] > 120_000) rendererCrashTimes.shift();
    if (rendererCrashTimes.length >= 3) {
      log('renderer recovery paused after repeated crashes', { crashesInWindow: rendererCrashTimes.length, details });
      return;
    }
    rendererCrashTimes.push(now);
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    const delay = Math.min(5000, 800 * rendererCrashTimes.length);
    log('renderer recovery scheduled', { delay, crashCount: rendererCrashTimes.length, details });
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null;
      if (shuttingDown || !win || win.isDestroyed()) return;
      try {
        rendererReady = false;
        preloadReady = false;
        win.webContents.reload();
        log('renderer recovery reload requested');
      } catch (error) {
        log('renderer recovery reload failed', { error: error.stack || error.message });
      }
    }, delay);
  }

  function createWindow() {
    log('creating overlay window', { preload: path.join(__dirname, 'preload.js'), html: path.join(__dirname, 'renderer', 'index.html') });
    win = new BrowserWindow({
      width: W, height: H, frame: false, transparent: true, backgroundColor: '#00000000',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      resizable: false, movable: false, hasShadow: false, alwaysOnTop: true,
      skipTaskbar: true, focusable: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    placeWindow();

    win.webContents.on('did-finish-load', () => {
      log('renderer did-finish-load', { url: win.webContents.getURL() });
      win.webContents.executeJavaScript(`(() => ({readyState:document.readyState,bridgeType:typeof window.island,islandElement:!!document.getElementById('island')}))()`)
        .then((probe) => log('renderer DOM probe', probe))
        .catch((error) => log('renderer DOM probe failed', { error: error.stack || error.message }));
      setTimeout(() => {
        if (!rendererReady && win && !win.isDestroyed()) {
          log('renderer handshake timeout', { preloadReady, pendingNotifications: pendingNotifications.length });
        }
      }, 5000);
    });
    win.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) { rendererReady = false; preloadReady = false; }
      log('renderer navigation started', { url, isMainFrame });
    });
    win.webContents.on('dom-ready', () => log('renderer DOM ready'));
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => log('renderer did-fail-load', { code, description, url, isMainFrame }));
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false;
      preloadReady = false;
      log('renderer process gone', details);
      scheduleRendererRecovery(details);
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => log('preload-error', { preloadPath, error: error.stack || error.message }));
    win.webContents.on('console-message', (...args) => {
      const details = args.find((arg) => arg && typeof arg === 'object' && ('message' in arg || 'level' in arg || 'sourceId' in arg));
      if (details) log('renderer console', { level: details.level, message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber });
      else log('renderer console', { legacyLevel: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] });
    });
    win.once('ready-to-show', () => { log('window ready-to-show; showing inactive'); win.showInactive(); });
    win.on('show', () => log('overlay window shown'));
    win.on('hide', () => log('overlay window hidden'));
    win.on('closed', () => { rendererReady = false; preloadReady = false; win = null; log('overlay window closed'); });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((error) => log('loadFile rejected', { error: error.stack || error.message }));
  }

  function openSettings(page = 'general') {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.show();
      settingsWin.focus();
      settingsWin.webContents.send('settings:navigate', page);
      return;
    }
    settingsWin = new BrowserWindow({
      width: 1060, height: 800, minWidth: 860, minHeight: 660,
      title: 'Desknotch Settings', backgroundColor: '#101114', icon: path.join(__dirname, 'assets', 'icon.png'), show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true,
      },
    });
    settingsWin.webContents.on('console-message', (...args) => {
      const details = args.find((arg) => arg && typeof arg === 'object' && ('message' in arg || 'level' in arg));
      if (details) log('settings console', { level: details.level, message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber });
    });
    settingsWin.webContents.on('preload-error', (_event, preloadPath, error) => log('settings preload-error', { preloadPath, error: error.message }));
    settingsWin.once('ready-to-show', () => settingsWin && !settingsWin.isDestroyed() && settingsWin.show());
    settingsWin.on('closed', () => { settingsWin = null; });
    settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { hash: page })
      .catch((error) => log('settings load failed', { error: error.stack || error.message }));
  }

  function trayIcon() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image.resize({ width: 32, height: 32 });
    // Fallback if the optional image asset was removed from a development checkout.
    const size = 32, pixels = Buffer.alloc(size * size * 4);
    for (let y = 10; y <= 21; y++) for (let x = 3; x <= 28; x++) {
      const index = (y * size + x) * 4;
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 235;
      pixels[index + 3] = 255;
    }
    return nativeImage.createFromBitmap(pixels, { width: size, height: size });
  }

  function integrationData() {
    return {
      media: mediaManager ? mediaManager.getStatus() : { enabled: false, available: false, connected: false, message: 'Media service is not initialized.' },
      clipboard: clipboardWatcher ? clipboardWatcher.getStatus() : { enabled: false },
      calendar: calendarManager ? calendarManager.getData() : { sources: [], events: [] },
    };
  }

  function sendIntegrationChange(channel, payload) {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
  }

  function checkCalendarReminders() {
    if (!calendarManager || !calendarStore || !settingsStore) return;
    const prefs = settingsStore.get().integrations.calendar;
    if (!prefs.remindersEnabled) return;
    const now = Date.now();
    for (const event of calendarStore.listEvents({ from: now, to: now + 3 * 60 * 60_000, limit: 100 })) {
      if (!calendarStore.claimReminder(event, prefs.reminderMinutes, now)) continue;
      const time = new Date(event.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      push({
        source: 'calendar', app: event.calendarName || 'Calendar', appId: `desknotch.calendar.${event.sourceId}`,
        id: `calendar-reminder:${event.sourceId}:${event.uid}:${event.startAt}`,
        title: event.summary, body: `Starts at ${time}${event.location ? ` · ${event.location}` : ''}`,
        receivedAt: now,
      });
    }
    calendarStore.pruneReminders(45);
  }

  function handleMediaState(status) {
    sendIntegrationChange('integration:media-changed', status);
    const session = status.session;
    if (!session) lastMediaTrackKey = '';
    if (!settingsStore || !settingsStore.get().integrations.media.showOnIsland || !session?.isPlaying || !session.title) return;
    const key = `${session.appId}|${session.title}|${session.artist}`;
    if (key === lastMediaTrackKey) return;
    lastMediaTrackKey = key;
    push({
      source: 'media', app: 'Now Playing', appId: 'desknotch.media',
      title: session.title, body: [session.artist, session.appId.split('!')[0]].filter(Boolean).join(' · '),
      media: session, durationMs: 10_000, receivedAt: Date.now(),
    });
  }

  function updateNotice(title, body) {
    push({ app: APP_BRAND, appId: 'desknotch.updater', source: 'system', title, body, receivedAt: Date.now() });
  }

  function setupUpdater() {
    if (!app.isPackaged) {
      log('auto-updater disabled in development mode');
      return;
    }

    const publish = require('./package.json').build?.publish;
    if (!publish || publish.provider !== 'github' || !publish.owner || /^YOUR_|REPLACE_/i.test(publish.owner)) {
      log('auto-updater not configured; set build.publish.owner in package.json');
      return;
    }

    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.on('checking-for-update', () => log('checking for Desknotch updates'));
      autoUpdater.on('update-available', (info) => {
        log('Desknotch update available', { version: info.version });
        updateNotice('Update available', `Desknotch ${info.version} is downloading in the background.`);
      });
      autoUpdater.on('update-not-available', (info) => log('Desknotch is up to date', { version: info.version }));
      autoUpdater.on('download-progress', (progress) => {
        if (Math.round(progress.percent) % 25 < 2) log('Desknotch update download progress', { percent: Math.round(progress.percent) });
      });
      autoUpdater.on('update-downloaded', (info) => {
        updateDownloaded = true;
        log('Desknotch update downloaded', { version: info.version });
        updateNotice('Update ready', `Desknotch ${info.version} is ready. Restart from the tray menu to install it.`);
        if (tray) buildMenu();
      });
      autoUpdater.on('error', (error) => {
        log('Desknotch auto-updater error', { error: error.stack || error.message });
      });
      setTimeout(() => checkForUpdates(), 12_000);
      updateCheckTimer = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
      if (updateCheckTimer.unref) updateCheckTimer.unref();
      if (tray) buildMenu();
    } catch (error) {
      log('auto-updater initialization failed', { error: error.stack || error.message });
    }
  }

  function checkForUpdates() {
    if (!autoUpdater) return;
    autoUpdater.checkForUpdates().catch((error) => log('update check failed', { error: error.stack || error.message }));
  }

  function installDownloadedUpdate() {
    if (!autoUpdater || !updateDownloaded) return;
    shuttingDown = true;
    autoUpdater.quitAndInstall(false, true);
  }

  function buildMenu() {
    const settings = settingsStore ? currentSettings() : null;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Send test notification', click: () => push({ app: 'Desknotch', appId: 'Desknotch', source: 'test', title: 'It works', body: 'This is a test notification from Desknotch.' }) },
      { label: 'Open Settings', click: () => openSettings('general') },
      { label: 'Notification History', click: () => openSettings('history') },
      { label: 'Check for updates', enabled: !!autoUpdater, click: () => checkForUpdates() },
      { label: 'Restart to install update', enabled: updateDownloaded, click: () => installDownloadedUpdate() },
      { type: 'separator' },
      { label: 'Pause notifications', type: 'checkbox', checked: state.paused, click: (item) => { state.paused = item.checked; log('pause changed', { paused: state.paused }); buildMenu(); } },
      { label: 'Manual Focus Mode', type: 'checkbox', checked: !!settings?.focus.enabled, click: (item) => { settingsStore.update({ focus: { enabled: item.checked } }); applySettings(); } },
      { label: 'Show idle pill', type: 'checkbox', checked: settings?.general.idlePill !== false, click: (item) => { settingsStore.update({ general: { idlePill: item.checked } }); applySettings(); } },
      { label: 'Launch at login', type: 'checkbox', checked: !!settings?.general.launchAtLogin, click: (item) => { settingsStore.update({ general: { launchAtLogin: item.checked } }); applySettings(); } },
      { type: 'separator' },
      { label: 'Open log file', click: () => { if (logPath) shell.openPath(logPath); } },
      { label: 'Quit', click: () => app.quit() },
    ]));
  }

  function trustedSettingsSender(event) {
    return !!settingsWin && !settingsWin.isDestroyed() && event.sender === settingsWin.webContents;
  }

  function registerIpc() {
    ipcMain.on('island:preload-ready', (event, details) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      preloadReady = true;
      log('preload ready handshake', details || {});
    });
    ipcMain.on('island:renderer-ready', (event, details) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      rendererReady = true;
      log('renderer ready handshake', { preloadReady, ...(details || {}) });
      win.webContents.send('config', overlayConfig());
      flushPending();
    });
    ipcMain.on('island:hit', (event, hit) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      win.setIgnoreMouseEvents(!hit, { forward: true });
    });
    ipcMain.on('island:renderer-log', (event, item) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      log('renderer log', item);
    });

    ipcMain.handle('settings:get-initial', (event) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      return {
        settings: currentSettings(),
        displays: listDisplays(),
        apps: listApps(),
        integrations: integrationData(),
        historyCount: historyStore.list({ limit: 500 }).length,
      };
    });
    ipcMain.handle('settings:update', (event, patch) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      const updated = settingsStore.update(patch);
      applySettings();
      log('settings updated');
      return updated;
    });
    ipcMain.handle('settings:update-app-rule', (event, payload) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      const updated = settingsStore.updateAppRule(String(payload?.appId || ''), payload?.rule || {});
      applySettings();
      return updated;
    });
    ipcMain.handle('settings:get-history', (event, options) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      return historyStore.list(options || {});
    });
    ipcMain.handle('settings:clear-history', (event) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      historyStore.clear();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', { ...overlayConfig(), apps: listApps() });
      return true;
    });
    ipcMain.handle('settings:replay-history', (event, id) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      const item = historyStore.get(String(id || ''));
      if (!item) return false;
      push({
        app: item.app_name,
        appId: item.app_id,
        title: item.title,
        body: item.body,
        source: 'history-replay',
        id: `history-replay:${crypto.randomUUID()}`,
        receivedAt: Date.now(),
      });
      return true;
    });
    ipcMain.handle('settings:refresh-data', (event) => {
      if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
      return { settings: currentSettings(), displays: listDisplays(), apps: listApps(), integrations: integrationData() };
    });
  }

  ipcMain.handle('integration:get-clipboard', (event, options) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    return clipboardStore.list(options || {});
  });
  ipcMain.handle('integration:copy-clipboard', (event, id) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    const item = clipboardStore.get(String(id));
    if (!item) return false;
    clipboard.writeText(item.content);
    return true;
  });
  ipcMain.handle('integration:delete-clipboard', (event, id) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    clipboardStore.remove(String(id));
    sendIntegrationChange('integration:clipboard-changed', clipboardStore.list({ limit: 100 }));
    return true;
  });
  ipcMain.handle('integration:clear-clipboard', (event) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    clipboardStore.clear();
    sendIntegrationChange('integration:clipboard-changed', []);
    return true;
  });
  ipcMain.handle('integration:get-calendar', (event) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    return calendarManager.getData();
  });
  ipcMain.handle('integration:add-calendar-feed', async (event, url) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    const source = calendarManager.addFeed(url);
    const refreshed = await calendarManager.refreshAll();
    return { source, ...refreshed };
  });
  ipcMain.handle('integration:remove-calendar-feed', (event, id) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    calendarManager.removeFeed(id);
    return calendarManager.getData();
  });
  ipcMain.handle('integration:refresh-calendar', async (event) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    return calendarManager.refreshAll();
  });
  ipcMain.handle('integration:get-media', (event) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    return mediaManager.getStatus();
  });
  ipcMain.handle('integration:media-command', (event, action) => {
    if (!trustedSettingsSender(event)) throw new Error('Untrusted settings window');
    mediaManager.command(String(action));
    return true;
  });
  ipcMain.on('island:media-command', (event, action) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    try { mediaManager.command(String(action)); }
    catch (error) { log('media control action failed', { action, error: error.message }); }
  });

  function startServer() {
    server = http.createServer((req, res) => {
      log('HTTP request', { method: req.method, url: req.url, contentType: req.headers['content-type'] });
      if (req.method !== 'POST' || req.url !== '/notify' || !/application\/json/i.test(req.headers['content-type'] || '')) {
        res.writeHead(404).end(); return;
      }
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 10000) { log('HTTP body too large'); req.destroy(); }
      });
      req.on('end', () => {
        try { push(JSON.parse(data)); res.writeHead(204).end(); }
        catch (error) { log('HTTP JSON parse failed', { error: error.message }); res.writeHead(400).end(); }
      });
    });
    server.on('error', (error) => log('HTTP server error', { code: error.code, message: error.message }));
    server.listen(PORT, '127.0.0.1', () => log('HTTP endpoint listening', { host: '127.0.0.1', port: PORT }));
  }

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, { recursive: true });
    logPath = path.join(userData, 'desknotch.log');
    const migration = migrateLegacyUserData({ appDataPath: app.getPath('appData'), targetPath: userData, logger: log });
    log('app ready', {
      app: APP_BRAND, version: app.getVersion(), migration, logPath, platform: process.platform, electron: process.versions.electron,
      node: process.versions.node, chromium: process.versions.chrome, userData,
    });
    settingsStore = new SettingsStore(path.join(userData, 'settings.json'), { logger: log });
    historyStore = new HistoryStore(path.join(userData, 'desknotch-history.db'), { retentionDays: settingsStore.get().notifications.retentionDays });
    const secureDataStorage = safeStorage.isEncryptionAvailable();
    const encryptPrivateText = secureDataStorage
      ? (value) => `enc:${safeStorage.encryptString(value).toString('base64')}`
      : (value) => value;
    const decryptPrivateText = (value) => String(value).startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(String(value).slice(4), 'base64'))
      : value;
    clipboardStore = new ClipboardStore(path.join(userData, 'desknotch-clipboard.db'), {
      ...settingsStore.get().integrations.clipboard,
      encryptContent: encryptPrivateText,
      decryptContent: decryptPrivateText,
    });
    log('private data encryption', { available: secureDataStorage });
    calendarStore = new CalendarStore(path.join(userData, 'desknotch-calendar.db'));
    clipboardWatcher = new ClipboardWatcher({ readText: async () => clipboard.readText(), store: clipboardStore, logger: log });
    clipboardWatcher.on('item', (item) => {
      sendIntegrationChange('integration:clipboard-changed', clipboardStore.list({ limit: 100 }));
      if (settingsStore.get().integrations.clipboard.showOnIsland) {
        const preview = item.content.replace(/\s+/g, ' ').slice(0, 160);
        push({ source: 'clipboard', app: 'Clipboard', appId: 'desknotch.clipboard', title: 'Copied to clipboard', body: preview, receivedAt: item.created_at });
      }
    });
    const secureCalendarStorage = safeStorage.isEncryptionAvailable();
    calendarManager = new CalendarManager(calendarStore, {
      logger: log,
      encryptUrl: secureCalendarStorage ? (value) => `enc:${safeStorage.encryptString(value).toString('base64')}` : (value) => value,
      decryptUrl: (value) => String(value).startsWith('enc:')
        ? safeStorage.decryptString(Buffer.from(String(value).slice(4), 'base64'))
        : value,
    });
    log('calendar URL encryption', { available: secureCalendarStorage });
    calendarManager.on('changed', (payload) => sendIntegrationChange('integration:calendar-changed', payload));
    mediaManager = new MediaManager({ appPath: __dirname, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged, logger: log });
    mediaManager.on('changed', handleMediaState);
    historyPruneTimer = setInterval(() => {
      try { historyStore.prune(settingsStore.get().notifications.retentionDays); }
      catch (error) { log('history retention cleanup failed', { error: error.message }); }
    }, 60 * 60 * 1000);
    calendarRefreshMinutes = settingsStore.get().integrations.calendar.refreshMinutes;
    calendarManager.start(calendarRefreshMinutes);
    calendarReminderTimer = setInterval(checkCalendarReminders, 30_000);
    registerIpc();

    // Keep the system login setting and persisted preference aligned on startup.
    const actualLogin = app.getLoginItemSettings().openAtLogin;
    if (actualLogin !== settingsStore.get().general.launchAtLogin) {
      log('login item state differs from stored preference', { actualLogin });
      app.setLoginItemSettings({ openAtLogin: settingsStore.get().general.launchAtLogin });
    }

    createWindow();
    tray = new Tray(trayIcon());
    tray.setToolTip('Desknotch');
    buildMenu();
    startServer();
    clipboardWatcher.setEnabled(settingsStore.get().integrations.clipboard.enabled).catch((error) => log('clipboard startup failed', { error: error.message }));
    mediaManager.setEnabled(settingsStore.get().integrations.media.enabled);

    const handleDisplayChange = () => {
      const selectedId = settingsStore.get().display.displayId;
      const connected = screen.getAllDisplays().some((display) => String(display.id) === String(selectedId));
      if (selectedId && !connected) {
        const primary = screen.getPrimaryDisplay();
        settingsStore.update({ display: { displayId: String(primary.id) } });
        log('selected display disconnected; using primary display', { displayId: primary.id });
      }
      placeWindow();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', { ...overlayConfig(), apps: listApps() });
    };
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);
    screen.on('display-metrics-changed', handleDisplayChange);

    watcher = new WinNotificationWatcher({ logger: (message, details) => log(`watcher: ${message}`, details) });
    watcher.on('notification', (notification) => { log('watcher emitted notification', { appId: notification.appId, app: notification.app }); push(notification); });
    watcher.on('unsupported', (message) => { log('watcher unsupported', { message }); push({ app: 'Desknotch', appId: 'Desknotch', source: 'system', title: 'Notification capture is off', body: message }); });
    watcher.on('error', (error) => { log('watcher error event', { error: error.stack || error.message }); push({ app: 'Desknotch', appId: 'Desknotch', source: 'system', title: 'Could not read notifications', body: error.message }); });
    watcher.on('ready', () => { log('watcher ready'); push({ app: 'Desknotch', appId: 'Desknotch', source: 'system', title: 'Desknotch is running', body: 'Desknotch is ready.' }); });
    watcher.start();
    setupUpdater();
  }).catch((error) => log('app startup failed', { error: error.stack || error.message }));

  app.on('window-all-closed', (event) => event.preventDefault());
  app.on('before-quit', () => {
    shuttingDown = true;
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    log('Desknotch quitting');
    watcher && watcher.stop();
    server && server.close();
    if (historyPruneTimer) clearInterval(historyPruneTimer);
    if (calendarReminderTimer) clearInterval(calendarReminderTimer);
    clipboardWatcher && clipboardWatcher.stop();
    calendarManager && calendarManager.stop();
    mediaManager && mediaManager.stop();
    clipboardStore && clipboardStore.close();
    calendarStore && calendarStore.close();
    historyStore && historyStore.close();
  });
}
