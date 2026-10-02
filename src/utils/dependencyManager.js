const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { extractZip } = require('./zipExtract');
const logger = require('./logger');

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const USER_AGENT = 'MasterMusicPlayer-DependencyManager';

function isWindows() {
  return process.platform === 'win32';
}

// Managed binaries live in <userData>/bin so they survive app updates.
function getManagedDir(userDataDir) {
  return path.join(userDataDir, 'bin');
}

function getYtDlpFilename() {
  return isWindows() ? 'yt-dlp.exe' : 'yt-dlp';
}

function getFfmpegFilename() {
  return isWindows() ? 'ffmpeg.exe' : 'ffmpeg';
}

function getFfprobeFilename() {
  return isWindows() ? 'ffprobe.exe' : 'ffprobe';
}

// ---- Global settings (settings-global.json next to the data path config) ----
function getGlobalSettingsPath(settingsBaseDir) {
  return path.join(settingsBaseDir, 'settings-global.json');
}

async function readGlobalSettings(settingsBaseDir) {
  const file = getGlobalSettingsPath(settingsBaseDir);
  try {
    if (await fs.pathExists(file)) {
      return await fs.readJson(file);
    }
  } catch (err) {
    logger.error('Failed to read global settings', err);
  }
  return {};
}

async function writeGlobalSettings(settingsBaseDir, patch) {
  const file = getGlobalSettingsPath(settingsBaseDir);
  let current = {};
  try {
    if (await fs.pathExists(file)) {
      current = await fs.readJson(file);
    }
  } catch (err) {
    logger.error('Failed to read global settings before write', err);
  }
  const next = { ...current, ...patch };
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, next, { spaces: 2 });
  return next;
}

// ---- Networking ----
function httpGet(url, { onResponse, onError }) {
  const follow = (currentUrl, redirects) => {
    if (redirects > 10) {
      onError(new Error(`Too many redirects while fetching ${url}`));
      return;
    }
    const lib = currentUrl.startsWith('http:') ? http : https;
    const req = lib.get(currentUrl, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        follow(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
        return;
      }
      if (status !== 200) {
        res.resume();
        onError(new Error(`HTTP ${status} for ${currentUrl}`));
        return;
      }
      onResponse(res);
    });
    req.on('error', onError);
  };
  follow(url, 0);
}

