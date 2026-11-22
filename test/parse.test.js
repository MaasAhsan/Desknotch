'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const { WinNotificationWatcher, parseToast, prettyApp, decode, inspectDatabase } = require('../src/winNotifications');

// The renderer shares the main world with the contextBridge property
// window.island. Keep its `const island` DOM reference inside a function
// scope so it cannot collide with that global bridge (or a DOM named property).
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
assert.match(rendererSource, /^\(\(\) => \{/);
assert.match(rendererSource.trimEnd(), /\}\)\(\);$/);
new vm.Script(rendererSource, { filename: 'renderer.js' });
const fakeElement = () => ({
  style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {},
});
const fakeElements = { island: fakeElement(), content: fakeElement(), ring: fakeElement() };
let rendererReadyDetails;
let rendererStarted = false;
const bridge = {
  log(item) { if (item.event === 'renderer-started') rendererStarted = true; },
  onNotify() {}, onConfig() {}, setHit() {},
  ready(details) { rendererReadyDetails = details; },
};
const browserWorld = {
  document: { readyState: 'complete', getElementById: (id) => fakeElements[id] || fakeElement() },
  navigator: { userAgent: 'renderer-smoke-test' },
  location: { href: 'file:///renderer/index.html' },
  setTimeout() { return 1; },
  clearTimeout() {},
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  addEventListener() {},
};
Object.defineProperty(browserWorld, 'island', { value: bridge, configurable: false });
browserWorld.window = browserWorld;
vm.runInNewContext(rendererSource, browserWorld, { filename: 'renderer.js' });
assert.strictEqual(browserWorld.window.island, bridge, 'renderer must not shadow the preload bridge');
assert.strictEqual(rendererStarted, true, 'renderer should log its startup');
assert.strictEqual(rendererReadyDetails?.islandElement, true, 'renderer should send its ready handshake');

// Renderer behavior test: hover is tracked, inactivity hides after 30 seconds,
// hovering postpones the hide, and a new notification reveals/resets the island.
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
assert.match(htmlSource, /#island\.hovered\s*\{\s*opacity:\s*var\(--hover-opacity,\s*\.5\);/, 'hover opacity should be configurable with a 50% default');
assert.match(htmlSource, /#island\.open\s*\{[^}]*width:\s*var\(--island-width,\s*440px\)/s, 'expanded width should be configurable');
assert.match(htmlSource, /#island\.hidden\s*\{[^}]*translateY\(-130px\)/s, 'hidden island should slide above the screen');
assert.match(htmlSource, /pointer-events:\s*auto/, 'collapsed pill must receive forwarded hover events');
assert.match(htmlSource, /#island\.swipe-dismiss[\s\S]*translateY\(-100px\)/, 'swipe dismissal should animate the card upward and fade it out');
assert.match(rendererSource, /GLASS_LIGHT_EASING\s*=\s*0\.16/, 'Glass lighting should ease toward the cursor rather than jump');
assert.match(rendererSource, /island\.addEventListener\('mouseleave',[\s\S]*returnGlassLightHome/, 'Glass lighting should drift home when the pointer leaves');
assert.match(htmlSource, /radial-gradient\(ellipse 58% 86% at var\(--glass-x/, 'Glass specular highlight should follow smoothed pointer coordinates');
assert.match(htmlSource, /touch-action:\s*none/, 'expanded notifications should accept touch swipes');

let fakeNow = 0;
let timerId = 0;
const timers = new Map();
function fakeSetTimeout(callback, delay = 0) {
  const id = ++timerId;
  timers.set(id, { at: fakeNow + Math.max(0, Number(delay) || 0), callback });
  return id;
}
function fakeClearTimeout(id) { timers.delete(id); }
function advanceClock(ms) {
  const target = fakeNow + ms;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!due) break;
    const [id, timer] = due;
    timers.delete(id);
    fakeNow = timer.at;
    timer.callback();
  }
  fakeNow = target;
}
class FakeDate extends Date { static now() { return fakeNow; } }
function interactiveElement() {
  const classes = new Set();
  const listeners = {};
  return {
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    }, textContent: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : !!force;
        if (shouldAdd) classes.add(name); else classes.delete(name);
        return shouldAdd;
      },
    },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); },
    getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 40 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    dispatch(name, event = {}) {
      for (const callback of listeners[name] || []) callback({ type: name, ...event });
    },
  };
}
const interactiveElements = Object.fromEntries(
  ['island', 'content', 'ring', 'stage', 'app', 'title', 'body', 'avatar', 'badge'].map((id) => [id, interactiveElement()]),
);
let notifyHandler, configHandler, scheduledGlassFrame = null, frameId = 0;
const hitChanges = [];
const testBridge = {
  log() {},
  onNotify(callback) { notifyHandler = callback; },
  onConfig(callback) { configHandler = callback; },
  setHit(hit) { hitChanges.push(hit); },
  ready() {},
};
const behaviorWorld = {
  window: null,
  document: { readyState: 'complete', body: { dataset: {} }, getElementById: (id) => interactiveElements[id] || interactiveElement() },
  navigator: { userAgent: 'renderer-behavior-test' },
  location: { href: 'file:///renderer/index.html' },
  Date: FakeDate,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  performance: { now: () => fakeNow },
  requestAnimationFrame(callback) { if (callback.length === 0) callback(); else scheduledGlassFrame = callback; return ++frameId; },
  cancelAnimationFrame() {},
  addEventListener() {},
};
behaviorWorld.window = behaviorWorld;
Object.defineProperty(behaviorWorld, 'island', { value: testBridge, configurable: false });
vm.runInNewContext(rendererSource, behaviorWorld, { filename: 'renderer-behavior.js' });
configHandler({ idlePill: true });
const islandElement = interactiveElements.island;
islandElement.dispatch('mouseenter');
assert.strictEqual(islandElement.classList.contains('hovered'), true, 'mouseenter should enable the hover state');
assert.strictEqual(hitChanges.at(-1), true, 'mouseenter should temporarily enable hit testing');
advanceClock(30_000);
assert.strictEqual(islandElement.classList.contains('hidden'), false, 'hovering should prevent auto-hide');
islandElement.dispatch('mouseleave');
assert.strictEqual(islandElement.classList.contains('hovered'), false, 'mouseleave should clear the hover state');
assert.strictEqual(hitChanges.at(-1), false, 'mouseleave should restore click-through behavior');
advanceClock(0);
assert.strictEqual(islandElement.classList.contains('hidden'), true, 'island should hide once it has been idle for 30 seconds');
notifyHandler({ app: 'Test', title: 'New notification', body: 'Hello' });
assert.strictEqual(islandElement.classList.contains('hidden'), false, 'a new notification should reveal the island');
islandElement.dispatch('click'); // Finish the test card without relying on real animation frames.
advanceClock(450);
advanceClock(29_549);
assert.strictEqual(islandElement.classList.contains('hidden'), false, 'the island should remain visible until 30 seconds after the new notification');
advanceClock(1);
assert.strictEqual(islandElement.classList.contains('hidden'), true, 'the inactivity timeout should reset from the latest notification');

