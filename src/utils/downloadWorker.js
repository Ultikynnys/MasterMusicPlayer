const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

const workerId = process.env.WORKER_ID || 'unknown';
const ytDlpPath = process.env.YT_DLP_PATH;
const ffmpegPath = process.env.FFMPEG_PATH;

// Helper: spawn with promise
function spawnPromise(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, options);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => stdout += d.toString());
        child.stderr.on('data', (d) => stderr += d.toString());

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject({ code, stdout, stderr });
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

// Handle messages from the main process
process.on('message', async (task) => {
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Received message:`, data: task });
  try {
    if (task.type === 'downloadTrack') {
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Starting downloadTrack for:`, data: task.trackInfo.title });
      logger.info(`Worker ${workerId} starting download:`, { title: task.trackInfo.title });
      const result = await downloadTrack(task.trackInfo, task.songsPath, task.taskId, task.cookiesPath);
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Download completed successfully:`, data: result.name });
      
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Sending completion message for task:`, data: task.taskId });
      process.send({
        type: 'completed',
        taskId: task.taskId,
        result: result
      });
    }
  } catch (error) {
    process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] Error processing task:`, data: error.message });
    logger.error(`Worker ${workerId} error processing task:`, { error: error.message, taskId: task.taskId });
    process.send({
      type: 'failed',
      taskId: task.taskId,
      error: {
        message: error.message,
        stack: error.stack
      }
    });
  }
});

async function downloadTrack(initialTrackInfo, songsPath, taskId, cookiesPath) {
  const workerId = process.env.WORKER_ID || 'unknown';
  const startTime = Date.now();
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] downloadTrack() called with:`, data: { title: initialTrackInfo.title, songsPath, taskId } });
  logger.info(`Worker ${workerId} starting track download`, { title: initialTrackInfo.title });
  const trackUrl = initialTrackInfo.webpage_url || initialTrackInfo.url;

  // --- Step 1: Fetch full metadata for the single track ---
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Step 1: Getting metadata for:`, data: initialTrackInfo.url });
  // Try multiple bypass strategies for age-restricted content
  const metadataArgs = [
    '--dump-single-json',
    '--no-playlist',
    '--retries', '8',
    '--fragment-retries', '8',
    '--sleep-interval', '2',
    '--max-sleep-interval', '15',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Maximum age restriction bypass options
    '--age-limit', '99',
    '--extractor-args', 'youtube:player_client=android,web,tv_embedded,mweb,ios',
    '--extractor-args', 'youtube:skip=hls,dash,translated_subs',
    '--extractor-args', 'youtube:innertube_host=studio.youtube.com',
    '--extractor-args', 'youtube:player_skip=configs,webpage,js',
    '--extractor-args', 'youtube:include_live_dash=false',
    '--no-check-certificates',
    '--geo-bypass',
    '--ignore-errors',
    '--no-warnings',
    trackUrl
  ];
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Metadata args:`, data: metadataArgs });

  if (!ytDlpPath) {
    throw new Error('yt-dlp path is not available in worker environment. The download cannot proceed.');
  }
  let trackInfo;
  
  // Store cookies path for potential use later
  const cookiesFilePath = cookiesPath || path.join(path.dirname(songsPath), 'cookies.txt');
  let cookiesFileUsed = false;

  // Priority 1: Try enhanced bypass first (without cookies)
  try {
    const result = await spawnPromise(ytDlpPath, metadataArgs);
    trackInfo = JSON.parse(result.stdout);
    process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Metadata fetched successfully with enhanced bypass` });
  } catch (firstError) {
    // Check if this is an age restriction error that might be solved with cookies
    const isAgeRestricted = firstError.stderr && (
      firstError.stderr.includes('Sign in to confirm your age') ||
      firstError.stderr.includes('age-restricted') ||
      firstError.stderr.includes('inappropriate for some users')
    );
    
    if (isAgeRestricted && await fs.pathExists(cookiesFilePath)) {
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Age restriction detected, trying with cookies.txt at ${cookiesFilePath}` });
      
      try {
        const cookieFileArgs = [
          '--dump-single-json',
          '--no-playlist',
          '--cookies', cookiesFilePath,
          trackUrl
        ];
        const cookieResult = await spawnPromise(ytDlpPath, cookieFileArgs);
        trackInfo = JSON.parse(cookieResult.stdout);
        cookiesFileUsed = true;
        process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Metadata fetched successfully with cookies.txt for age-restricted content` });
      } catch (cookieError) {
        process.send({ type: 'log', level: 'warn', message: `[Worker ${workerId}] Cookies.txt failed for age-restricted content. Skipping this track.`, data: { error: cookieError.message } });
        
        // Create specific error for age-restricted content with invalid cookies
        // Mark as skippable so playlist downloads can continue
        const error = new Error('AGE_RESTRICTED_SKIP: This video is age-restricted and requires valid YouTube cookies. Skipping track.');
        error.isAgeRestricted = true;
        error.shouldSkip = true;
        throw error;
      }
    } else if (isAgeRestricted) {
      // Age-restricted but no cookies available - skip immediately
      process.send({ type: 'log', level: 'warn', message: `[Worker ${workerId}] Age-restricted content detected but no cookies.txt available. Skipping this track.` });
      
      const error = new Error('AGE_RESTRICTED_SKIP: This video is age-restricted and requires valid YouTube cookies. No cookies.txt found. Skipping track.');
      error.isAgeRestricted = true;
      error.shouldSkip = true;
      throw error;
    } else {
      // Not age-restricted, try browser cookies as fallback
      process.send({ type: 'log', level: 'warn', message: `[Worker ${workerId}] Enhanced bypass failed, trying browser cookies`, data: { error: firstError.message } });
      
      // Priority 2: Try with browser cookies
      const fallbackArgs = [
        '--dump-single-json',
        '--no-playlist',
        '--retries', '3',
        '--cookies-from-browser', 'firefox',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
        trackUrl
      ];

      // Priority 3: Try Firefox cookies
      try {
        const fallbackResult = await spawnPromise(ytDlpPath, fallbackArgs);
        trackInfo = JSON.parse(fallbackResult.stdout);
        process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Metadata fetched successfully with Firefox cookies` });
      } catch (secondError) {
        process.send({ type: 'log', level: 'warn', message: `[Worker ${workerId}] Firefox cookies failed, trying Chrome cookies`, data: { error: secondError.message } });
        
        const chromeArgs = [
          '--dump-single-json',
          '--no-playlist',
          '--retries', '3',
          '--cookies-from-browser', 'chrome',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          trackUrl
        ];
        
        try {
          const chromeResult = await spawnPromise(ytDlpPath, chromeArgs);
          trackInfo = JSON.parse(chromeResult.stdout);
          process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Metadata fetched successfully with Chrome cookies` });
        } catch (thirdError) {
          // Check if any of the errors indicate age restriction
          const errors = [firstError, secondError, thirdError];
          const isAgeRestricted = errors.some(err => 
            err && err.stderr && (
              err.stderr.includes('Sign in to confirm your age') ||
              err.stderr.includes('age-restricted') ||
              err.stderr.includes('inappropriate for some users')
            )
          );
          
          let finalErrorMessage;
          if (isAgeRestricted) {
            finalErrorMessage = 'AGE_RESTRICTED: This video requires valid YouTube cookies to download.';
          } else {
            // Assume it's likely age-restricted since that's the most common cause
            finalErrorMessage = 'AGE_RESTRICTED: Failed to download this video. This is likely due to age restrictions and requires valid YouTube cookies.';
          }
          
          logger.error(`Worker ${workerId} failed to fetch metadata with all strategies.`, {
            firstError: firstError.message,
            secondError: secondError.message,
            thirdError: thirdError.message,
            stderr: thirdError.stderr,
            isAgeRestricted
          });
          
          process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] ${finalErrorMessage}` });
          
          // Create error with specific type for better handling
          const error = new Error(finalErrorMessage);
          error.isAgeRestricted = isAgeRestricted;
          throw error;
        }
      }
    }
  }

  // --- Step 2: Perform the actual download ---
  const finalFilename = path.join(songsPath, `${trackInfo.title.replace(/[\/\:*?"<>|]/g, '_')}.mp3`);
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Step 2: Download setup:`, data: { finalFilename, url: trackInfo.webpage_url } });
  const downloadArgs = [
    '-x', // Extract audio
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '--retries', '8',
    '--fragment-retries', '8',
    '--sleep-interval', '2',
    '--max-sleep-interval', '15',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Maximum age restriction bypass options
    '--age-limit', '99',
    '--extractor-args', 'youtube:player_client=android,web,tv_embedded,mweb,ios',
    '--extractor-args', 'youtube:skip=hls,dash,translated_subs',
    '--extractor-args', 'youtube:innertube_host=studio.youtube.com',
    '--extractor-args', 'youtube:player_skip=configs,webpage,js',
    '--extractor-args', 'youtube:include_live_dash=false',
    '--no-check-certificates',
    '--geo-bypass',
    '--ignore-errors',
    '--no-warnings',
    '-o', finalFilename,
    trackUrl
  ];
  
  // Only attach cookies to download if they were used successfully for metadata
  if (cookiesFileUsed) {
    process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Using cookies.txt for download since metadata required them` });
    // Insert right before the URL (which is the last element)
    downloadArgs.splice(-1, 0, '--cookies', cookiesFilePath);
  } else {
    process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Not using cookies for download - metadata was fetched without them` });
  }

  // Add ffmpeg location if available
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] FFmpeg path from env:`, data: ffmpegPath });
  if (ffmpegPath) {
    downloadArgs.splice(-1, 0, '--ffmpeg-location', ffmpegPath);
    process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Added ffmpeg location to args:`, data: ffmpegPath });
  } else {
    process.send({ type: 'log', level: 'warn', message: `[Worker ${workerId}] No FFmpeg path available - yt-dlp may fail for audio extraction` });
  }
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Download args:`, data: downloadArgs });

  logger.info(`Worker ${workerId} starting ffmpeg download...`, { path: finalFilename });

  // Use a custom spawn wrapper for download that handles progress reporting
  await new Promise((resolve, reject) => {
    const attemptDownload = (attempt = 0, maxAttempts = 5) => {
      if (!ytDlpPath) {
        return reject(new Error('yt-dlp path is not available for the final download step.'));
      }
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Spawning yt-dlp process (attempt ${attempt + 1})` });
      const downloadProcess = spawn(ytDlpPath, downloadArgs);
      let stderr = '';
      let lastProgress = 0;
      process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Process spawned, PID:`, data: downloadProcess.pid });

      downloadProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderr += output;
        
        // Debug: log all stderr output to see what yt-dlp actually sends
        process.send({ type: 'log', level: 'debug', message: `[Worker ${workerId}] yt-dlp stderr:`, data: output.trim() });
        
        const progressMatch = output.match(/\s(\d{1,3}(\.\d)?)%/);
        if (progressMatch) {
          const progress = parseFloat(progressMatch[1]);
          process.send({ type: 'log', level: 'debug', message: `[Worker ${workerId}] Progress parsed: ${progress}%` });
          if (progress > lastProgress) {
            lastProgress = progress;
            process.send({ type: 'log', level: 'debug', message: `[Worker ${workerId}] Sending progress: ${progress}%` });
            process.send({ type: 'progress', taskId, progress });
          }
        }
      });

      downloadProcess.on('close', (code) => {
        process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Download process closed with code:`, data: code });
        if (code === 0) {
          process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Download successful!` });
          resolve();
        } else {
          process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] Download failed with code ${code}, stderr:`, data: stderr.substring(0, 200) });
          logger.warn(`Worker ${workerId} download failed (attempt ${attempt + 1}). Code: ${code}`, { stderr });
          if (attempt < maxAttempts - 1) {
            setTimeout(() => attemptDownload(attempt + 1), 2000 * (attempt + 1));
          } else {
            reject(new Error(`Download failed after ${maxAttempts} attempts. Exit code: ${code}`));
          }
        }
      });

      downloadProcess.on('error', (err) => {
        process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] Spawn error:`, data: err.message });
        logger.error(`Worker ${workerId} spawn error on download.`, { error: err });
        reject(err);
      });
    };
    attemptDownload();
  });

  // --- Step 3: Verify download and create track object ---
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] Step 3: Verifying download at:`, data: finalFilename });
  if (!await fs.pathExists(finalFilename)) {
    process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] File not found after download:`, data: finalFilename });
    throw new Error(`Download completed but file not found: ${finalFilename}`);
  }
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] File exists, checking size...` });
  const stats = await fs.stat(finalFilename);
  process.send({ type: 'log', level: 'info', message: `[Worker ${workerId}] File size:`, data: `${(stats.size / 1024 / 1024).toFixed(2)}MB` });
  if (stats.size === 0) {
    process.send({ type: 'log', level: 'error', message: `[Worker ${workerId}] Downloaded file is empty, removing...` });
    await fs.remove(finalFilename);
    throw new Error('Downloaded file is empty and has been removed.');
  }

  const track = {
    id: trackInfo.id || uuidv4(),
    name: trackInfo.title, // Use 'name' to match renderer's expectation
    artist: trackInfo.artist || trackInfo.uploader,
    album: trackInfo.album,
    duration: trackInfo.duration,
    thumbnail: trackInfo.thumbnail,
    url: trackInfo.webpage_url,
    filePath: finalFilename,
    isDownloaded: true,
    downloadDate: new Date().toISOString()
  };

  logger.info(`Worker ${workerId} completed download:`, { 
    name: track.name, 
    size: `${(stats.size / 1024 / 1024).toFixed(2)}MB`,
    duration: track.duration 
  });

  return track;
}

// Handle process termination gracefully
process.on('SIGTERM', () => {
  logger.info(`Worker ${workerId} received SIGTERM, shutting down gracefully`);
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info(`Worker ${workerId} received SIGINT, shutting down gracefully`);
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error(`Worker ${workerId} uncaught exception:`, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Worker ${workerId} unhandled rejection:`, reason);
  process.exit(1);
});

logger.info(`Download worker ${workerId} initialized and ready`);
