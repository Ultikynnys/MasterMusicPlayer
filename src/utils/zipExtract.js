const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');

const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB guard against zip bombs

/**
 * Extract a zip archive into destDir.
 *
 * Hardened against the vulnerabilities that made `extract-zip` unfixable:
 * every entry is constrained to stay inside destDir (Zip Slip / absolute /
 * drive-relative paths), symlink entries are rejected outright, and total
 * uncompressed size is capped.
 *
 * @param {string} zipPath   Path to the .zip file.
 * @param {string} destDir   Destination directory (created if missing).
 * @param {object} [opts]
 * @param {(entry: string) => void} [opts.onEntry] Called per extracted entry name.
 * @returns {Promise<void>}
 */
function extractZip(zipPath, destDir, opts = {}) {
  const root = path.resolve(destDir);
  const onEntry = typeof opts.onEntry === 'function' ? opts.onEntry : () => {};

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr) {
        reject(openErr);
        return;
      }

      let settled = false;
      let totalBytes = 0;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (e) { /* already closed */ }
        if (err) reject(err);
        else resolve();
      };

      zipfile.on('entry', (entry) => {
        const name = entry.fileName;

        // Reject traversal segments and anything that would resolve outside root.
        const segments = name.split(/[\\/]/);
        const target = path.resolve(root, name);
        if (segments.includes('..') || (target !== root && !target.startsWith(root + path.sep))) {
          finish(new Error(`Zip entry escapes destination: ${name}`));
          return;
        }

        // Reject symlinks (the extract-zip advisories were symlink writes).
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000) {
          finish(new Error(`Symlink zip entry is not allowed: ${name}`));
          return;
        }

        if (/[\\/]$/.test(name)) {
          fs.mkdir(target, { recursive: true }, (err) => {
            if (err) return finish(err);
            onEntry(name);
            zipfile.readEntry();
          });
          return;
        }

        totalBytes += entry.uncompressedSize || 0;
        if (totalBytes > MAX_TOTAL_BYTES) {
          finish(new Error('Zip archive exceeds the maximum allowed uncompressed size'));
          return;
        }

        fs.mkdir(path.dirname(target), { recursive: true }, (err) => {
          if (err) return finish(err);
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) return finish(streamErr);
            const writeStream = fs.createWriteStream(target);
            readStream.on('error', finish);
            writeStream.on('error', (writeErr) => {
              readStream.destroy();
              finish(writeErr);
            });
            writeStream.on('finish', () => {
              onEntry(name);
              zipfile.readEntry();
            });
            readStream.pipe(writeStream);
          });
        });
      });

      zipfile.on('end', () => finish());
      zipfile.on('error', finish);
      zipfile.readEntry();
    });
  });
}

module.exports = { extractZip };
