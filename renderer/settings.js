(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.islandSettings;
  const pageNames = {
    general: 'General', appearance: 'Appearance', notifications: 'Notifications',
    applications: 'Applications', focus: 'Focus mode', displays: 'Displays', history: 'History',
    media: 'Now Playing', clipboard: 'Clipboard', calendar: 'Calendar',
  };
  let settings = null;
  let displays = [];
  let apps = [];
  let integrations = { media: {}, clipboard: {}, calendar: { sources: [], events: [] } };
  let clipboardItems = [];
  let calendarData = { sources: [], events: [] };
  let mediaState = {};
  let toastTimer = 0;
  let historyTimer = 0;

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2100);
  }

  function navigate(page) {
    if (!pageNames[page]) page = 'general';
    document.querySelectorAll('[data-page]').forEach((section) => section.classList.toggle('active', section.dataset.page === page));
    document.querySelectorAll('[data-nav]').forEach((button) => button.classList.toggle('active', button.dataset.nav === page));
    $('page-name').textContent = pageNames[page];
    history.replaceState(null, '', `#${page}`);
    if (page === 'history') loadHistory();
    if (page === 'applications') renderApps();
    if (page === 'clipboard') loadClipboard();
    if (page === 'calendar') loadCalendar();
    if (page === 'media') loadMedia();
  }

  async function save(patch, message = 'Saved') {
    try {
      settings = await api.update(patch);
      renderSettings();
      if (document.querySelector('[data-page=\"clipboard\"].active')) renderClipboard();
      showToast(message);
    } catch (error) {
      console.error('Desknotch settings save failed:', error);
      showToast(`Could not save: ${error.message}`);
    }
  }

  function bindCheckbox(id, path, extra = {}) {
    $(id).addEventListener('change', (event) => save({ [path[0]]: { [path[1]]: event.target.checked, ...extra } }));
  }

  function bindNumber(id, path, min, max, extra = {}) {
    $(id).addEventListener('change', (event) => {
      const value = Math.max(min, Math.min(max, Number(event.target.value) || min));
      event.target.value = String(value);
      save({ [path[0]]: { [path[1]]: value, ...extra } });
    });
  }

  function bindRange(id, path, format, outputId) {
    const input = $(id), output = $(outputId);
    const updateOutput = () => { output.textContent = format(Number(input.value)); };
    input.addEventListener('input', updateOutput);
    input.addEventListener('change', () => save({ [path[0]]: { [path[1]]: Number(input.value) } }));
  }

  function renderSettings() {
    if (!settings) return;
    $('launchAtLogin').checked = settings.general.launchAtLogin;
    $('idlePill').checked = settings.general.idlePill;
    $('notificationsEnabled').checked = settings.general.notificationsEnabled;
    $('autoHideSeconds').value = settings.general.autoHideSeconds;
    $('accentColor').value = settings.appearance.accentColor;
    $('hoverOpacity').value = settings.appearance.hoverOpacity;
    $('hoverOpacityValue').textContent = `${Math.round(settings.appearance.hoverOpacity * 100)}%`;
    $('animationScale').value = settings.appearance.animationScale;
    $('animationScaleValue').textContent = `${Math.round(settings.appearance.animationScale * 100)}%`;
    $('islandWidth').value = settings.appearance.islandWidth;
    $('islandWidthValue').textContent = `${settings.appearance.islandWidth} px`;
    $('storeHistory').checked = settings.notifications.storeHistory;
    $('retentionDays').value = settings.notifications.retentionDays;
    $('defaultDurationSeconds').value = settings.notifications.defaultDurationSeconds;
    $('focusEnabled').checked = settings.focus.enabled;
    $('allowPriority').checked = settings.focus.allowPriority;
    $('scheduleEnabled').checked = settings.focus.schedule.enabled;
    $('scheduleStart').value = settings.focus.schedule.start;
    $('scheduleEnd').value = settings.focus.schedule.end;
    $('horizontalOffset').value = settings.display.horizontalOffset;
    $('horizontalOffsetValue').textContent = `${settings.display.horizontalOffset} px`;
    $('topOffset').value = settings.display.topOffset;
    $('topOffsetValue').textContent = `${settings.display.topOffset} px`;
    document.querySelectorAll('[data-theme]').forEach((button) => button.classList.toggle('active', button.dataset.theme === settings.appearance.theme));
    document.querySelectorAll('[data-ui-mode]').forEach((button) => button.classList.toggle('active', button.dataset.uiMode === settings.appearance.uiMode));
    if (settings.appearance.uiMode === 'system') document.documentElement.removeAttribute('data-ui-mode');
    else document.documentElement.dataset.uiMode = settings.appearance.uiMode;
    renderDisplays();
    renderIntegrationSettings();
  }

  function renderIntegrationSettings() {
    const value = settings?.integrations;
    if (!value) return;
    $('mediaEnabled').checked = value.media.enabled;
    $('mediaShowOnIsland').checked = value.media.showOnIsland;
    $('clipboardEnabled').checked = value.clipboard.enabled;
    $('clipboardShowOnIsland').checked = value.clipboard.showOnIsland;
    $('clipboardRetentionDays').value = value.clipboard.retentionDays;
    $('clipboardMaxItems').value = value.clipboard.maxItems;
    $('calendarRemindersEnabled').checked = value.calendar.remindersEnabled;
    $('calendarReminderMinutes').value = value.calendar.reminderMinutes;
    $('calendarRefreshMinutes').value = value.calendar.refreshMinutes;
  }

  function renderDisplays() {
    const select = $('displayId');
    const selected = settings.display.displayId || displays.find((display) => display.primary)?.id || '';
    select.replaceChildren();
    displays.forEach((display) => {
      const option = document.createElement('option');
      option.value = display.id;
      const b = display.bounds;
      option.textContent = `${display.label}${display.primary ? ' · Primary' : ''} — ${b.width} × ${b.height}`;
      select.append(option);
    });
    if (selected && [...select.options].some((option) => option.value === String(selected))) select.value = String(selected);
    else if (select.options.length) select.selectedIndex = 0;
    select.disabled = displays.length <= 1;
  }

  function appRule(appId) {
    return settings.apps[appId] || { enabled: true, priority: false, durationSeconds: null };
  }

  function renderApps() {
    if (!settings) return;
    const container = $('app-list');
    const map = new Map(apps.map((app) => [app.appId, app]));
    for (const [appId] of Object.entries(settings.apps)) {
      if (!map.has(appId)) map.set(appId, { appId, appName: appId, count: 0, lastSeen: 0 });
    }
    const query = $('appSearch').value.trim().toLowerCase();
    const rows = [...map.values()].filter((app) => `${app.appName} ${app.appId}`.toLowerCase().includes(query));
    container.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      empty.textContent = apps.length ? 'No applications match your search.' : 'Applications will appear here after Desknotch detects notifications.';
      container.append(empty); return;
    }
    rows.forEach((app) => {
      const rule = appRule(app.appId);
      const row = document.createElement('div'); row.className = 'app-row';
      const avatar = document.createElement('div'); avatar.className = 'app-avatar'; avatar.textContent = (app.appName || '?').trim().charAt(0).toUpperCase();
      const meta = document.createElement('div'); meta.className = 'app-meta';
      const title = document.createElement('strong'); title.textContent = app.appName || 'Unknown application';
      const id = document.createElement('small'); id.textContent = `${app.appId} · ${app.count || 0} saved`;
      meta.append(title, id);
      const actions = document.createElement('div'); actions.className = 'app-actions';
      const enabledLabel = document.createElement('label');
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false;
      enabled.addEventListener('change', () => updateRule(app.appId, { enabled: enabled.checked }));
      enabledLabel.append(enabled, document.createTextNode('Allow'));
      const priorityLabel = document.createElement('label');
      const priority = document.createElement('input'); priority.type = 'checkbox'; priority.checked = rule.priority === true;
      priority.addEventListener('change', () => updateRule(app.appId, { priority: priority.checked }));
      priorityLabel.append(priority, document.createTextNode('Priority'));
      const duration = document.createElement('select');
      [['', 'Auto'], ['5', '5s'], ['7', '7s'], ['10', '10s'], ['15', '15s'], ['20', '20s']].forEach(([value, label]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = label; duration.append(option);
      });
      duration.value = rule.durationSeconds == null ? '' : String(rule.durationSeconds);
      duration.title = 'Notification card duration';
      duration.addEventListener('change', () => updateRule(app.appId, { durationSeconds: duration.value === '' ? null : Number(duration.value) }));
      actions.append(enabledLabel, priorityLabel, duration);
      row.append(avatar, meta, actions); container.append(row);
    });
  }

  async function updateRule(appId, rule) {
    try { settings = await api.updateAppRule(appId, rule); renderApps(); showToast('Application rule saved'); }
    catch (error) { showToast(`Could not save rule: ${error.message}`); }
  }

  async function loadHistory() {
    const container = $('history-list');
    try {
      const rows = await api.getHistory({ query: $('historySearch').value, limit: 200 });
      container.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement('div'); empty.className = 'empty-state';
        empty.textContent = settings.notifications.storeHistory ? 'No matching notifications found.' : 'Notification history is disabled. Enable it in Notifications settings to save future items.';
        container.append(empty);
      } else rows.forEach((item) => {
        const card = document.createElement('article'); card.className = 'history-item';
        const top = document.createElement('div'); top.className = 'history-top';
        const app = document.createElement('strong'); app.textContent = item.app_name;
        const right = document.createElement('span'); right.textContent = `${new Date(item.received_at).toLocaleString()} · ${item.source}`;
        const status = document.createElement('span'); status.className = 'history-status'; status.textContent = item.status === 'shown' ? (item.priority ? 'Priority' : 'Shown') : item.status.replaceAll('-', ' ');
        right.append(status); top.append(app, right);
        const title = document.createElement('div'); title.className = 'history-title'; title.textContent = item.title || '(No title)';
        const body = document.createElement('div'); body.className = 'history-body'; body.textContent = item.body || '';
        const actions = document.createElement('div'); actions.className = 'history-actions';
        const replay = document.createElement('button'); replay.className = 'history-replay'; replay.textContent = 'Show again';
        replay.addEventListener('click', async () => {
          try { showToast(await api.replayHistory(item.id) ? 'Notification sent to Desknotch' : 'This history item no longer exists'); }
          catch (error) { showToast(`Could not replay notification: ${error.message}`); }
        });
        actions.append(replay); card.append(top, title, body, actions); container.append(card);
      });
      $('history-footer').textContent = settings.notifications.storeHistory ? `${rows.length} recent item${rows.length === 1 ? '' : 's'} shown · stored locally on this device` : 'History storage is currently off.';
    } catch (error) {
      console.error('Could not load notification history:', error);
      container.textContent = `Could not load history: ${error.message}`;
    }
  }

  function renderMedia() {
    const session = mediaState?.session || null;
    $('media-title').textContent = session?.title || 'No active media session';
    $('media-artist').textContent = session ? [session.artist, session.album].filter(Boolean).join(' · ') || 'Unknown artist' : 'Start playing music in a supported Windows app.';
    $('media-app').textContent = session?.appId || 'Windows media sessions';
    const art = $('media-art');
    art.style.backgroundImage = session?.artworkBase64 ? `url(data:${session.artworkMimeType || 'image/jpeg'};base64,${session.artworkBase64})` : '';
    art.textContent = session?.artworkBase64 ? '' : '♫';
    $('media-toggle').textContent = session?.isPlaying ? 'Ⅱ' : '▶';
    const hasSession = !!mediaState?.connected && !!session;
    $('media-toggle').disabled = !hasSession;
    $('media-next').disabled = !hasSession;
    $('media-previous').disabled = !hasSession;
    $('media-status').textContent = mediaState?.message || 'Media integration is disabled.';
    $('media-status').classList.toggle('error', mediaState?.enabled && !mediaState?.connected && !!mediaState?.message);
  }

  async function loadMedia() {
    try { mediaState = await api.getMedia(); renderMedia(); }
    catch (error) { mediaState = { message: error.message }; renderMedia(); }
  }

  async function runMediaCommand(action) {
    try { await api.mediaCommand(action); }
    catch (error) { showToast(`Media command failed: ${error.message}`); }
  }

  async function loadClipboard() {
    try {
      clipboardItems = await api.getClipboard({ limit: 100 });
      renderClipboard();
    } catch (error) { $('clipboard-list').textContent = `Could not load clipboard history: ${error.message}`; }
  }

  function renderClipboard() {
    const container = $('clipboard-list');
    container.replaceChildren();
    if (!settings.integrations.clipboard.enabled) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'Clipboard monitoring is off. Enable it above to start a local history.';
      container.append(empty);
    } else if (!clipboardItems.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'Copy text anywhere in Windows and it will appear here.';
      container.append(empty);
    } else clipboardItems.forEach((item) => {
      const card = document.createElement('article'); card.className = 'history-item';
      const top = document.createElement('div'); top.className = 'history-top';
      const label = document.createElement('strong'); label.textContent = 'Copied text';
      const time = document.createElement('span'); time.textContent = new Date(item.created_at).toLocaleString();
      top.append(label, time);
      const body = document.createElement('div'); body.className = 'history-body'; body.textContent = item.content;
      const actions = document.createElement('div'); actions.className = 'history-actions';
      const copy = document.createElement('button'); copy.className = 'history-replay'; copy.textContent = 'Copy again';
      copy.addEventListener('click', async () => { try { showToast(await api.copyClipboard(item.id) ? 'Copied to clipboard' : 'Item not found'); } catch (error) { showToast(error.message); } });
      const remove = document.createElement('button'); remove.className = 'danger-button'; remove.textContent = 'Remove';
      remove.addEventListener('click', async () => { await api.deleteClipboard(item.id); await loadClipboard(); });
      actions.append(copy, remove); card.append(top, body, actions); container.append(card);
    });
    $('clipboard-footer').textContent = settings.integrations.clipboard.enabled ? `${clipboardItems.length} items · local text history` : 'Clipboard monitoring is off.';
  }

  function renderCalendar() {
    const sources = $('calendar-sources');
    sources.replaceChildren();
    if (!calendarData.sources?.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No calendars added.'; sources.append(empty);
    } else calendarData.sources.forEach((source) => {
      const row = document.createElement('div'); row.className = 'calendar-source';
      const meta = document.createElement('div'); meta.className = 'calendar-source-meta';
      const name = document.createElement('strong'); name.textContent = source.name;
      const detail = document.createElement('small'); detail.textContent = source.lastError || `${source.displayUrl || 'Private calendar feed'} · ${source.lastSync ? `Updated ${new Date(source.lastSync).toLocaleString()}` : 'Not refreshed yet'}`;
      meta.append(name, detail);
      const remove = document.createElement('button'); remove.className = 'danger-button'; remove.textContent = 'Remove';
      remove.addEventListener('click', async () => { try { calendarData = await api.removeCalendarFeed(source.id); renderCalendar(); showToast('Calendar removed'); } catch (error) { showToast(error.message); } });
      row.append(meta, remove); sources.append(row);
    });

    const events = $('calendar-events');
    events.replaceChildren();
    if (!calendarData.events?.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'No upcoming events found.'; events.append(empty);
    } else calendarData.events.forEach((event) => {
      const card = document.createElement('article'); card.className = 'calendar-event';
      const title = document.createElement('strong'); title.textContent = event.summary;
      const time = document.createElement('span');
      time.textContent = event.allDay ? new Date(event.startAt).toLocaleDateString() : `${new Date(event.startAt).toLocaleString()} – ${new Date(event.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      const source = document.createElement('span'); source.textContent = `${event.calendarName}${event.location ? ` · ${event.location}` : ''}`;
      card.append(title, time, source); events.append(card);
    });
    const warningCount = (calendarData.warnings || []).length;
    $('calendar-status').textContent = `${calendarData.sources?.length || 0} calendars · ${calendarData.events?.length || 0} upcoming events${warningCount ? ` · ${warningCount} recurrence warning${warningCount === 1 ? '' : 's'}` : ''}`;
    $('calendar-status').classList.toggle('error', (calendarData.sources || []).some((source) => source.lastError));
  }

  async function loadCalendar() {
    try { calendarData = await api.getCalendar(); renderCalendar(); }
    catch (error) { $('calendar-status').textContent = `Could not load calendar: ${error.message}`; }
  }

  function bindEvents() {
    document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)));
    api.onNavigate(navigate);
    api.onChanged((payload) => {
      if (payload?.settings) settings = payload.settings;
      if (payload?.displays) displays = payload.displays;
      if (payload?.apps) apps = payload.apps;
      renderSettings(); renderApps();
    });
    api.onClipboardChanged((items) => { clipboardItems = items || []; renderClipboard(); });
    api.onCalendarChanged((data) => { calendarData = data || { sources: [], events: [] }; renderCalendar(); });
    api.onMediaChanged((status) => { mediaState = status || {}; renderMedia(); });

    bindCheckbox('launchAtLogin', ['general', 'launchAtLogin']);
    bindCheckbox('idlePill', ['general', 'idlePill']);
    bindCheckbox('notificationsEnabled', ['general', 'notificationsEnabled']);
    bindNumber('autoHideSeconds', ['general', 'autoHideSeconds'], 0, 300);
    bindCheckbox('storeHistory', ['notifications', 'storeHistory']);
    bindNumber('retentionDays', ['notifications', 'retentionDays'], 1, 365);
    bindNumber('defaultDurationSeconds', ['notifications', 'defaultDurationSeconds'], 3, 30);
    bindCheckbox('focusEnabled', ['focus', 'enabled']);
    bindCheckbox('allowPriority', ['focus', 'allowPriority']);
    $('scheduleEnabled').addEventListener('change', (event) => save({ focus: { schedule: { enabled: event.target.checked } } }));
    $('scheduleStart').addEventListener('change', (event) => save({ focus: { schedule: { start: event.target.value } } }));
    $('scheduleEnd').addEventListener('change', (event) => save({ focus: { schedule: { end: event.target.value } } }));

    $('accentColor').addEventListener('change', (event) => save({ appearance: { accentColor: event.target.value, theme: 'custom' } }));
    bindRange('hoverOpacity', ['appearance', 'hoverOpacity'], (value) => `${Math.round(value * 100)}%`, 'hoverOpacityValue');
    bindRange('animationScale', ['appearance', 'animationScale'], (value) => `${Math.round(value * 100)}%`, 'animationScaleValue');
    bindRange('islandWidth', ['appearance', 'islandWidth'], (value) => `${value} px`, 'islandWidthValue');
    document.querySelectorAll('[data-theme]').forEach((button) => button.addEventListener('click', () => save({ appearance: { theme: button.dataset.theme } }, `${button.dataset.theme} theme applied`)));
    document.querySelectorAll('[data-ui-mode]').forEach((button) => button.addEventListener('click', () => save({ appearance: { uiMode: button.dataset.uiMode } }, `${button.dataset.uiMode} mode applied`)));

    $('displayId').addEventListener('change', (event) => save({ display: { displayId: event.target.value } }, 'Display updated'));
    bindRange('horizontalOffset', ['display', 'horizontalOffset'], (value) => `${value} px`, 'horizontalOffsetValue');
    bindRange('topOffset', ['display', 'topOffset'], (value) => `${value} px`, 'topOffsetValue');
    $('appSearch').addEventListener('input', renderApps);
    $('historySearch').addEventListener('input', () => { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 160); });
    $('clearHistory').addEventListener('click', async () => {
      if (!confirm('Clear all notification history stored by Desknotch? This cannot be undone.')) return;
      try { await api.clearHistory(); await loadHistory(); showToast('Notification history cleared'); }
      catch (error) { showToast(`Could not clear history: ${error.message}`); }
    });

    $('mediaEnabled').addEventListener('change', (event) => save({ integrations: { media: { enabled: event.target.checked } } }, event.target.checked ? 'Media integration enabled' : 'Media integration disabled'));
    $('mediaShowOnIsland').addEventListener('change', (event) => save({ integrations: { media: { showOnIsland: event.target.checked } } }));
    $('media-previous').addEventListener('click', () => runMediaCommand('previous'));
    $('media-toggle').addEventListener('click', () => runMediaCommand('playPause'));
    $('media-next').addEventListener('click', () => runMediaCommand('next'));

    $('clipboardEnabled').addEventListener('change', (event) => save({ integrations: { clipboard: { enabled: event.target.checked } } }, event.target.checked ? 'Clipboard history enabled' : 'Clipboard history paused'));
    $('clipboardShowOnIsland').addEventListener('change', (event) => save({ integrations: { clipboard: { showOnIsland: event.target.checked } } }));
    $('clipboardRetentionDays').addEventListener('change', (event) => save({ integrations: { clipboard: { retentionDays: Number(event.target.value) } } }));
    $('clipboardMaxItems').addEventListener('change', (event) => save({ integrations: { clipboard: { maxItems: Number(event.target.value) } } }));
    $('clearClipboard').addEventListener('click', async () => {
      if (!confirm('Delete all saved clipboard entries?')) return;
      try { await api.clearClipboard(); await loadClipboard(); showToast('Clipboard history cleared'); }
      catch (error) { showToast(error.message); }
    });

    $('calendarRemindersEnabled').addEventListener('change', (event) => save({ integrations: { calendar: { remindersEnabled: event.target.checked } } }));
    $('calendarReminderMinutes').addEventListener('change', (event) => save({ integrations: { calendar: { reminderMinutes: Number(event.target.value) } } }));
    $('calendarRefreshMinutes').addEventListener('change', (event) => save({ integrations: { calendar: { refreshMinutes: Number(event.target.value) } } }));
    $('calendar-add').addEventListener('click', async () => {
      const input = $('calendar-url');
      if (!input.value.trim()) { showToast('Enter an HTTPS calendar feed URL'); return; }
      $('calendar-add').disabled = true;
      try {
        const result = await api.addCalendarFeed(input.value.trim());
        calendarData = result; input.value = ''; renderCalendar();
        const failures = (result.results || []).filter((row) => row.error).length;
        const recurrenceWarnings = result.results?.reduce((sum, row) => sum + Number(row.recurringSkipped || 0), 0) || 0;
        showToast(failures ? 'Calendar added, but refresh reported an error' : recurrenceWarnings ? `Calendar added; ${recurrenceWarnings} recurrence series need unsupported rules` : 'Calendar feed added');
      } catch (error) { showToast(`Could not add calendar: ${error.message}`); }
      finally { $('calendar-add').disabled = false; }
    });
    $('calendar-refresh').addEventListener('click', async () => {
      $('calendar-refresh').disabled = true;
      try { const result = await api.refreshCalendar(); calendarData = result; renderCalendar(); const skipped = result.results?.reduce((sum, row) => sum + Number(row.recurringSkipped || 0), 0) || 0; showToast(skipped ? `Refreshed; ${skipped} recurrence series skipped` : 'Calendars refreshed'); }
      catch (error) { showToast(error.message); }
      finally { $('calendar-refresh').disabled = false; }
    });
    $('refresh').addEventListener('click', refresh);
  }

  async function refresh() {
    try {
      const data = await api.refreshData();
      settings = data.settings; displays = data.displays; apps = data.apps; integrations = data.integrations || integrations;
      mediaState = integrations.media || mediaState; calendarData = integrations.calendar || calendarData;
      renderSettings(); renderApps(); renderMedia(); renderCalendar(); await loadHistory(); await loadClipboard(); showToast('Desknotch settings refreshed');
    } catch (error) { showToast(`Refresh failed: ${error.message}`); }
  }

  async function init() {
    if (!api) throw new Error('Desknotch settings bridge is unavailable');
    bindEvents();
    const data = await api.getInitial();
    settings = data.settings; displays = data.displays; apps = data.apps; integrations = data.integrations || integrations;
    mediaState = integrations.media || {};
    calendarData = integrations.calendar || calendarData;
    renderSettings(); renderApps(); renderMedia(); renderCalendar();
    navigate(location.hash.slice(1) || 'general');
  }

  init().catch((error) => {
    console.error('Desknotch Settings failed to initialize:', error);
    $('page-name').textContent = 'Settings unavailable';
    $('toast').textContent = `Desknotch could not load settings: ${error.message}`;
    $('toast').classList.add('show');
  });
})();
