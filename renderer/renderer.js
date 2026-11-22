(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const island = $('island'), content = $('content'), ring = $('ring');
const RING = 2 * Math.PI * 9;

const report = (item) => {
  try { window.island?.log?.(item); } catch (error) { console.error('Desknotch renderer logging failed:', error); }
};

window.addEventListener('error', (e) => report({ event: 'window-error', message: e.message, file: e.filename, line: e.lineno, column: e.colno }));
window.addEventListener('unhandledrejection', (e) => report({ event: 'unhandled-rejection', reason: String(e.reason && (e.reason.stack || e.reason.message) || e.reason) }));
report({ event: 'renderer-started', readyState: document.readyState, userAgent: navigator.userAgent, bridgeType: typeof window.island });
if (!window.island) throw new Error('Electron preload bridge window.island is missing');
ring.style.strokeDasharray = RING;

let autoHideMs = 30_000;
const SWIPE_DISMISS_DISTANCE = 56;
const SWIPE_CLICK_GUARD_DISTANCE = 8;
let queue = [], showing = false, hovered = false, idlePill = true, raf = 0;
let lastNotificationAt = Date.now();
let idleHideTimer = 0;
let pointerGesture = null;
let suppressNextClick = false;
let activeUiMode = 'system';
const glassLight = { x: 28, y: 12, targetX: 28, targetY: 12, frame: 0 };
const GLASS_LIGHT_EASING = 0.16;
const GLASS_LIGHT_HOME = { x: 28, y: 12 };
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const colorScheme = window.matchMedia?.('(prefers-color-scheme: light)');
function applyUiMode() {
  document.body.dataset.uiMode = activeUiMode === 'system' ? (colorScheme?.matches ? 'light' : 'dark') : activeUiMode;
}
colorScheme?.addEventListener?.('change', () => { if (activeUiMode === 'system') applyUiMode(); });

const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };


function animateGlassLight() {
  if (glassLight.frame) return;
  if (reducedMotion?.matches) {
    glassLight.x = glassLight.targetX;
    glassLight.y = glassLight.targetY;
    island.style.setProperty('--glass-x', `${glassLight.x.toFixed(2)}%`);
    island.style.setProperty('--glass-y', `${glassLight.y.toFixed(2)}%`);
    return;
  }
  glassLight.frame = requestAnimationFrame((_timestamp) => {
    glassLight.frame = 0;
    const dx = glassLight.targetX - glassLight.x;
    const dy = glassLight.targetY - glassLight.y;
    glassLight.x += dx * GLASS_LIGHT_EASING;
    glassLight.y += dy * GLASS_LIGHT_EASING;
    island.style.setProperty('--glass-x', `${glassLight.x.toFixed(2)}%`);
    island.style.setProperty('--glass-y', `${glassLight.y.toFixed(2)}%`);
    if (Math.abs(dx) > 0.08 || Math.abs(dy) > 0.08) animateGlassLight();
    else {
      glassLight.x = glassLight.targetX;
      glassLight.y = glassLight.targetY;
      island.style.setProperty('--glass-x', `${glassLight.x.toFixed(2)}%`);
      island.style.setProperty('--glass-y', `${glassLight.y.toFixed(2)}%`);
    }
  });
}

function updateGlassLightFromPointer(event) {
  if (document.body.dataset.theme !== 'glass' || !event) return;
  const rect = island.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  glassLight.targetX = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
  glassLight.targetY = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
  animateGlassLight();
}

function returnGlassLightHome() {
  glassLight.targetX = GLASS_LIGHT_HOME.x;
  glassLight.targetY = GLASS_LIGHT_HOME.y;
  if (document.body.dataset.theme === 'glass') {
    animateGlassLight();
  } else {
    if (glassLight.frame) cancelAnimationFrame(glassLight.frame);
    glassLight.frame = 0;
    glassLight.x = GLASS_LIGHT_HOME.x;
    glassLight.y = GLASS_LIGHT_HOME.y;
    island.style.setProperty('--glass-x', `${glassLight.x}%`);
    island.style.setProperty('--glass-y', `${glassLight.y}%`);
  }
}

