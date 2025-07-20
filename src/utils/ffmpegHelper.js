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
                logger.warn('Static FFmpeg packages not loaded', {
                    staticFFmpegPath,
                    staticFFprobePath
                });
            }
            
            // Try fallback paths in multiple locations
            logger.info('Trying fallback FFmpeg paths...');
            
            const possiblePaths = [];
            
            // 1. Try vendor directory
            const appPath = process.resourcesPath || path.join(__dirname, '..', '..');
            const vendorPath = path.join(appPath, 'src', 'vendor');
            possiblePaths.push({
                ffmpeg: path.join(vendorPath, 'ffmpeg.exe'),
                ffprobe: path.join(vendorPath, 'ffprobe.exe'),
                name: 'vendor directory'
            });
            
            // 2. Try node_modules paths (for packaged app)
            if (process.resourcesPath) {
                // In packaged app, try app.asar/node_modules
                const packagedNodeModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
                possiblePaths.push({
                    ffmpeg: path.join(packagedNodeModules, 'ffmpeg-static', 'ffmpeg.exe'),
                    ffprobe: path.join(packagedNodeModules, 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
                    name: 'packaged node_modules (asar)'
                });
                
                // Try app.asar.unpacked/node_modules
                const unpackedNodeModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
                possiblePaths.push({
                    ffmpeg: path.join(unpackedNodeModules, 'ffmpeg-static', 'ffmpeg.exe'),
                    ffprobe: path.join(unpackedNodeModules, 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
                    name: 'unpacked node_modules'
                });
            }
            
            // 3. Try relative to current directory
            const currentDir = path.join(__dirname, '..', '..');
            const devNodeModules = path.join(currentDir, 'node_modules');
            possiblePaths.push({
                ffmpeg: path.join(devNodeModules, 'ffmpeg-static', 'ffmpeg.exe'),
                ffprobe: path.join(devNodeModules, 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
                name: 'development node_modules'
            });
            
            for (const pathSet of possiblePaths) {
                logger.info(`Checking ${pathSet.name}`, {
                    ffmpegPath: pathSet.ffmpeg,
                    ffprobePath: pathSet.ffprobe
                });
                
                if (fs.existsSync(pathSet.ffmpeg) && fs.existsSync(pathSet.ffprobe)) {
                    logger.info(`Found FFmpeg binaries in ${pathSet.name}, testing...`);
                    
                    const ffmpegWorks = await this.testBinary(pathSet.ffmpeg, ['-version']);
                    const ffprobeWorks = await this.testBinary(pathSet.ffprobe, ['-version']);
                    
                    if (ffmpegWorks && ffprobeWorks) {
                        this.ffmpegPath = pathSet.ffmpeg;
                        this.ffprobePath = pathSet.ffprobe;
                        this.initialized = true;
                        logger.info(`FFmpeg initialized successfully using ${pathSet.name}`, { 
                            ffmpegPath: this.ffmpegPath, 
                            ffprobePath: this.ffprobePath 
                        });
                        return;
                    } else {
                        logger.warn(`FFmpeg binaries in ${pathSet.name} not working`, {
                            ffmpegWorks,
                            ffprobeWorks
                        });
                    }
                } else {
                    logger.debug(`FFmpeg binaries not found in ${pathSet.name}`, {
                        ffmpegExists: fs.existsSync(pathSet.ffmpeg),
                        ffprobeExists: fs.existsSync(pathSet.ffprobe)
                    });
                }
            }
            
            // Final fallback: set paths to null
            this.ffmpegPath = null;
            this.ffprobePath = null;
            this.initialized = false;
            
            logger.warn('FFmpeg not available - some features may not work properly');
            
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