function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.ensureDir(path.dirname(destPath))
      .then(() => {
        httpGet(url, {
          onError: reject,
          onResponse: (res) => {
            const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
            let received = 0;
            const out = fs.createWriteStream(destPath);
            res.on('data', (chunk) => {
              received += chunk.length;
              if (onProgress) onProgress(received, total);
            });
            res.on('error', reject);
            out.on('error', reject);
            out.on('finish', () => out.close(() => resolve({ received, total })));
            res.pipe(out);
          }
        });
      })
      .catch(reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, {
      onError: reject,
      onResponse: (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { data += d; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseSums(text, filename) {
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === filename) {
      return m[1].toLowerCase();
    }
  }
  return null;
}

// Best-effort integrity check: a real mismatch throws, an unreachable sums
// file only logs (so an offline build of the checksum list never blocks install).
async function verifyChecksum(filePath, sumsUrl, filename, onLog) {
  try {
    const text = await fetchText(sumsUrl);
    const expected = parseSums(text, filename);
    if (!expected) {
      onLog(`No published checksum for ${filename}; skipping verification`);
      return true;
    }
    const actual = await sha256File(filePath);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${filename} (expected ${expected}, got ${actual})`);
    }
    onLog(`Verified sha256 for ${filename}`);
    return true;
  } catch (err) {
    if (/Checksum mismatch/.test(err.message)) {
      throw err;
    }
    onLog(`Could not verify ${filename}: ${err.message}`);
    return false;
  }
}

// ---- Version detection ----
function getBinaryVersion(binPath, args = ['--version']) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(binPath, args);
    } catch (err) {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* ignore */ }
      done(null);
    }, 10000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
      done(first || null);
    });
  });
}

function detectYtDlpVersion(binPath) {
  return getBinaryVersion(binPath, ['--version']);
}

function detectFfmpegVersion(binPath) {
  return getBinaryVersion(binPath, ['-version']);
}

// ---- Filesystem / extraction ----
async function findFileRecursive(rootDir, filename) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function extractArchive(archivePath, destDir, kind) {
  if (kind === 'zip') {
    return extractZip(archivePath, path.resolve(destDir));
  }
  if (kind === 'tar.xz') {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xJf', archivePath, '-C', destDir]);
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => reject(new Error(`tar not available: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed (code ${code}): ${err}`));
      });
    });
  }
  return Promise.reject(new Error(`Unsupported archive kind: ${kind}`));
}

// ---- Installers (pure: take explicit dirs so they run outside Electron) ----
async function installYtDlp({ managedDir, onProgress, onLog = () => {} }) {
  const filename = getYtDlpFilename();
  const url = `${YTDLP_BASE}/${filename}`;
  await fs.ensureDir(managedDir);
  const dest = path.join(managedDir, filename);
  const tmp = `${dest}.part`;
  onLog(`Downloading latest yt-dlp from ${url}`);
  await downloadToFile(url, tmp, onProgress);
  await verifyChecksum(tmp, `${YTDLP_BASE}/SHA2-256SUMS`, filename, onLog);
  await fs.move(tmp, dest, { overwrite: true });
  if (!isWindows()) {
    await fs.chmod(dest, 0o755);
  }
  const version = await detectYtDlpVersion(dest);
  onLog(`Installed yt-dlp ${version || '(unknown version)'}`);
  return { path: dest, version };
}

async function installFfmpeg({ managedDir, onProgress, onLog = () => {} }) {
  const archiveName = isWindows()
    ? 'ffmpeg-master-latest-win64-gpl.zip'
    : 'ffmpeg-master-latest-linux64-gpl.tar.xz';
  const kind = isWindows() ? 'zip' : 'tar.xz';
  const url = `${FFMPEG_BASE}/${archiveName}`;
  await fs.ensureDir(managedDir);
  const tmpRoot = path.join(managedDir, '.ffmpeg-extract');
  await fs.emptyDir(tmpRoot);
  const archivePath = path.join(tmpRoot, archiveName);
  onLog(`Downloading latest ffmpeg from ${url}`);
  await downloadToFile(url, archivePath, onProgress);
  await verifyChecksum(archivePath, `${FFMPEG_BASE}/checksums.sha256`, archiveName, onLog);
  onLog('Extracting ffmpeg archive...');
  await extractArchive(archivePath, tmpRoot, kind);

  const ffmpegSrc = await findFileRecursive(tmpRoot, getFfmpegFilename());
  const ffprobeSrc = await findFileRecursive(tmpRoot, getFfprobeFilename());
  if (!ffmpegSrc) {
    throw new Error('ffmpeg binary not found in the downloaded archive');
  }

  const ffmpegDest = path.join(managedDir, getFfmpegFilename());
  await fs.move(ffmpegSrc, ffmpegDest, { overwrite: true });
  let ffprobeDest = null;
  if (ffprobeSrc) {
    ffprobeDest = path.join(managedDir, getFfprobeFilename());
    await fs.move(ffprobeSrc, ffprobeDest, { overwrite: true });
  }
  if (!isWindows()) {
    await fs.chmod(ffmpegDest, 0o755);
    if (ffprobeDest) await fs.chmod(ffprobeDest, 0o755);
  }
  await fs.remove(tmpRoot).catch(() => {});
  const version = await detectFfmpegVersion(ffmpegDest);
  onLog(`Installed ffmpeg ${version || '(unknown version)'}`);
  return { ffmpegPath: ffmpegDest, ffprobePath: ffprobeDest, version };
}

module.exports = {
  getManagedDir,
  getYtDlpFilename,
  getFfmpegFilename,
  getFfprobeFilename,
  getGlobalSettingsPath,
  readGlobalSettings,
  writeGlobalSettings,
  downloadToFile,
  fetchText,
  sha256File,
  parseSums,
  getBinaryVersion,
  detectYtDlpVersion,
  detectFfmpegVersion,
  findFileRecursive,
  extractArchive,
  installYtDlp,
  installFfmpeg
};