// Upward swipe should dismiss the current card, suppress the synthetic click,
// and advance to the next queued notification.
notifyHandler({ app: 'First', title: 'Swipe this notification', body: 'Dismiss me' });
notifyHandler({ app: 'Second', title: 'Next notification', body: 'Show this next' });
assert.strictEqual(interactiveElements.title.textContent, 'Swipe this notification');
islandElement.dispatch('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 100 });
islandElement.dispatch('pointermove', { pointerId: 1, clientX: 102, clientY: 28 });
assert.strictEqual(islandElement.classList.contains('swiping'), true, 'upward pointer movement should preview the swipe');
islandElement.dispatch('pointerup', { pointerId: 1, clientX: 102, clientY: 28 });
assert.strictEqual(islandElement.classList.contains('swipe-dismiss'), true, 'a sufficiently large upward swipe should start the dismiss animation');
islandElement.dispatch('click'); // Consume the synthetic click generated after pointerup.
advanceClock(450);
assert.strictEqual(interactiveElements.title.textContent, 'Next notification', 'swiping should advance to the next queued notification');
assert.strictEqual(islandElement.classList.contains('open'), true, 'the next notification should be expanded');

// A short upward drag should not dismiss the card, and its generated click is ignored.
islandElement.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 100, clientY: 100 });
islandElement.dispatch('pointermove', { pointerId: 2, clientX: 100, clientY: 80 });
islandElement.dispatch('pointerup', { pointerId: 2, clientX: 100, clientY: 80 });
islandElement.dispatch('click');
assert.strictEqual(islandElement.classList.contains('open'), true, 'a short drag should leave the current notification open');
islandElement.dispatch('click'); // A normal click still dismisses.
advanceClock(450);

// Settings handshake should apply theme, hover opacity, width, accent and top offset.
configHandler({ settings: {
  general: { idlePill: true, autoHideSeconds: 45 },
  appearance: { theme: 'aurora', hoverOpacity: 0.7, accentColor: '#ff00aa', animationScale: 1.2, islandWidth: 480 },
  display: { topOffset: 24 },
} });
assert.strictEqual(behaviorWorld.document.body.dataset.theme, 'aurora');
assert.strictEqual(islandElement.style['--hover-opacity'], '0.7');
assert.strictEqual(islandElement.style['--island-width'], '480px');
assert.strictEqual(interactiveElements.ring.style.stroke, '#ff00aa');

