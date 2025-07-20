const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
const logger = require('./logger');

let ytDlpPath = null;
let isReady = false;

function getVendorPath() {
    // In development, path is relative to the project root.
    if (!app.isPackaged) {
        return path.join(process.cwd(), 'src', 'vendor');
    }
    // In production, 'vendor' is copied to the resources directory.
    // app.getAppPath() points to 'resources/app.asar'. We need to go up one level.
    return path.join(path.dirname(app.getAppPath()), 'vendor');
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

async function ensureYtDlp() {
    logger.info('Ensuring yt-dlp is available from the bundled vendor directory...');

    const vendorDir = getVendorPath();
    const executableName = getPlatformExecutable();
    const bundledPath = path.join(vendorDir, executableName);

    logger.info(`Checking for bundled yt-dlp at: ${bundledPath}`);

    if (fs.existsSync(bundledPath)) {
        logger.info(`Found bundled yt-dlp: ${bundledPath}`);
        // On non-Windows platforms, we need to ensure the file is executable.
        if (process.platform !== 'win32') {
            try {
                fs.accessSync(bundledPath, fs.constants.X_OK);
            } catch (err) {
                logger.warn(`yt-dlp at ${bundledPath} is not executable. Attempting to set permissions...`);
                try {
                    fs.chmodSync(bundledPath, 0o755); // rwxr-xr-x
                    logger.info('Successfully set executable permissions on yt-dlp.');
                } catch (chmodErr) {
                    logger.error(`Fatal: Failed to set executable permissions on ${bundledPath}.`, { error: chmodErr.message });
                    dialog.showErrorBox('Permissions Error', `Could not set executable permissions on ${bundledPath}. The application cannot download tracks.`);
                    isReady = false;
                    ytDlpPath = null;
                    return;
                }
            }
        }
        ytDlpPath = bundledPath;
        isReady = true;
    } else {
        logger.error(`Fatal: Bundled yt-dlp not found at the expected path: ${bundledPath}.`);
        dialog.showErrorBox('Critical Error', `The yt-dlp executable was not found at ${bundledPath}. The application cannot function.`);
        isReady = false;
        ytDlpPath = null;
    }
}

function getYtDlpPath() {
    return ytDlpPath;
}

function isYtDlpReady() {
    return isReady;
}

module.exports = { ensureYtDlp, getYtDlpPath, isYtDlpReady };
