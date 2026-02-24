const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Use static FFmpeg binaries from npm packages
let staticFFmpegPath, staticFFprobePath;
try {
    staticFFmpegPath = require('ffmpeg-static');
    staticFFprobePath = require('ffprobe-static').path;
    logger.info('Static FFmpeg packages loaded', {
        ffmpegPath: staticFFmpegPath,
        ffprobePath: staticFFprobePath
    });
} catch (error) {
    logger.warn('Static FFmpeg packages not available', error.message);
}

class FFmpegHelper {
    constructor() {
        this.ffmpegPath = null;
        this.ffprobePath = null;
        this.initialized = false;
    }



    /**
     * Initialize FFmpeg paths using static packages
     */
    async initialize() {
        if (this.initialized) return;

        try {
            logger.info('Starting FFmpeg initialization...');

            // Use static packages if available
            if (staticFFmpegPath && staticFFprobePath) {
                logger.info('Testing static FFmpeg packages...', {
                    ffmpegPath: staticFFmpegPath,
                    ffprobePath: staticFFprobePath
                });

                // Check if files exist
                const ffmpegExists = fs.existsSync(staticFFmpegPath);
                const ffprobeExists = fs.existsSync(staticFFprobePath);

                logger.info('FFmpeg file existence check', {
                    ffmpegExists,
                    ffprobeExists
                });

                if (ffmpegExists && ffprobeExists) {
                    this.ffmpegPath = staticFFmpegPath;
                    this.ffprobePath = staticFFprobePath;

                    // Verify the binaries work
                    logger.info('Testing FFmpeg binaries...');
                    const ffmpegWorks = await this.testBinary(this.ffmpegPath, ['-version']);
                    const ffprobeWorks = await this.testBinary(this.ffprobePath, ['-version']);

                    logger.info('FFmpeg binary test results', {
                        ffmpegWorks,
                        ffprobeWorks
                    });

                    if (ffmpegWorks && ffprobeWorks) {
                        this.initialized = true;
                        logger.info('FFmpeg initialized successfully using static packages', {
                            ffmpegPath: this.ffmpegPath,
                            ffprobePath: this.ffprobePath
                        });
                        return;
                    } else {
                        logger.warn('Static FFmpeg binaries not working properly', {
                            ffmpegWorks,
                            ffprobeWorks
                        });
                    }
                } else {
                    logger.warn('Static FFmpeg binaries not found on filesystem', {
                        ffmpegExists,
                        ffprobeExists,
                        ffmpegPath: staticFFmpegPath,
                        ffprobePath: staticFFprobePath
                    });
                }
            } else {
                logger.error('Static FFmpeg packages not loaded - cannot initialize FFmpeg');
                this.ffmpegPath = null;
                this.ffprobePath = null;
                this.initialized = false;
                throw new Error('Static FFmpeg packages not loaded');
            }

        } catch (error) {
            logger.error('FFmpeg initialization failed', { error: error.message, stack: error.stack });

            // Set paths to null so other parts of the app know FFmpeg is not available
            this.ffmpegPath = null;
            this.ffprobePath = null;
            this.initialized = false;

            // Don't throw - let the app continue without FFmpeg
            logger.warn('Continuing without FFmpeg - some features may not work properly');
        }
    }



    /**
     * Test if a binary works
     */
    testBinary(binaryPath, args) {
        return new Promise((resolve) => {
            const command = `"${binaryPath}" ${args.join(' ')}`;
            logger.debug('Testing binary', { command });

            exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    logger.warn('Binary test failed', {
                        binaryPath,
                        command,
                        error: error.message,
                        stderr: stderr?.substring(0, 200)
                    });
                    resolve(false);
                } else {
                    logger.debug('Binary test successful', {
                        binaryPath,
                        stdout: stdout?.substring(0, 100)
                    });
                    resolve(true);
                }
            });
        });
    }

    /**
     * Get FFmpeg path
     */
    getFFmpegPath() {
        return this.ffmpegPath;
    }

    /**
     * Get FFprobe path
     */
    getFFprobePath() {
        return this.ffprobePath;
    }

    /**
     * Check if FFmpeg is available
     */
    isAvailable() {
        return this.initialized && this.ffmpegPath && this.ffprobePath;
    }
}

// Export singleton instance
module.exports = new FFmpegHelper();
