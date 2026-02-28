const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const logger = require('./logger');

// Use static FFmpeg binaries from npm packages as fallback for dev
let staticFFmpegPath, staticFFprobePath;
try {
    staticFFmpegPath = require('ffmpeg-static');
    staticFFprobePath = require('ffprobe-static').path;
} catch (error) {
    logger.warn('Static FFmpeg packages not available', error.message);
}

class FFmpegHelper {
    constructor() {
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.initialized = false;
    }

    getVendorPath() {
        if (!app.isPackaged) {
            return path.join(process.cwd(), 'src', 'vendor');
        }
        return path.join(path.dirname(app.getAppPath()), 'vendor');
    }

    getFFmpegExecutable() {
        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }

    getFFprobeExecutable() {
        return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    }

    /**
     * Initialize FFmpeg paths using bundled binaries or static packages
     */
    async initialize() {
        if (this.initialized) return;

        try {
            logger.info('Starting FFmpeg initialization...');

            const vendorDir = this.getVendorPath();
            const ffmpegExec = this.getFFmpegExecutable();
            const ffprobeExec = this.getFFprobeExecutable();

            const bundledFFmpegPath = path.join(vendorDir, ffmpegExec);
            const bundledFFprobePath = path.join(vendorDir, ffprobeExec);

            // Priority 1: Check for bundled binaries in vendor directory
            if (fs.existsSync(bundledFFmpegPath)) {
                logger.info(`Found bundled FFmpeg at: ${bundledFFmpegPath}`);

                // Ensure executable on non-Windows
                if (process.platform !== 'win32') {
                    try {
                        fs.chmodSync(bundledFFmpegPath, 0o755);
                    } catch (e) {
                        logger.warn('Failed to set permissions on bundled FFmpeg', e.message);
                    }
                }

                const ffmpegWorks = await this.testBinary(bundledFFmpegPath, ['-version']);
                if (ffmpegWorks) {
                    this.ffmpegPath = bundledFFmpegPath;

                    // Try to find ffprobe too, but it's optional
                    if (fs.existsSync(bundledFFprobePath)) {
                        if (process.platform !== 'win32') {
                            try { fs.chmodSync(bundledFFprobePath, 0o755); } catch (e) { }
                        }
                        if (await this.testBinary(bundledFFprobePath, ['-version'])) {
                            this.ffprobePath = bundledFFprobePath;
                        }
                    }

                    this.initialized = true;
                    logger.info('FFmpeg initialized successfully using bundled binaries');
                    return;
                }
            }

            // Priority 2: Fallback to static packages if available
            if (staticFFmpegPath && fs.existsSync(staticFFmpegPath)) {
                logger.info('Falling back to static FFmpeg package');
                if (await this.testBinary(staticFFmpegPath, ['-version'])) {
                    this.ffmpegPath = staticFFmpegPath;
                    this.ffprobePath = staticFFprobePath;
                    this.initialized = true;
                    logger.info('FFmpeg initialized successfully using static packages');
                    return;
                }
            }

            logger.error('No working FFmpeg binary found');
            this.initialized = false;

        } catch (error) {
            logger.error('FFmpeg initialization failed', { error: error.message, stack: error.stack });
            this.ffmpegPath = null;
            this.ffprobePath = null;
            this.initialized = false;
        }
    }

    /**
     * Test if a binary works
     */
    testBinary(binaryPath, args) {
        return new Promise((resolve) => {
            const command = `"${binaryPath}" ${args.join(' ')}`;
            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    logger.warn('Binary test failed', { binaryPath, error: error.message });
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    getFFmpegPath() {
        return this.ffmpegPath;
    }

    getFFprobePath() {
        return this.ffprobePath;
    }

    isAvailable() {
        return this.initialized && this.ffmpegPath;
    }
}

module.exports = new FFmpegHelper();

