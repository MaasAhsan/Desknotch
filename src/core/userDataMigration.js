'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILES = [
  { from: 'settings.json', to: 'settings.json' },
  { from: 'island-history.db', to: 'desknotch-history.db', sqlite: true },
  { from: 'island-clipboard.db', to: 'desknotch-clipboard.db', sqlite: true },
  { from: 'island-calendar.db', to: 'desknotch-calendar.db', sqlite: true },
  { from: 'island.log', to: 'desknotch.log' },
  { from: 'island.log.1', to: 'desknotch.log.1' },
  { from: 'island.log.2', to: 'desknotch.log.2' },
];

function copyIfMissing(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.migration-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, destination);
    return true;
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* best-effort cleanup */ }
  }
}

/**
 * Copy (never move) prior Island data into Desknotch's user-data directory.
 * The previous app should be closed before first launch so SQLite WAL files
 * are quiescent. Legacy files remain untouched as a rollback copy.
 */
function migrateLegacyUserData({ appDataPath, targetPath, legacyDirectoryNames = ['island-notify', 'Island'], logger = () => {} }) {
  if (!appDataPath || !targetPath) throw new TypeError('appDataPath and targetPath are required');
  fs.mkdirSync(targetPath, { recursive: true });

  const candidates = [...new Set(legacyDirectoryNames.map((name) => path.join(appDataPath, name)))];
  const copied = [];
  const skipped = [];

  for (const item of DATA_FILES) {
    const destination = path.join(targetPath, item.to);
    if (fs.existsSync(destination)) {
      skipped.push(item.to);
      continue;
    }

    const sourceBase = candidates.map((folder) => path.join(folder, item.from)).find((candidate) => fs.existsSync(candidate));
    if (!sourceBase) continue;

    try {
      const didCopy = copyIfMissing(sourceBase, destination);
      if (didCopy) copied.push(item.to);
      if (item.sqlite && didCopy) {
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${sourceBase}${suffix}`;
          if (fs.existsSync(sidecar) && copyIfMissing(sidecar, `${destination}${suffix}`)) {
            copied.push(`${item.to}${suffix}`);
          }
        }
      }
    } catch (error) {
      logger('legacy user-data migration item failed', { file: item.from, error: error.message });
    }
  }

  if (copied.length) logger('legacy Island data copied to Desknotch', { copied, sourceDirectories: candidates });
  return { copied, skipped, sourceDirectories: candidates };
}

module.exports = { migrateLegacyUserData, DATA_FILES };