function fill(n) {
  const app = n.app || 'Notification', h = hue(app);
  $('app').textContent = app;
  $('title').textContent = n.title || '';
  $('body').textContent = n.body || '';
  const av = $('avatar');
  const media = n.media || null;
  island.classList.toggle('media', !!media);
  av.textContent = media ? (media.artworkBase64 ? '' : '♫') : (app.trim().charAt(0).toUpperCase() || '?');
  const artworkUrl = media?.artworkBase64 ? `url(data:${media.artworkMimeType || 'image/jpeg'};base64,${media.artworkBase64})` : '';
  av.style.backgroundImage = artworkUrl;
  av.style.background = media?.artworkBase64
    ? `center / cover no-repeat ${artworkUrl}`
    : `linear-gradient(135deg, hsl(${h} 65% 55%), hsl(${(h + 45) % 360} 65% 38%))`;
  const mediaPlayPause = $('media-controls')?.querySelector?.('[data-media-action="playPause"]');
  if (mediaPlayPause) mediaPlayPause.textContent = media?.isPlaying ? 'Ⅱ' : '▶';
  updateBadge();
}

function updateBadge() { $('badge').textContent = queue.length ? `+${queue.length}` : ''; }

function run(dur) {
  let elapsed = 0, last = performance.now();
  cancelAnimationFrame(raf);
  const step = (now) => {
    if (!hovered) elapsed += now - last;
    last = now;
    ring.style.strokeDashoffset = RING * Math.min(elapsed / dur, 1);
    if (elapsed >= dur) return finish();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

function clearIdleHideTimer() {
  if (idleHideTimer) clearTimeout(idleHideTimer);
  idleHideTimer = 0;
}

function hideIfInactive() {
  idleHideTimer = 0;
  if (!idlePill) {
    if (!showing && queue.length === 0 && !hovered) {
      island.classList.add('hidden');
      window.island.setHit(false);
    }
    return;
  }

  if (autoHideMs <= 0) return;
  const idleFor = Date.now() - lastNotificationAt;
  const remaining = autoHideMs - idleFor;
  if (remaining > 0) {
    idleHideTimer = setTimeout(hideIfInactive, remaining);
    return;
  }

  // Keep the island visible while a notification is being read or the pointer
  // is over it. Re-check on mouseleave / after the active card finishes.
  if (showing || queue.length > 0 || hovered) {
    idleHideTimer = setTimeout(hideIfInactive, 500);
    return;
  }

  island.classList.add('hidden');
  window.island.setHit(false);
  report({ event: 'island-auto-hidden', idleFor });
}

function scheduleIdleHide() {
  clearIdleHideTimer();
  if (autoHideMs <= 0) return;
  if (!idlePill) {
    if (!showing && queue.length === 0 && !hovered) {
      island.classList.add('hidden');
      window.island.setHit(false);
    }
    return;
  }
  const remaining = Math.max(0, autoHideMs - (Date.now() - lastNotificationAt));
  idleHideTimer = setTimeout(hideIfInactive, remaining);
}

function next() {
  const n = queue.shift();
  if (!n) return idle();
  showing = true;
  fill(n);
  clearIdleHideTimer();
  island.classList.remove('hidden');
  requestAnimationFrame(() => { island.classList.add('open'); content.classList.add('in'); });
  run(Number(n.durationMs) || Math.min(9000, 3500 + ((n.title || '').length + (n.body || '').length) * 35));
}

function finish({ swipe = false } = {}) {
  cancelAnimationFrame(raf);
  if (swipe) {
    island.classList.remove('dragging', 'swiping');
    island.classList.add('swipe-dismiss');
  }
  content.classList.remove('in');
  island.classList.remove('open');
  window.island.setHit(hovered);
  setTimeout(() => {
    if (swipe) {
      island.classList.remove('swipe-dismiss');
      island.style.removeProperty('--swipe-y');
      island.style.removeProperty('--swipe-opacity');
    }
    showing = false;
    queue.length ? next() : idle();
  }, 450);
}

function resetSwipeVisuals() {
  island.classList.remove('dragging', 'swiping');
  island.style.removeProperty('--swipe-y');
  island.style.removeProperty('--swipe-opacity');
}

function onPointerDown(event) {
  if (!showing || !island.classList.contains('open') || event.isPrimary === false) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  pointerGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  island.classList.add('dragging');
  try { island.setPointerCapture(event.pointerId); } catch (_) { /* Pointer capture is best-effort. */ }
}

function onPointerMove(event) {
  if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
  const dx = event.clientX - pointerGesture.startX;
  const dy = event.clientY - pointerGesture.startY;
  if (Math.hypot(dx, dy) >= SWIPE_CLICK_GUARD_DISTANCE) pointerGesture.moved = true;

  if (dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.15) {
    const offset = Math.max(-110, dy);
    const fade = Math.max(0.12, 1 - Math.abs(offset) / 145);
    island.style.setProperty('--swipe-y', `${offset}px`);
    island.style.setProperty('--swipe-opacity', String((hovered ? 0.5 : 1) * fade));
    island.classList.add('swiping');
  } else {
    island.classList.remove('swiping');
    island.style.removeProperty('--swipe-y');
    island.style.removeProperty('--swipe-opacity');
  }
}

function onPointerUp(event) {
  if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
  const gesture = pointerGesture;
  pointerGesture = null;
  try { island.releasePointerCapture(event.pointerId); } catch (_) { /* Pointer capture may already be released. */ }

  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  const moved = Math.hypot(dx, dy) >= SWIPE_CLICK_GUARD_DISTANCE;
  const swipeUp = -dy >= SWIPE_DISMISS_DISTANCE && -dy > Math.abs(dx) * 1.15;

  if (moved) {
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
  }

  if (swipeUp && showing) {
    report({ event: 'notification-swipe-dismiss', distance: Math.round(-dy), queued: queue.length });
    finish({ swipe: true });
    return;
  }

  resetSwipeVisuals();
}

function onPointerCancel(event) {
  if (!pointerGesture || event.pointerId !== pointerGesture.pointerId) return;
  pointerGesture = null;
  resetSwipeVisuals();
}

function idle() {
  island.classList.remove('media');
  if (!idlePill) {
    clearIdleHideTimer();
    island.classList.add('hidden');
    window.island.setHit(false);
    return;
  }
  island.classList.remove('hidden');
  scheduleIdleHide();
}

island.addEventListener('mouseenter', (event) => {
  hovered = true;
  island.classList.add('hovered');
  window.island.setHit(true);
  updateGlassLightFromPointer(event);
  report({ event: 'island-hover', active: true });
});
island.addEventListener('mouseleave', () => {
  hovered = false;
  island.classList.remove('hovered');
  window.island.setHit(false);
  returnGlassLightHome();
  report({ event: 'island-hover', active: false });
  if (!showing && queue.length === 0) scheduleIdleHide();
});
island.addEventListener('pointerdown', onPointerDown);
island.addEventListener('pointermove', onPointerMove);
island.addEventListener('pointerup', onPointerUp);
island.addEventListener('pointercancel', onPointerCancel);
island.addEventListener('lostpointercapture', onPointerCancel);
(document.querySelectorAll?.('[data-media-action]') || []).forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.island.mediaCommand(button.dataset.mediaAction);
  });
});
island.addEventListener('click', (event) => {
  if (event?.target?.closest?.('[data-media-action]')) return;
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (showing) finish();
});
island.addEventListener('pointermove', updateGlassLightFromPointer);

