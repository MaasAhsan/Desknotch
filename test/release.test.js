'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateLegacyUserData } = require('../src/core/userDataMigration');
const { appendRotatingLog } = require('../src/core/rotatingLogger');
const { patchManifestText } = require('../scripts/injectGlobalMediaCapability');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desknotch-release-test-'));
try {
  const appData = path.join(root, 'Roaming');
  const oldFolder = path.join(appData, 'island-notify');
  const newFolder = path.join(appData, 'Desknotch');
  fs.mkdirSync(oldFolder, { recursive: true });
  fs.writeFileSync(path.join(oldFolder, 'settings.json'), '{"schemaVersion":2}\n');
  fs.writeFileSync(path.join(oldFolder, 'island-history.db'), 'sqlite-db');
  fs.writeFileSync(path.join(oldFolder, 'island-history.db-wal'), 'wal-data');
  fs.writeFileSync(path.join(oldFolder, 'island-clipboard.db'), 'clipboard-db');
  fs.writeFileSync(path.join(oldFolder, 'island.log'), 'previous-log');

  const migrationLogs = [];
  const result = migrateLegacyUserData({ appDataPath: appData, targetPath: newFolder, logger: (message, details) => migrationLogs.push({ message, details }) });
  assert.ok(result.copied.includes('settings.json'));
  assert.ok(result.copied.includes('desknotch-history.db'));
  assert.ok(result.copied.includes('desknotch-history.db-wal'));
  assert.equal(fs.readFileSync(path.join(newFolder, 'desknotch-history.db'), 'utf8'), 'sqlite-db');
  assert.equal(fs.readFileSync(path.join(newFolder, 'desknotch-history.db-wal'), 'utf8'), 'wal-data');
  assert.equal(fs.readFileSync(path.join(oldFolder, 'island-history.db'), 'utf8'), 'sqlite-db', 'migration must preserve old data');
  assert.ok(migrationLogs.length > 0);

  fs.writeFileSync(path.join(newFolder, 'settings.json'), '{"new":true}\n');
  const second = migrateLegacyUserData({ appDataPath: appData, targetPath: newFolder });
  assert.ok(second.skipped.includes('settings.json'), 'migration must not overwrite existing Desknotch preferences');
  assert.equal(fs.readFileSync(path.join(newFolder, 'settings.json'), 'utf8'), '{"new":true}\n');

  const logFile = path.join(newFolder, 'rotate.log');
  appendRotatingLog(logFile, '12345', { maxBytes: 8, backups: 2 });
  appendRotatingLog(logFile, '67890', { maxBytes: 8, backups: 2 });
  assert.equal(fs.readFileSync(logFile, 'utf8'), '67890');
  assert.equal(fs.readFileSync(`${logFile}.1`, 'utf8'), '12345');

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'desknotch');
  assert.equal(packageJson.version, '1.3.0');
  assert.equal(packageJson.build.productName, 'Desknotch');
  assert.equal(packageJson.build.appId, 'com.desknotch.desktop');
  assert.ok(packageJson.dependencies['electron-updater']);
  assert.equal(packageJson.build.win.verifyUpdateCodeSignature, true);
  assert.equal(packageJson.build.appxManifestCreated, 'scripts/injectGlobalMediaCapability.js');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /fs\.mkdirSync\(desknotchUserDataPath, \{ recursive: true \}\);\s*app\.setPath\('userData', desknotchUserDataPath\)/, 'custom userData directory must exist before app.setPath');

  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const islandHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(renderer, /GLASS_LIGHT_EASING\s*=\s*0\.16/);
  assert.match(renderer, /updateGlassLightFromPointer/);
  assert.match(renderer, /returnGlassLightHome/);
  assert.match(islandHtml, /radial-gradient\(ellipse 58% 86% at var\(--glass-x/);

  const manifest = patchManifestText('<Package xmlns="urn:appx" IgnorableNamespaces="uap rescap"><Capabilities></Capabilities></Package>');
  assert.match(manifest, /xmlns:uap7="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/uap\/windows10\/7"/);
  assert.match(manifest, /IgnorableNamespaces="uap rescap uap7"/);
  assert.match(manifest, /<uap7:Capability Name="globalMediaControl" \/>/);

  const releaseWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(releaseWorkflow.includes('secrets.WIN_CSC_LINK'));
  assert.ok(releaseWorkflow.includes('SHA256SUMS.txt'));

  const releaseChecklist = fs.readFileSync(path.join(__dirname, '..', 'RELEASE_CHECKLIST.md'), 'utf8');
  assert.ok(releaseChecklist.includes('WIN_CSC_LINK'));

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const required of ['Desknotch', 'npm run check', 'npm test', 'GitHub Releases', 'user-data migration', 'Glass']) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }
  console.log('release migration, log rotation, Desknotch identity, Glass tracking and repository metadata tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