assert.strictEqual(interactiveElements.stage.style.top, '24px');

// The Glass specular highlight eases part-way toward the pointer per frame,
// then glides back toward its resting point after pointer exit.
configHandler({ settings: { general: { idlePill: true, autoHideSeconds: 30 }, appearance: { theme: 'glass', uiMode: 'dark' } } });
islandElement.dispatch('pointermove', { clientX: 110, clientY: 50 });
assert.equal(typeof scheduledGlassFrame, 'function', 'Glass pointer movement should schedule a frame update');
const firstGlassFrame = scheduledGlassFrame;
scheduledGlassFrame = null;
firstGlassFrame(16);
const firstGlassX = Number.parseFloat(islandElement.style['--glass-x']);
assert.ok(firstGlassX > 28 && firstGlassX < 100, 'Glass highlight should move smoothly toward rather than snap to the pointer');
islandElement.dispatch('mouseleave');
assert.equal(typeof scheduledGlassFrame, 'function', 'leaving the notch should animate the highlight home');
const returnGlassFrame = scheduledGlassFrame;
scheduledGlassFrame = null;
returnGlassFrame(32);
const returningGlassX = Number.parseFloat(islandElement.style['--glass-x']);
assert.ok(returningGlassX < firstGlassX && returningGlassX > 28, 'Glass highlight should smoothly return toward its home position');

const xml = '<toast><visual><binding template="ToastGeneric"><text>Ana &amp; Budi</text><text>Lunch at 12?</text><text placement="attribution">via X</text></binding></visual></toast>';
assert.deepStrictEqual(parseToast(xml), { title: 'Ana & Budi', body: 'Lunch at 12? · via X' });
assert.strictEqual(prettyApp('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), 'WindowsCalculator');
assert.strictEqual(prettyApp('C:\\Apps\\Slack.exe'), 'Slack');
assert.strictEqual(prettyApp(null), 'Notification');
assert.strictEqual(decode(Buffer.from('<a/>', 'utf16le')), '<a/>');
assert.strictEqual(decode(Buffer.from('<a/>', 'utf8')), '<a/>');

// Regression test: Id is not an insertion cursor. An ON CONFLICT REPLACE can
// insert a fresh Order while reusing the same Id; the watcher must see it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-wpn-test-'));
const dbPath = path.join(dir, 'wpndatabase.db');
const writer = new DatabaseSync(dbPath);
writer.exec(`
  CREATE TABLE NotificationHandler (
    RecordId INTEGER PRIMARY KEY,
    PrimaryId TEXT NOT NULL
  );
  CREATE TABLE Notification (
    "Order" INTEGER NOT NULL PRIMARY KEY,
    Id INTEGER NOT NULL,
    HandlerId INTEGER,
    Type TEXT NOT NULL,
    Payload BLOB,
    PayloadType TEXT NOT NULL,
    UNIQUE(Id) ON CONFLICT REPLACE
  );
  INSERT INTO NotificationHandler (RecordId, PrimaryId) VALUES (7, 'Example.App_123!App');
`);
writer.prepare('INSERT INTO Notification ("Order", Id, HandlerId, Type, Payload, PayloadType) VALUES (?, ?, ?, ?, ?, ?)')
  .run(1, 500, 7, 'toast', Buffer.from(xml), 'Xml');

const logLines = [];
const emitted = [];
const watcher = new WinNotificationWatcher({
  dbPath,
  allowNonWindows: true,
  logger: (message, details) => logLines.push({ message, details }),
});
watcher.on('notification', (n) => emitted.push(n));
watcher.start();
assert.strictEqual(watcher.lastOrder, 1, 'startup cursor should use Order');
assert.strictEqual(emitted.length, 0, 'existing notifications should not replay on startup');

// Re-use Id=500, but insert at Order=2: MAX(Id) would remain 500 and miss it.
writer.prepare('INSERT INTO Notification ("Order", Id, HandlerId, Type, Payload, PayloadType) VALUES (?, ?, ?, ?, ?, ?)')
  .run(2, 500, 7, 'toast', Buffer.from(xml), 'Xml');
watcher._tick();
assert.strictEqual(emitted.length, 1, 'new Order must be delivered even when Id is reused');
assert.deepStrictEqual(emitted[0], { id: 'windows:2:500', source: 'windows', appId: 'Example.App_123!App', app: 'App', title: 'Ana & Budi', body: 'Lunch at 12? · via X', receivedAt: emitted[0].receivedAt });
assert(logLines.some((x) => x.message === 'new notification database row' && x.details.rawPayload), 'raw Payload should be logged');
watcher.stop();
writer.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('parse, SQLite watcher, and renderer behavior regression tests passed');
