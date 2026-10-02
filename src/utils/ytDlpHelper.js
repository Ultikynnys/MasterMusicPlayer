const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const logger = require('./logger');
const dependencyManager = require('./dependencyManager');

let ytDlpPath = null;
let isReady = false;
let source = null; // 'custom' | 'managed' | 'bundled'

function getVendorPath() {
  // In development, path is relative to the project root.
  if (!app.isPackaged) {
    return path.join(process.cwd(), 'src', 'vendor');
  }
  // In production, 'vendor' is copied to the resources directory.
  // app.getAppPath() points to 'resources/app.asar'. We need to go up one level.
  return path.join(path.dirname(app.getAppPath()), 'vendor');
}

function getManagedPath() {
  return dependencyManager.getManagedDir(app.getPath('userData'));
}

function getPlatformExecutable() {
  const platform = process.platform;
  if (platform === 'win32') {
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') {
    return 'yt-dlp_macos';
  }
  return 'yt-dlp'; // For Linux
}

function isUsableFile(candidate) {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch (err) {
    return false;
  }
}

function ensureExecutable(filePath) {
  // On non-Windows platforms the binary must be executable.
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (err) {
    try {
      fs.chmodSync(filePath, 0o755); // rwxr-xr-x
      logger.info(`Set executable permissions on yt-dlp: ${filePath}`);
      return true;
    } catch (chmodErr) {
      logger.error(`Failed to set executable permissions on ${filePath}`, chmodErr);
      return false;
    }
  }
}

/**
 * Resolve yt-dlp in priority order: user-selected -> managed download -> bundled vendor.
 * @param {string|null} customPath Optional user-selected executable.
 */
async function ensureYtDlp(customPath = null) {
  logger.info('Resolving yt-dlp binary...');

  const executableName = getPlatformExecutable();
  const candidates = [
    { filePath: customPath, source: 'custom' },
    { filePath: path.join(getManagedPath(), executableName), source: 'managed' },
    { filePath: path.join(getVendorPath(), executableName), source: 'bundled' }
  ];

  let chosen = null;
  for (const candidate of candidates) {
    if (isUsableFile(candidate.filePath)) {
      if (candidate.source === 'custom' && !ensureExecutable(candidate.filePath)) {
        logger.warn(`Custom yt-dlp at ${candidate.filePath} is not usable; falling back.`);
        continue;
      }
      chosen = candidate;
      break;
    }
    if (candidate.filePath) {
      logger.warn(`yt-dlp candidate not found (${candidate.source}): ${candidate.filePath}`);
    }
  }

  if (!chosen) {
    logger.error('No yt-dlp binary found (custom, managed and bundled locations are all missing).');
    ytDlpPath = null;
    source = null;
    isReady = false;
    return;
  }

  if (chosen.source === 'managed' && !ensureExecutable(chosen.filePath)) {
    logger.error(`Managed yt-dlp at ${chosen.filePath} is not executable.`);
    ytDlpPath = null;
    source = null;
    isReady = false;
    return;
  }

  ytDlpPath = chosen.filePath;
  source = chosen.source;
  isReady = true;
  logger.info(`yt-dlp resolved: ${ytDlpPath} (source: ${source})`);
}

function getYtDlpPath() {
  return ytDlpPath;
}

function isYtDlpReady() {
  return isReady;
}

function getYtDlpSource() {
  return source;
}

module.exports = { ensureYtDlp, getYtDlpPath, isYtDlpReady, getYtDlpSource };