window.island.onNotify((n) => {
  lastNotificationAt = Date.now();
  clearIdleHideTimer();
  island.classList.remove('hidden');
  report({ event: 'notification-received', app: n.app, title: n.title });
  queue.push(n);
  showing ? updateBadge() : next();
  scheduleIdleHide();
});
function applySettings(config) {
  const settings = config?.settings || config;
  if (!settings) return;
  if (settings.general) {
    idlePill = settings.general.idlePill !== false;
    autoHideMs = Math.max(0, Number(settings.general.autoHideSeconds ?? 30)) * 1000;
  } else if (typeof settings.idlePill === 'boolean') {
    idlePill = settings.idlePill;
  }
  if (settings.appearance) {
    const appearance = settings.appearance;
    document.body.dataset.theme = appearance.theme || 'midnight';
    if (document.body.dataset.theme !== 'glass') returnGlassLightHome();
    else {
      island.style.setProperty('--glass-x', `${glassLight.x}%`);
      island.style.setProperty('--glass-y', `${glassLight.y}%`);
    }
    activeUiMode = appearance.uiMode || 'system';
    applyUiMode();
    island.style.setProperty('--hover-opacity', String(Math.max(0.2, Math.min(1, Number(appearance.hoverOpacity) || 0.5))));
    island.style.setProperty('--island-accent', appearance.accentColor || '#8b9cff');
    ring.style.stroke = appearance.accentColor || '#8b9cff';
    island.style.setProperty('--animation-scale', String(Math.max(0.25, Math.min(2, Number(appearance.animationScale) || 1))));
    island.style.setProperty('--island-width', `${Math.max(360, Math.min(500, Number(appearance.islandWidth) || 440))}px`);
  }
  if (settings.display) $('stage').style.top = `${Math.max(0, Math.min(200, Number(settings.display.topOffset) || 0))}px`;
  report({ event: 'config-received', idlePill, autoHideMs, theme: settings.appearance?.theme || 'midnight' });
  if (!showing) idle();
  else scheduleIdleHide();
}

window.island.onConfig(applySettings);
idle();
window.island.ready({
  readyState: document.readyState,
  href: location.href,
  islandElement: !!island,
  contentElement: !!content,
  ringElement: !!ring,
});

})();
