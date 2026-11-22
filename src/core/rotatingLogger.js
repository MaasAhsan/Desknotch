'use strict';

const fs = require('node:fs');
const path = require('node:path');

function appendRotatingLog(filePath, line, { maxBytes = 2 * 1024 * 1024, backups = 3 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = String(line);
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch (_) { /* File does not exist yet. */ }

  if (size + Buffer.byteLength(content, 'utf8') > maxBytes && size > 0) {
    for (let index = backups; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const destination = `${filePath}.${index}`;
      try {
        if (fs.existsSync(destination)) fs.unlinkSync(destination);
        if (fs.existsSync(source)) fs.renameSync(source, destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

module.exports = { appendRotatingLog };
