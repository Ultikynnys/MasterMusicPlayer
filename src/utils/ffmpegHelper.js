const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const logger = require('./logger');
const dependencyManager = require('./dependencyManager');

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
        this.source = null; // 'custom' | 'managed' | 'bundled' | 'static'
        this.initialized = false;
    }

    getVendorPath() {
        if (!app.isPackaged) {
            return path.join(process.cwd(), 'src', 'vendor');
        }
        return path.join(path.dirname(app.getAppPath()), 'vendor');
    }

    getManagedPath() {
        return dependencyManager.getManagedDir(app.getPath('userData'));
    }

    getFFmpegExecutable() {
        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }

    getFFprobeExecutable() {
        return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    }

    /**
     * Initialize FFmpeg paths.
     * Priority: user-selected -> managed download -> bundled vendor -> static npm package.
     * @param {string|null} customFfmpegPath Optional user-selected ffmpeg executable.
     */
    async initialize(customFfmpegPath = null) {
        this.initialized = false;
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.source = null;

        try {
            logger.info('Starting FFmpeg initialization...');

            const ffmpegExec = this.getFFmpegExecutable();
            const ffprobeExec = this.getFFprobeExecutable();

            const locationSets = [
                { dir: customFfmpegPath ? path.dirname(customFfmpegPath) : null, source: 'custom', ffmpeg: customFfmpegPath },
                { dir: this.getManagedPath(), source: 'managed', ffmpeg: path.join(this.getManagedPath(), ffmpegExec) },
                { dir: this.getVendorPath(), source: 'bundled', ffmpeg: path.join(this.getVendorPath(), ffmpegExec) }
            ];

            for (const set of locationSets) {
                if (!set.ffmpeg) continue;
                if (!fs.existsSync(set.ffmpeg)) continue;

                if (process.platform !== 'win32') {
                    try { fs.chmodSync(set.ffmpeg, 0o755); } catch (e) { /* ignore */ }
                }

                if (await this.testBinary(set.ffmpeg, ['-version'])) {
                    this.ffmpegPath = set.ffmpeg;
                    this.source = set.source;

                    const probeCandidate = path.join(set.dir || path.dirname(set.ffmpeg), ffprobeExec);
                    if (fs.existsSync(probeCandidate)) {
                        if (process.platform !== 'win32') {
                            try { fs.chmodSync(probeCandidate, 0o755); } catch (e) { /* ignore */ }
                        }
                        if (await this.testBinary(probeCandidate, ['-version'])) {
                            this.ffprobePath = probeCandidate;
                        }
                    }

                    this.initialized = true;
                    logger.info(`FFmpeg initialized from ${set.source} binary: ${set.ffmpeg}`);
                    return;
                }
            }

            // Fallback: static npm packages (dev convenience)
            if (staticFFmpegPath && fs.existsSync(staticFFmpegPath)) {
                logger.info('Falling back to static FFmpeg package');
                if (await this.testBinary(staticFFmpegPath, ['-version'])) {
                    this.ffmpegPath = staticFFmpegPath;
                    this.ffprobePath = staticFFprobePath;
                    this.source = 'static';
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
            this.source = null;
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

    getFFmpegSource() {
        return this.source;
    }

    isAvailable() {
        return this.initialized && this.ffmpegPath;
    }
}

module.exports = new FFmpegHelper();
