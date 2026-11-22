'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('island', {
  onNotify: (callback) => subscribe('notify', callback),
  onConfig: (callback) => subscribe('config', callback),
  onMedia: (callback) => subscribe('media:state', callback),
  mediaCommand: (action) => ipcRenderer.send('island:media-command', String(action)),
  setHit: (hit) => ipcRenderer.send('island:hit', !!hit),
  log: (item) => ipcRenderer.send('island:renderer-log', item),
  ready: (details) => ipcRenderer.send('island:renderer-ready', details || {}),
});

contextBridge.exposeInMainWorld('islandSettings', {
  getInitial: () => ipcRenderer.invoke('settings:get-initial'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  updateAppRule: (appId, rule) => ipcRenderer.invoke('settings:update-app-rule', { appId, rule }),
  getHistory: (options) => ipcRenderer.invoke('settings:get-history', options || {}),
  clearHistory: () => ipcRenderer.invoke('settings:clear-history'),
  replayHistory: (id) => ipcRenderer.invoke('settings:replay-history', String(id)),
  refreshData: () => ipcRenderer.invoke('settings:refresh-data'),
  getClipboard: (options) => ipcRenderer.invoke('integration:get-clipboard', options || {}),
  copyClipboard: (id) => ipcRenderer.invoke('integration:copy-clipboard', String(id)),
  deleteClipboard: (id) => ipcRenderer.invoke('integration:delete-clipboard', String(id)),
  clearClipboard: () => ipcRenderer.invoke('integration:clear-clipboard'),
  getCalendar: () => ipcRenderer.invoke('integration:get-calendar'),
  addCalendarFeed: (url) => ipcRenderer.invoke('integration:add-calendar-feed', String(url)),
  removeCalendarFeed: (id) => ipcRenderer.invoke('integration:remove-calendar-feed', String(id)),
  refreshCalendar: () => ipcRenderer.invoke('integration:refresh-calendar'),
  getMedia: () => ipcRenderer.invoke('integration:get-media'),
  mediaCommand: (action) => ipcRenderer.invoke('integration:media-command', String(action)),
  onNavigate: (callback) => subscribe('settings:navigate', callback),
  onChanged: (callback) => subscribe('settings:changed', callback),
  onClipboardChanged: (callback) => subscribe('integration:clipboard-changed', callback),
  onCalendarChanged: (callback) => subscribe('integration:calendar-changed', callback),
  onMediaChanged: (callback) => subscribe('integration:media-changed', callback),
});

ipcRenderer.send('island:preload-ready', { at: new Date().toISOString() });
