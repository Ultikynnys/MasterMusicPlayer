const { app, BrowserWindow, ipcMain, dialog, Menu, shell, globalShortcut, powerSaveBlocker } = require('electron');
const { exec, spawn } = require('child_process');
const archiver = require('archiver');
const extract = require('extract-zip');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const logger = require('./utils/logger');
const ytDlpHelper = require('./utils/ytDlpHelper');
const ProcessWorkerPool = require('./utils/processWorkerPool');
const FileLock = require('./utils/fileLock');
const ffmpegHelper = require('./utils/ffmpegHelper');
const BroadcastServer = require('./utils/broadcastServer');

// Disable Chromium background throttling so timers and media events keep firing when unfocused
try {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-media-suspend');
} catch (err) {
  logger.warn('Failed to apply background throttling disable switches', err);
}

let mainWindow;
let isDownloading = false;
let processWorkerPool;
let fileLock;
let broadcastServer;
let playbackPSBId = null; // power save blocker id when playing

// Initialize process worker pool
async function initializeWorkerPool(ytDlpPath) {
  if (processWorkerPool) return;

  // Attempt to obtain yt-dlp path automatically if not supplied by caller
  if (!ytDlpPath) {
    ytDlpPath = ytDlpHelper.getYtDlpPath();
  }

  if (!ytDlpPath) {
    logger.error('Worker pool initialization failed: yt-dlp path not available.');
    dialog.showErrorBox('Initialization Error', 'yt-dlp path is not configured. Downloads will not work.');
    return;
  }

  try {
    const maxWorkers = 16;
    const ffmpegPath = ffmpegHelper.getFFmpegPath();
    processWorkerPool = new ProcessWorkerPool(maxWorkers, ytDlpPath, ffmpegPath);

    // Forward worker logs to renderer for UI console display
    processWorkerPool.on('workerLog', (logData) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('worker-log', logData);
      }
    });
    // Listen for progress updates from the worker pool and forward them to the renderer
    processWorkerPool.on('progress', (progressData) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', progressData);
      }
    });
    logger.info(`Initialized process worker pool with ${maxWorkers} workers`);
  } catch (error) {
    logger.error('Failed to create worker pool', { error: error.message });
    dialog.showErrorBox('Initialization Error', 'Failed to create worker pool. Downloads will not work.');
  }
}

// Cleanup worker pool
async function cleanupWorkerPool() {
  if (processWorkerPool) {
    await processWorkerPool.terminate();
    processWorkerPool = null;
    logger.info('Process worker pool terminated');
  }
}

// Initialize broadcast server
async function initializeBroadcastServer() {
  try {
    broadcastServer = new BroadcastServer();

    // Set up event listeners
    broadcastServer.on('started', (info) => {
      logger.info('Broadcast server started', info);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('broadcast-status-changed', {
          running: true,
          url: broadcastServer.getShareableUrl()
        });
      }
    });

    broadcastServer.on('stopped', () => {
      logger.info('Broadcast server stopped');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('broadcast-status-changed', {
          running: false,
          url: ''
        });
      }
    });

    broadcastServer.on('error', (error) => {
      logger.error('Broadcast server error', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('broadcast-error', { error: error.message });
      }
    });


    // Load and apply initial config
    const appConfig = await loadAppConfig();
    if (appConfig.broadcast) {
      // Keep previous token to detect if server generated a new one
      const prevToken = appConfig.broadcast.accessToken || '';
      const updated = broadcastServer.updateConfig(appConfig.broadcast);
      // If a new token was generated (because it was missing), persist it immediately
      if (updated && updated.requireToken && updated.accessToken && updated.accessToken !== prevToken) {
        appConfig.broadcast = updated;
        await saveAppConfig(appConfig);
        logger.info('Persisted broadcast access token to app config');
      }
    }

    // Load and apply theme config
    try {
      const themeConfigPath = path.join(configPath, 'theme.json');
      if (await fs.pathExists(themeConfigPath)) {
        const themeConfig = await fs.readJson(themeConfigPath);
        broadcastServer.updateTheme(themeConfig);
      }
    } catch (error) {
      logger.error('Failed to load theme config for broadcast', error);
    }

    logger.info('Broadcast server initialized');
  } catch (error) {
    logger.error('Failed to initialize broadcast server', error);
  }
}

// Cleanup broadcast server
async function cleanupBroadcastServer() {
  if (broadcastServer) {
    await broadcastServer.stop();
    broadcastServer = null;
    logger.info('Broadcast server terminated');
  }
}

// Determine a writable directory for app data. When running from a packaged asar, __dirname is inside a read-only archive,
// so we fall back to Electron's recommended userData path. We defer initialisation until `app` is ready.
// Provide sensible defaults so code that runs before `app.whenReady()` doesn't crash when referencing these paths.
let appDataPath = path.join(__dirname, '..', 'data');
let songsPath = path.join(appDataPath, 'songs');
let playlistsPath = path.join(appDataPath, 'playlists');
let configPath = path.join(appDataPath, 'config');
let backupsPath = path.join(appDataPath, 'backups');

function initialisePaths() {
  // 1. If running from an electron-builder *portable* build, the stub sets
  //    PORTABLE_EXECUTABLE_DIR to the directory that contains the portable EXE.
  //    We prefer this location so everything lives next to the executable and
  //    users can move the folder around.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    appDataPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  } else if (app.isPackaged) {
    // 2. Regular installed/NSIS build – use userData (roaming AppData).
    appDataPath = path.join(app.getPath('userData'), 'data');
  } else {
    // 3. Development run – keep relative to repo for convenience.
    appDataPath = path.join(__dirname, '..', 'data');
  }

  songsPath = path.join(appDataPath, 'songs');
  playlistsPath = path.join(appDataPath, 'playlists');
  configPath = path.join(appDataPath, 'config');
  backupsPath = path.join(appDataPath, 'backups');
  appConfigPath = path.join(configPath, 'app.json');
}

// ---- Path helpers ----
/**
 * Convert an absolute path under the app data directory to a path relative to appDataPath
 * @param {string} absPath
 * @returns {string}
 */
function toRelativePath(absPath) {
  try {
    if (!absPath) return absPath;
    return path.relative(appDataPath, absPath);
  } catch (err) {
    logger.error('Error converting to relative path', err, { absPath });
    return absPath;
  }
}

/**
 * Convert a relative track path to absolute path inside appDataPath. If already absolute, returns as-is.
 * @param {string} relOrAbs
 * @returns {string}
 */
function toAbsolutePath(relOrAbs) {
  if (!relOrAbs) return relOrAbs;
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(appDataPath, relOrAbs);
}

// App configuration management
let appConfigPath;

async function createDataDirectories() {
  try {
    await fs.ensureDir(appDataPath);
    await fs.ensureDir(songsPath);
    await fs.ensureDir(playlistsPath);
    await fs.ensureDir(configPath);
    await fs.ensureDir(backupsPath);
    logger.info('Data directories created or verified');
  } catch (error) {
    logger.error('Failed to create data directories', error);
    throw error;
  }
}

const defaultAppConfig = {
  download: {
    retryAttempts: 3
  },
  visualizer: {
    enabled: true
  },
  playbackState: {
    volume: 1,
    currentTrackId: null,
    currentPlaylistId: null,
    currentTime: 0,
    isRepeat: false,
    isShuffle: false,
    saveRepeatState: true,
    saveTrackTime: true
  },
  broadcast: {
    enabled: false,
    host: '127.0.0.1',
    port: 4583,
    publicHost: '',
    requireToken: true,
    accessToken: ''
  }
};

async function loadAppConfig() {
  try {
    if (await fs.pathExists(appConfigPath)) {
      const config = await fs.readJson(appConfigPath);
      // Deep merge to handle nested objects like playbackState and broadcast
      const mergedConfig = {
        ...defaultAppConfig,
        ...config,
        playbackState: {
          ...defaultAppConfig.playbackState,
          ...(config.playbackState || {})
        },
        broadcast: {
          ...defaultAppConfig.broadcast,
          ...(config.broadcast || {})
        }
      };
      logger.info('Loaded app config with playback state', {
        hasPlaybackState: !!mergedConfig.playbackState,
        playbackState: mergedConfig.playbackState
      });
      return mergedConfig;
    }
  } catch (error) {
    logger.error('Failed to load app config', error);
  }
  return defaultAppConfig;
}

async function saveAppConfig(config) {
  try {
    await fs.writeJson(appConfigPath, config, { spaces: 2 });
    logger.info('App config saved successfully');
    return true;
  } catch (error) {
    logger.error('Failed to save app config', error);
    throw error;
  }
}

// Get yt-dlp arguments for playlist info extraction
function getYtDlpArgs(baseArgs, appConfig) {
  // If baseArgs are provided, use them (they already contain the correct arguments)
  if (baseArgs && Array.isArray(baseArgs)) {
    return baseArgs;
  }

  // Fallback arguments for compatibility
  return ['--dump-single-json', '--flat-playlist', '--no-warnings'];
}

function createWindow() {
  try {

    logger.info('Creating main window');

    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true,
        backgroundThrottling: false
      },
      icon: path.join(__dirname, 'renderer', 'assets', 'MMP_Logo.png'),
      titleBarStyle: 'default',
      show: false,
      autoHideMenuBar: true
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Remove the default application menu (File/Edit/View...)
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);

    mainWindow.once('ready-to-show', () => {
      logger.info('Main window ready to show');
      mainWindow.show();
    });

    mainWindow.on('closed', () => {
      logger.info('Main window closed');
      mainWindow = null;
    });

    // Set up menu with F12 accelerator for developer tools
    const template = [
      {
        label: 'View',
        submenu: [
          {
            label: 'Toggle Developer Tools',
            accelerator: 'F12',
            click: () => {
              if (mainWindow) {
                mainWindow.webContents.toggleDevTools();
              }
            }
          }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);


  } catch (error) {
    logger.error('Error creating main window', error);
  }
}



app.whenReady().then(async () => {
  // Determine correct writable paths first
  initialisePaths();
  // Ensure data directories now that paths point to writable location
  await createDataDirectories();
  // Initialize file lock
  fileLock = new FileLock(path.join(appDataPath, 'locks'));

  // Show window immediately for fast startup
  createWindow();
  logger.info('Window created, starting background initialization...');

  // Track background initialization state
  let backgroundInitPromise = null;

  // Defer heavy initialization to background
  backgroundInitPromise = new Promise(async (resolve) => {
    try {
      logger.info('Initializing FFmpeg...');
      await ffmpegHelper.initialize();
      logger.info('FFmpeg initialization completed');

      logger.info('Ensuring yt-dlp is available...');
      await ytDlpHelper.ensureYtDlp();
      logger.info('yt-dlp ensure process completed');

      const ytDlpPath = ytDlpHelper.getYtDlpPath();
      const isReady = ytDlpHelper.isYtDlpReady();

      logger.info('yt-dlp status check', { path: ytDlpPath, ready: isReady });

      if (ytDlpPath && isReady) {
        await initializeWorkerPool(ytDlpPath);
        logger.info('Worker pool initialized successfully');
      } else {
        logger.error('yt-dlp not ready after ensure process', { path: ytDlpPath, ready: isReady });
      }

      // Initialize broadcast server
      await initializeBroadcastServer();

      logger.info('Background initialization completed successfully');
      resolve();
    } catch (error) {
      logger.error('Failed during background initialization', { error: error.message, stack: error.stack });
      resolve(); // Still resolve to avoid hanging
    }
  });

  // Make backgroundInitPromise globally accessible
  global.backgroundInitPromise = backgroundInitPromise;

  // Run duration scan in background after app is ready (non-blocking)
  setTimeout(async () => {
    try {
      const result = await scanAndUpdateTrackDurations();
      if (result.updated > 0) {

        // Notify renderer if any tracks were updated
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('durations-updated', result);
        }
      } else {

      }
    } catch (error) {
      logger.error('Error during background duration scan', error);
    }
  }, 3000); // Wait 3 seconds after app startup

  app.on('activate', () => {
    logger.systemEvent('app-activated');
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});



// window-all-closed handler is registered at the bottom of the file with cleanup logic

// IPC error handling wrapper
function withErrorHandling(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      logger.error(`Error in IPC handler for channel: ${channel}`, error);
      // It's important to throw the error so the renderer process's invoke call is rejected.
      throw error;
    }
  });
}

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.crash(error, 'Uncaught exception in main process');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.crash(new Error(reason), 'Unhandled promise rejection in main process');
});

// IPC handlers for playlist management
ipcMain.handle('get-playlists', async () => {
  const startTime = Date.now();
  try {
    logger.userAction('get-playlists-requested');
    const files = await fs.readdir(playlistsPath);
    const playlists = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const playlistData = await fs.readJson(path.join(playlistsPath, file));
        // Convert relative paths to absolute for renderer
        if (playlistData.tracks && Array.isArray(playlistData.tracks)) {
          logger.info(`Processing ${playlistData.tracks.length} tracks for playlist ${playlistData.name}`);
          playlistData.tracks = playlistData.tracks
            .filter(t => {
              if (!t || !t.filePath) {
                logger.warn('Filtering out invalid track:', t);
                return false;
              }
              return true;
            })
            .map(t => {
              const originalPath = t.filePath;
              const absolutePath = toAbsolutePath(t.filePath);
              logger.info(`Path conversion: ${originalPath} -> ${absolutePath}`);
              return { ...t, filePath: absolutePath };
            });
        }
        playlists.push(playlistData);
      }
    }

    return playlists;
  } catch (error) {
    logger.error('Error getting playlists', error);
    throw error;
  }
});

withErrorHandling('create-playlist', async (event, name) => {
  const startTime = Date.now();
  try {
    logger.userAction('create-playlist-requested', { name });
    const playlist = {
      id: uuidv4(),
      name: name,
      tracks: [],
      createdAt: new Date().toISOString()
    };

    await fs.writeJson(path.join(playlistsPath, `${playlist.id}.json`), playlist);
    logger.info('Playlist created successfully', { playlistId: playlist.id, name });
    return playlist;
  } catch (error) {
    logger.error('Error creating playlist', error, { name });
    throw error;
  }
});

withErrorHandling('update-playlist', async (event, playlist) => {
  const startTime = Date.now();
  try {
    logger.userAction('update-playlist-requested', { playlistId: playlist.id, name: playlist.name, trackCount: playlist.tracks.length });
    await fs.writeJson(path.join(playlistsPath, `${playlist.id}.json`), playlist);
    return playlist;
  } catch (error) {
    logger.error('Error updating playlist', error, { playlistId: playlist.id });
    throw error;
  }
});

withErrorHandling('delete-playlist', async (event, playlistId) => {
  const startTime = Date.now();
  try {
    logger.userAction('delete-playlist-requested', { playlistId });

    const playlistFile = path.join(playlistsPath, `${playlistId}.json`);
    let tracksToDelete = [];

    // 1. Read tracks in the playlist to be deleted (if exists)
    if (await fs.pathExists(playlistFile)) {
      try {
        const playlistData = await fs.readJson(playlistFile);
        tracksToDelete = playlistData.tracks || [];
      } catch (readErr) {
        logger.warn('Could not read playlist file before deletion', readErr, { playlistId });
      }
    }

    // 2. Build a set of all track file paths referenced by OTHER playlists
    const referencedFiles = new Set();
    try {
      const playlistFiles = await fs.readdir(playlistsPath);
      for (const file of playlistFiles) {
        if (file === `${playlistId}.json` || path.extname(file) !== '.json') continue; // skip the playlist being deleted and non-json files
        try {
          const playlistPath = path.join(playlistsPath, file);
          const data = await fs.readJson(playlistPath);
          if (!Array.isArray(data.tracks)) data.tracks = [];

          // Filter out tracks whose files are missing
          const existingTracks = [];
          for (const t of data.tracks) {
            const abs = toAbsolutePath(t.filePath);
            if (await fs.pathExists(abs)) {
              existingTracks.push(t);
              referencedFiles.add(abs);
            }
          }
          if (existingTracks.length !== data.tracks.length) {
            data.tracks = existingTracks;
            try {
              await fs.writeJson(playlistPath, data, { spaces: 2 });
              logger.info('Pruned missing-file tracks from playlist', { playlist: playlistPath, removed: data.tracks.length - existingTracks.length });
            } catch (writeErr) {
              logger.warn('Failed to rewrite playlist after pruning missing tracks', writeErr, { playlist: playlistPath });
            }
          }
        } catch (parseErr) {
          logger.warn('Failed to parse playlist while building referenced files set', parseErr, { file });
        }
      }
    } catch (dirErr) {
      logger.warn('Failed to scan playlists directory when deleting playlist', dirErr);
    }

    // 3. Delete audio files that are NOT referenced elsewhere
    for (const track of tracksToDelete) {
      if (!track.filePath) continue;
      const absPath = toAbsolutePath(track.filePath);
      if (!referencedFiles.has(absPath)) {
        try {
          await fs.remove(absPath);
          logger.info('Deleted unreferenced track file', { path: absPath });
        } catch (fileErr) {
          logger.warn('Failed to delete track file during playlist deletion', fileErr, { path: absPath });
        }
      }
    }

    // 4. Clean up orphaned files in songs directory
    await cleanupOrphanedFiles(referencedFiles);

    // 5. Finally, delete the playlist JSON
    await fs.remove(playlistFile);

    logger.info('Playlist deleted successfully', { playlistId });
    return true;
  } catch (error) {
    logger.error('Error deleting playlist', error, { playlistId });
    throw error;
  }
});

/**
 * Clean up orphaned audio files in the songs directory that are not referenced by any playlist
 * @param {Set<string>} referencedFiles - Set of file paths that are still referenced
 */
async function cleanupOrphanedFiles(referencedFiles) {
  try {
    const songFiles = await fs.readdir(songsPath);
    let deletedCount = 0;

    for (const file of songFiles) {
      const filePath = path.join(songsPath, file);
      const stats = await fs.stat(filePath);

      // Skip directories
      if (stats.isDirectory()) continue;

      // Check if this file is referenced by any playlist
      if (!referencedFiles.has(filePath)) {
        try {
          await fs.remove(filePath);
          logger.info('Deleted orphaned audio file', { path: filePath });
          deletedCount++;
        } catch (fileErr) {
          logger.warn('Failed to delete orphaned audio file', fileErr, { path: filePath });
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} orphaned audio files`);
    }
  } catch (error) {
    logger.warn('Failed to cleanup orphaned files', error);
  }
}

// IPC handlers for app configuration
withErrorHandling('get-app-config', async () => {
  return await loadAppConfig();
});

withErrorHandling('get-app-version', async () => {
  try {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageData = await fs.readJson(packageJsonPath);
    return packageData.version;
  } catch (error) {
    logger.error('Error reading app version from package.json', error);
    throw error;
  }
});

withErrorHandling('save-app-config', async (event, config) => {
  await saveAppConfig(config);
  return true;
});

// IPC handlers for theme configuration
withErrorHandling('get-theme-config', async () => {
  const configFile = path.join(configPath, 'theme.json');
  if (await fs.pathExists(configFile)) {
    return await fs.readJson(configFile);
  }
  return {}; // Return default empty theme if not found
});

withErrorHandling('update-theme-config', async (event, theme) => {
  const configFile = path.join(configPath, 'theme.json');
  await fs.writeJson(configFile, theme, { spaces: 2 });

  // Update broadcast server theme
  if (broadcastServer) {
    broadcastServer.updateTheme(theme);
  }

  logger.info('Theme config updated successfully');
  return { success: true };
});

// IPC handlers for broadcast functionality
withErrorHandling('update-broadcast-config', async (event, config) => {
  if (!broadcastServer) {
    throw new Error('Broadcast server not initialized');
  }

  const updatedConfig = broadcastServer.updateConfig(config);

  // Save to app config
  const appConfig = await loadAppConfig();
  appConfig.broadcast = updatedConfig;
  await saveAppConfig(appConfig);

  logger.info('Broadcast config updated successfully');
  return { success: true, config: updatedConfig };
});

withErrorHandling('get-broadcast-status', async () => {
  if (!broadcastServer) {
    return { running: false, url: '' };
  }

  return {
    running: broadcastServer.isRunning,
    url: broadcastServer.isRunning ? broadcastServer.getShareableUrl() : '',
    config: broadcastServer.config
  };
});

withErrorHandling('generate-broadcast-token', async () => {
  if (!broadcastServer) {
    throw new Error('Broadcast server not initialized');
  }

  const newToken = broadcastServer.generateAccessToken();
  const updatedConfig = broadcastServer.updateConfig({ accessToken: newToken });

  // Save to app config
  const appConfig = await loadAppConfig();
  appConfig.broadcast = updatedConfig;
  await saveAppConfig(appConfig);

  logger.info('New broadcast token generated');
  return { success: true, token: newToken, url: broadcastServer.getShareableUrl() };
});

withErrorHandling('update-broadcast-state', async (event, state) => {
  if (!broadcastServer) {
    return;
  }

  broadcastServer.updateState(state);
  logger.debug('Broadcast state updated from renderer');
  // Keep the app from being throttled/suspended while playing, regardless of focus
  try {
    if (state && state.isPlaying) {
      if (playbackPSBId === null || !powerSaveBlocker.isStarted(playbackPSBId)) {
        playbackPSBId = powerSaveBlocker.start('prevent-app-suspension');
        logger.info('powerSaveBlocker started', { id: playbackPSBId });
      }
    } else if (playbackPSBId !== null) {
      powerSaveBlocker.stop(playbackPSBId);
      logger.info('powerSaveBlocker stopped', { id: playbackPSBId });
      playbackPSBId = null;
    }
  } catch (e) {
    logger.warn('powerSaveBlocker control failed', e);
  }
});

// --- Audio Duration Extraction ---

/**
 * Scans all playlists for tracks without duration and updates them
 * @returns {Promise<{updated: number, failed: number}>} Results of the scan
 */
async function scanAndUpdateTrackDurations() {

  let updated = 0;
  let failed = 0;

  try {
    const playlistFiles = await fs.readdir(playlistsPath);

    for (const file of playlistFiles) {
      if (!file.endsWith('.json')) continue;

      const playlistPath = path.join(playlistsPath, file);
      const playlist = await fs.readJson(playlistPath);
      let playlistUpdated = false;

      if (playlist.tracks && Array.isArray(playlist.tracks)) {
        for (const track of playlist.tracks) {
          // Ensure track and track.filePath are valid
          if (!track || !track.filePath) {
            logger.warn('Skipping invalid track entry in playlist');
            continue;
          }

          // Check if track is missing duration or has invalid duration
          if (!track.duration || track.duration <= 0) {
            logger.info(`Found track without duration: ${track.name}`);

            // Check if the file exists
            const absPath = toAbsolutePath(track.filePath);
            if (absPath && await fs.pathExists(absPath)) {
              try {
                const extractedDuration = await extractAudioDuration(absPath);
                if (extractedDuration && extractedDuration > 0) {
                  track.duration = extractedDuration;
                  playlistUpdated = true;
                  updated++;
                  logger.info(`Updated duration for track: ${track.name} -> ${extractedDuration}s`);
                } else {
                  failed++;
                  logger.warn(`Failed to extract duration for track: ${track.name}`);
                }
              } catch (error) {
                failed++;
                logger.error(`Error extracting duration for track: ${track.name}`, error);
              }
            } else {
              failed++;
              logger.warn(`Track file not found: ${track.filePath}`);
            }
          }
        }
      }

      // Save the playlist if any tracks were updated
      if (playlistUpdated) {
        await fs.writeJson(playlistPath, playlist);
      }
    }


    return { updated, failed };

  } catch (error) {
    logger.error('Error during track duration scan', error);
    return { updated, failed };
  }
}

/**
 * Extracts duration from an audio file using ffprobe
 * @param {string} filePath - Path to the audio file
 * @returns {Promise<number|null>} Duration in seconds or null if extraction fails
 */
async function extractAudioDuration(filePath) {
  return new Promise((resolve) => {
    // Try ffprobe first (most reliable)
    const ffprobePath = ffmpegHelper.getFFprobePath();
    if (!ffprobePath) {
      logger.warn('FFprobe not available, skipping duration extraction', { filePath });
      return resolve(null);
    }

    exec(`"${ffprobePath}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, (error, stdout) => {
      if (!error && stdout.trim()) {
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration) && duration > 0) {
          logger.info(`Extracted duration from audio file: ${duration}s`, { filePath });
          return resolve(duration);
        }
      }

      // Fallback: try using yt-dlp to get duration from the file
      const ytDlpExecutablePath = ytDlpHelper.getYtDlpPath();
      if (ytDlpExecutablePath) {
        exec(`"${ytDlpExecutablePath}" --dump-single-json "${filePath}"`, (error, stdout) => {
          if (!error && stdout.trim()) {
            try {
              const info = JSON.parse(stdout.trim());
              if (info.duration && info.duration > 0) {
                logger.info(`Extracted duration using yt-dlp: ${info.duration}s`, { filePath });
                return resolve(info.duration);
              }
            } catch (e) {
              logger.debug('Failed to parse yt-dlp duration output', e);
            }
          }

          logger.warn('Could not extract duration from audio file', { filePath });
          resolve(null);
        });
      } else {
        logger.warn('Could not extract duration - no tools available', { filePath });
        resolve(null);
      }
    });
  });
}

// --- Download Management ---

// Fetches metadata for a URL (playlist or single video) without downloading.
async function fetchPlaylistInfo(url) {
  logger.info('Fetching playlist info...', { url });
  const appConfig = await loadAppConfig();

  return new Promise((resolve, reject) => {
    const ytDlpExecutablePath = ytDlpHelper.getYtDlpPath();
    if (!ytDlpExecutablePath || !ytDlpHelper.isYtDlpReady()) {
      const errorMsg = 'yt-dlp is not available or not ready.';
      logger.error(errorMsg);
      return reject(new Error(errorMsg));
    }

    const baseArgs = [
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      url
    ];

    // Try without cookies first - only use cookies if initial fetch fails
    let args = getYtDlpArgs(baseArgs, appConfig);
    logger.debug('Executing yt-dlp for playlist entries', { command: `${ytDlpExecutablePath} ${args.join(' ')}` });

    const child = spawn(ytDlpExecutablePath, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => stdout += data.toString());
    child.stderr.on('data', (data) => stderr += data.toString());

    child.on('close', async (code) => {
      if (code === 0) {
        try {
          logger.debug('yt-dlp metadata output', { rawJson: stdout });
          const info = JSON.parse(stdout);
          const entries = info.entries || [info];
          logger.info(`Successfully fetched info for ${entries.length} tracks.`, { url });
          resolve(entries);
        } catch (e) {
          const errorMsg = 'Failed to parse yt-dlp JSON output.';
          logger.error(errorMsg, e, { rawJson: stdout });
          reject(new Error(errorMsg));
        }
      } else {
        // Check if this is an age restriction error that might be solved with cookies
        const isAgeRestricted = stderr && (
          stderr.includes('Sign in to confirm your age') ||
          stderr.includes('age-restricted') ||
          stderr.includes('inappropriate for some users')
        );

        if (isAgeRestricted) {
          logger.info('Initial fetch failed due to age restrictions, trying with cookies...', { url });

          // Try again with cookies if available
          const dataPath = app.getPath('userData');
          const cookiesPath = path.join(dataPath, 'cookies.txt');

          try {
            if (fs.pathExistsSync(cookiesPath)) {
              let isYouTubeCookie = false;
              try {
                const cookieContent = fs.readFileSync(cookiesPath, 'utf8');
                isYouTubeCookie = /\byoutube\.com\b/i.test(cookieContent) || /\bSID\b|\bSAPISID\b|\b__Secure-3PAPISID\b/i.test(cookieContent);
              } catch (readErr) {
                logger.warn('Failed to read cookies.txt to validate contents', readErr);
              }

              if (isYouTubeCookie) {
                logger.info('Retrying with cookies.txt for age-restricted content', { cookiesPath });
                const cookieArgs = ['--cookies', cookiesPath, ...args];

                // Retry with cookies
                const retryChild = spawn(ytDlpExecutablePath, cookieArgs);
                let retryStdout = '';
                let retryStderr = '';
                retryChild.stdout.on('data', (data) => retryStdout += data.toString());
                retryChild.stderr.on('data', (data) => retryStderr += data.toString());

                retryChild.on('close', (retryCode) => {
                  if (retryCode === 0) {
                    try {
                      const retryInfo = JSON.parse(retryStdout);
                      const retryEntries = retryInfo.entries || [retryInfo];
                      logger.info(`Successfully fetched age-restricted content with cookies: ${retryEntries.length} tracks.`, { url });
                      resolve(retryEntries);
                    } catch (e) {
                      const errorMsg = 'Failed to parse yt-dlp JSON output from cookie retry.';
                      logger.error(errorMsg, e, { rawJson: retryStdout });
                      reject(new Error(errorMsg));
                    }
                  } else {
                    const errorMsg = `yt-dlp failed to fetch playlist info even with cookies. Code: ${retryCode}.`;
                    logger.error(errorMsg, null, { stderr: retryStderr, url });
                    reject(new Error(`${errorMsg} Error: ${retryStderr}`));
                  }
                });

                retryChild.on('error', (err) => {
                  const errorMsg = 'Failed to start yt-dlp retry process with cookies.';
                  logger.error(errorMsg, err);
                  reject(new Error(errorMsg));
                });

                return; // Exit early, retry is handling the response
              } else {
                logger.warn('cookies.txt found but does NOT appear to contain YouTube cookies', { cookiesPath });
              }
            } else {
              logger.info('No cookies.txt available for age-restricted content', { cookiesPath });
            }
          } catch (cookieCheckErr) {
            logger.warn('Failed to check cookies.txt for age-restricted retry', cookieCheckErr);
          }
        }

        // If we get here, either it's not age-restricted or cookies didn't help
        const errorMsg = `yt-dlp failed to fetch playlist info. Code: ${code}.`;
        logger.error(errorMsg, null, { stderr, url });
        reject(new Error(`${errorMsg} Error: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      const errorMsg = 'Failed to start yt-dlp process.';
      logger.error(errorMsg, err);
      reject(new Error(errorMsg));
    });
  });
}

withErrorHandling('download-from-url', async (event, { url, playlistId }) => {
  if (isDownloading) {
    logger.warn('Download already in progress.');
    mainWindow.webContents.send('download-error', {
      error: 'Download already in progress.'
    });
    return { success: false, message: 'Download already in progress.' };
  }

  isDownloading = true;
  mainWindow.webContents.send('download-started');
  logger.info(`Download request received for playlist: ${playlistId}`, { url });

  try {
    // Wait for background initialization to complete if still running
    if (global.backgroundInitPromise) {
      logger.info('Waiting for background initialization to complete...');
      await global.backgroundInitPromise;
    }

    const playlistPath = path.join(playlistsPath, `${playlistId}.json`);
    const playlist = await fs.readJson(playlistPath);

    // Send initial progress update
    mainWindow.webContents.send('download-progress', {
      taskId: 'fetching-info',
      progress: 0,
      trackInfo: { title: 'Fetching track information...' }
    });

    const trackInfos = await fetchPlaylistInfo(url);
    logger.info(`Found ${trackInfos.length} tracks to download.`, { url });

    let downloadedTracks = [];
    let failedTracks = [];
    let ageRestrictedTracks = [];
    let skippedTracks = [];
    let tasks = [];

    for (const trackInfo of trackInfos) {
      const trackUrl = trackInfo.webpage_url || trackInfo.url;
      if (playlist.tracks.some(t => t && t.url === trackUrl)) {
        logger.info('Skipping duplicate track', { title: trackInfo.title });
        skippedTracks.push(trackInfo);
        continue;
      }

      tasks.push({
        type: 'downloadTrack',
        trackInfo,
        songsPath,
        taskId: `${playlistId}-${trackInfo.id}`
      });
    }

    // Send progress update with track count
    mainWindow.webContents.send('download-progress', {
      taskId: 'preparing-downloads',
      progress: 0,
      trackInfo: {
        title: `Preparing to download ${tasks.length} track${tasks.length !== 1 ? 's' : ''}...`,
        totalTracks: tasks.length,
        skippedTracks: skippedTracks.length
      }
    });

    // Initialize worker pool if not already done
    await initializeWorkerPool();



    // Use the process worker pool to download tracks in parallel
    // Progress monitoring setup (timeout removed for slow connections)
    const progressListener = (data) => {
      if (data && data.progress !== undefined) {
        logger.info('Download progress update received');
      }
    };
    processWorkerPool.on('progress', progressListener);

    const workerStats = processWorkerPool.getStats();
    logger.info(`Starting parallel download of ${tasks.length} tracks using ${workerStats.totalWorkers} workers`);

    let completedTasks = 0;
    const totalTasks = tasks.length;

    // Create array to preserve original order
    const downloadResults = new Array(tasks.length);

    const downloadPromises = tasks.map((task, index) => {
      return processWorkerPool.addTask(task.trackInfo, songsPath, playlistId)
        .then(result => {
          completedTasks++;
          const overallProgress = Math.round((completedTasks / totalTasks) * 100);

          if (result.success) {
            // Store result at original index to preserve order
            downloadResults[index] = result.track;
            logger.info(`Downloaded: ${result.track.name}`);

            // Send overall progress update
            mainWindow.webContents.send('download-progress', {
              taskId: 'overall-progress',
              progress: overallProgress,
              trackInfo: {
                title: `Downloaded "${result.track.name}"`,
                completed: completedTasks,
                total: totalTasks,
                successful: downloadResults.filter(Boolean).length,
                failed: failedTracks.length
              }
            });

            // Send the newly downloaded track to the renderer for immediate UI update
            mainWindow.webContents.send('track-downloaded', {
              playlistId,
              track: result.track
            });
          } else {
            failedTracks.push(result.trackInfo);
            logger.warn(`Failed to download: ${result.trackInfo.title}`, { error: result.error });

            // Send progress update for failed track
            mainWindow.webContents.send('download-progress', {
              taskId: 'overall-progress',
              progress: overallProgress,
              trackInfo: {
                title: `Failed to download "${result.trackInfo.title}"`,
                completed: completedTasks,
                total: totalTasks,
                successful: downloadedTracks.length,
                failed: failedTracks.length
              }
            });
          }
          return result;
        })
        .catch(error => {
          completedTasks++;
          const overallProgress = Math.round((completedTasks / totalTasks) * 100);

          logger.error(`Download promise rejected:`, error);

          // Categorize the error
          const isAgeRestricted = error.message && (
            error.message.includes('AGE_RESTRICTED') ||
            error.message.includes('Sign in to confirm your age') ||
            error.message.includes('age-restricted')
          );

          const shouldSkip = error.message && error.message.includes('AGE_RESTRICTED_SKIP');

          if (shouldSkip || isAgeRestricted) {
            ageRestrictedTracks.push(task.trackInfo);
            // Log as skipped rather than failed for better UX
            logger.info(`Skipping age-restricted track: ${task.trackInfo.title}`);
          } else {
            failedTracks.push(task.trackInfo);
          }

          // Send progress update for error
          mainWindow.webContents.send('download-progress', {
            taskId: 'overall-progress',
            progress: overallProgress,
            trackInfo: {
              title: (shouldSkip || isAgeRestricted) ? `Skipping age-restricted: "${task.trackInfo.title}"` : `Error downloading "${task.trackInfo.title}"`,
              completed: completedTasks,
              total: totalTasks,
              successful: downloadedTracks.length,
              failed: failedTracks.length,
              ageRestricted: ageRestrictedTracks.length
            }
          });

          return { success: false, trackInfo: task.trackInfo, error: error.message, isAgeRestricted };
        });
    });

    // Wait for all downloads to complete
    const results = await Promise.all(downloadPromises);

    // Clean up progress listener
    processWorkerPool.off('progress', progressListener);

    // Log worker pool statistics
    // Filter out null/undefined results and preserve order
    const orderedDownloadedTracks = downloadResults.filter(Boolean);

    const stats = processWorkerPool.getStats();
    logger.info('Download batch completed', {
      totalTasks: tasks.length,
      successful: orderedDownloadedTracks.length,
      failed: failedTracks.length,
      workerStats: stats
    });

    if (orderedDownloadedTracks.length > 0) {
      // Acquire lock before writing to playlist file
      if (fileLock.acquire(playlistPath)) {
        try {
          playlist.tracks.push(...orderedDownloadedTracks);
          await fs.writeJson(playlistPath, playlist);
        } finally {
          // Ensure cleanup for progress listener
          if (processWorkerPool && processWorkerPool.off) processWorkerPool.off('progress', progressListener);
          fileLock.release(playlistPath);
        }
      } else {
        logger.error('Failed to acquire lock for playlist update', { playlistId });
        return { success: false, message: 'Failed to update playlist due to file lock.' };
      }

      // Run duration scan for newly downloaded tracks
      logger.info('Running duration scan for newly downloaded tracks');
      try {
        const durationResult = await scanAndUpdateTrackDurations();
        if (durationResult.updated > 0) {
          logger.info(`Duration scan after download completed: ${durationResult.updated} tracks updated`);
          // Notify UI about duration updates
          mainWindow.webContents.send('duration-scan-complete', durationResult);
        }
      } catch (error) {
        logger.error('Error during post-download duration scan', error);
      }
    }

    const summary = {
      downloaded: orderedDownloadedTracks.length,
      failed: failedTracks.length,
      ageRestricted: ageRestrictedTracks.length,
      skipped: skippedTracks.length
    };
    logger.info('Download summary', { ...summary, url });

    // Send final progress update
    const summaryMessage = [];
    if (summary.downloaded > 0) summaryMessage.push(`${summary.downloaded} downloaded`);
    if (summary.failed > 0) summaryMessage.push(`${summary.failed} failed`);
    if (summary.ageRestricted > 0) summaryMessage.push(`${summary.ageRestricted} age-restricted`);
    if (summary.skipped > 0) summaryMessage.push(`${summary.skipped} skipped`);

    mainWindow.webContents.send('download-progress', {
      taskId: 'completion',
      progress: 100,
      trackInfo: {
        title: `Download complete! ${summaryMessage.join(', ')}`,
        completed: totalTasks,
        total: totalTasks,
        successful: downloadedTracks.length,
        failed: failedTracks.length
      }
    });

    mainWindow.webContents.send('download-complete', {
      playlistId,
      downloadedTracks: orderedDownloadedTracks,
      failedTracks,
      ageRestrictedTracks,
      skippedTracks
    });

    // Show comprehensive completion notice for failed/skipped tracks
    const totalProblematic = failedTracks.length + ageRestrictedTracks.length;
    if (totalProblematic > 0) {
      let notificationTitle = 'Download Issues';
      let notificationMessage = '';

      if (ageRestrictedTracks.length > 0 && failedTracks.length > 0) {
        notificationTitle = 'Some Tracks Skipped';
        notificationMessage = `${ageRestrictedTracks.length} track${ageRestrictedTracks.length > 1 ? 's were' : ' was'} skipped due to age restrictions and ${failedTracks.length} track${failedTracks.length > 1 ? 's' : ''} failed due to other issues (private, removed, or unavailable).\n\nFor age-restricted content: Go to Settings → YouTube Cookies to upload a valid cookies.txt file.`;
      } else if (ageRestrictedTracks.length > 0) {
        notificationTitle = 'Age-Restricted Content Skipped';
        notificationMessage = `${ageRestrictedTracks.length} track${ageRestrictedTracks.length > 1 ? 's were' : ' was'} skipped due to age restrictions.\n\nTo download age-restricted content: Go to Settings → YouTube Cookies and upload a valid cookies.txt file from your browser.`;
      } else if (failedTracks.length > 0) {
        notificationTitle = 'Some Tracks Failed';
        notificationMessage = `${failedTracks.length} track${failedTracks.length > 1 ? 's' : ''} could not be downloaded. These may be private, removed, or age restricted videos. For age restriction go to settings and add cookies.txt`;
      }

      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('show-download-completion-notice', {
          title: notificationTitle,
          message: notificationMessage,
          ageRestrictedCount: ageRestrictedTracks.length,
          failedCount: failedTracks.length,
          ageRestrictedTracks: ageRestrictedTracks.map(t => t.title),
          failedTracks: failedTracks.map(t => t.title)
        });
      }
    }

    return { success: true, summary };
  } catch (error) {
    // Enhanced error logging with more details
    const errorDetails = {
      url,
      playlistId,
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      timestamp: new Date().toISOString(),
      workerPoolActive: processWorkerPool ? true : false
    };

    logger.error('Download process failed with detailed error information', error, errorDetails);

    // Check for various error types and provide user-friendly messages
    const isAgeRestricted = error.message && (
      error.message.includes('Sign in to confirm your age') ||
      error.message.includes('age-restricted') ||
      error.message.includes('inappropriate for some users')
    );

    const isCookieFormatError = error.message && (
      error.message.includes('Netscape format') ||
      error.message.includes('does not look like a Netscape format cookies file')
    );

    const isCookieError = error.message && (
      error.message.includes('cookies.txt') ||
      error.message.includes('--cookies')
    );

    let userMessage = error.message;

    if (isCookieFormatError) {
      userMessage = 'Invalid cookies.txt format. Please export cookies in Netscape format from your browser. Go to Settings → YouTube Cookies for instructions.';
    } else if (isAgeRestricted || isCookieError) {
      // Check if this is a single track or playlist (if trackInfos is available)
      let isSingleTrack = false;
      try {
        isSingleTrack = trackInfos && trackInfos.length === 1;
      } catch (err) {
        // trackInfos not available, assume single track
        logger.debug('Could not determine if single track, assuming true for error message', { error: err ? err.message : 'Unknown' });
        isSingleTrack = true;
      }
      if (isSingleTrack) {
        userMessage = 'This video is age-restricted and requires valid YouTube cookies. Please upload a properly formatted cookies.txt file from Settings → YouTube Cookies.';
      } else {
        userMessage = 'Some videos in this playlist are age-restricted and require valid YouTube cookies. Please upload a properly formatted cookies.txt file from Settings → YouTube Cookies.';
      }
    } else {
      // For any other YouTube download failure, assume it's likely age-restricted
      let isSingleTrack = false;
      try {
        isSingleTrack = trackInfos && trackInfos.length === 1;
      } catch (err) {
        // trackInfos not available, assume single track
        logger.debug('Could not determine if single track, assuming true for error message', { error: err ? err.message : 'Unknown' });
        isSingleTrack = true;
      }
      if (isSingleTrack) {
        userMessage = 'Failed to download this video. This is likely due to age restrictions. Please upload a valid cookies.txt file from Settings → YouTube Cookies to access age-restricted content.';
      } else {
        userMessage = 'Failed to download some videos. This is likely due to age restrictions. Please upload a valid cookies.txt file from Settings → YouTube Cookies to access all content.';
      }
    }

    // Send detailed error to renderer for better user feedback
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-error', {
        error: userMessage,
        details: errorDetails,
        isAgeRestricted
      });
    }

    return { success: false, message: userMessage };
  } finally {
    isDownloading = false;
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('download-finished');
    }
    logger.info('Download process finished.', { url });
  }
});

// IPC handlers for file operations
withErrorHandling('add-local-file', async (event, { filePath, playlistId }) => {

  const startTime = Date.now();
  try {
    // Validate input parameters
    if (!filePath) {
      throw new Error('filePath is required but was undefined or empty');
    }
    if (!playlistId) {
      throw new Error('playlistId is required but was undefined or empty');
    }

    logger.userAction('add-local-file-requested', { filePath, playlistId });
    const fileName = path.basename(filePath);
    const fileExt = path.extname(fileName).slice(1);
    const newPath = path.join(songsPath, fileName);

    // Determine final destination path & copy if needed
    let destinationPath = newPath;
    if (path.resolve(filePath) === path.resolve(newPath)) {
      // File is already in the songs directory; no copy required
      logger.info('Source and destination are the same, skipping copy', { filePath });
    } else {
      // If a file with the same name already exists, append a timestamp to avoid overwrite
      if (await fs.pathExists(newPath)) {
        const basename = path.basename(fileName, path.extname(fileName));
        const uniqueName = `${basename}_${Date.now()}${path.extname(fileName)}`;
        destinationPath = path.join(songsPath, uniqueName);
      }
      await fs.copy(filePath, destinationPath);
    }

    // Get duration from metadata
    let duration = 0;
    try {
      const { parseFile } = await import('music-metadata');
      const metadata = await parseFile(newPath);
      duration = metadata.format.duration;
    } catch (error) {
      logger.error('Error reading metadata for local file', error, { filePath });
      // Try extracting duration using our audio extraction method
      try {
        duration = await extractAudioDuration(destinationPath);
        if (duration && duration > 0) {
          logger.info(`Extracted duration using audio extraction: ${duration}s`, { filePath });
        }
      } catch (extractError) {
        logger.error('Error extracting duration from audio file', extractError, { filePath });
      }
    }

    const track = {
      id: uuidv4(),
      name: path.basename(fileName, path.extname(fileName)),
      filePath: toRelativePath(destinationPath), // Store relative path in playlist file
      fileType: fileExt,
      duration, // Save duration
      volume: 0.5,
      addedAt: new Date().toISOString()
    };

    logger.info('Local file added successfully', {
      trackId: track.id,
      fileName,
      fileType: fileExt
    });

    // Return track with absolute path for renderer (consistent with get-playlists)
    return { ...track, filePath: toAbsolutePath(track.filePath) };
  } catch (error) {
    logger.error('Error adding local file', error, { filePath, playlistId });
    throw error;
  }
});

// IPC handler for adding local files from drag and drop (with file content)
withErrorHandling('add-local-file-content', async (event, { fileName, fileContent, playlistId }) => {
  const startTime = Date.now();
  try {
    // Validate input parameters
    if (!fileName) {
      throw new Error('fileName is required but was undefined or empty');
    }
    if (!fileContent) {
      throw new Error('fileContent is required but was undefined or empty');
    }
    if (!playlistId) {
      throw new Error('playlistId is required but was undefined or empty');
    }

    logger.userAction('add-local-file-content-requested', { fileName, playlistId });
    const fileExt = path.extname(fileName).slice(1);
    const baseName = path.basename(fileName, path.extname(fileName));
    const newPath = path.join(songsPath, fileName);

    // If a file with the same name already exists, append a timestamp to avoid overwrite
    let destinationPath = newPath;
    if (fs.existsSync(destinationPath)) {
      const timestamp = Date.now();
      const nameWithTimestamp = `${baseName}_${timestamp}.${fileExt}`;
      destinationPath = path.join(songsPath, nameWithTimestamp);
      logger.info('File already exists, using timestamped name', {
        originalPath: newPath,
        newPath: destinationPath
      });
    }

    // Write file content to destination
    await fs.writeFile(destinationPath, Buffer.from(fileContent));
    logger.info('File content written successfully', { destinationPath });

    // Get duration using ffprobe
    const duration = await extractAudioDuration(destinationPath);

    const track = {
      id: uuidv4(),
      name: path.basename(destinationPath, path.extname(destinationPath)),
      filePath: toRelativePath(destinationPath), // Store relative path in playlist file
      fileType: fileExt,
      duration, // Save duration
      volume: 0.5,
      addedAt: new Date().toISOString()
    };

    logger.info('Local file content added successfully', {
      trackId: track.id,
      fileName,
      fileType: fileExt
    });

    // Return track with absolute path for renderer (consistent with get-playlists)
    return { ...track, filePath: toAbsolutePath(track.filePath) };
  } catch (error) {
    logger.error('Error adding local file content', error, { fileName, playlistId });
    throw error;
  }
});

// IPC handler to upload cookies.txt file
withErrorHandling('upload-cookies-file', async () => {
  logger.userAction('upload-cookies-file');
  // Show dialog for selecting cookies.txt
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select cookies.txt',
    properties: ['openFile'],
    buttonLabel: 'Select File',
    filters: [{ name: 'Cookie Files', extensions: ['txt'] }]
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    logger.info('User cancelled cookies.txt selection');
    return false;
  }

  const sourcePath = result.filePaths[0];
  const destPath = path.join(app.getPath('userData'), 'cookies.txt');

  try {
    await fs.copy(sourcePath, destPath);
    logger.info('cookies.txt uploaded successfully', { destPath });
    return true;
  } catch (err) {
    logger.error('Failed to copy cookies.txt', err);
    throw err;
  }
});

// Helper – quick heuristic to decide if cookies file likely contains YouTube auth
function validateYouTubeCookies(cookiesPath) {
  try {
    const txt = fs.readFileSync(cookiesPath, 'utf8');
    return /\byoutube\.com\b/i.test(txt) || /\bSID\b|\bSAPISID\b|\b__Secure-3PAPISID\b/i.test(txt);
  } catch (err) {
    logger.debug('Failed to validate YouTube cookies format', err);
    return false;
  }
}

// Legacy boolean check (kept for backward-compat)
// IPC handler to check if cookies.txt exists
withErrorHandling('has-cookies-file', async () => {
  const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
  return await fs.pathExists(cookiesPath);
});

// New detailed status: { exists: boolean, valid: boolean }
withErrorHandling('get-cookies-status', async () => {
  const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
  const exists = await fs.pathExists(cookiesPath);
  const valid = exists ? validateYouTubeCookies(cookiesPath) : false;
  return { exists, valid };
});

// Utility: robustly clear directory with retries to avoid EBUSY locks
async function clearDirectoryWithRetries(dirPath, retries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fs.emptyDir(dirPath);
      return;
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      // Wait then retry (handles transient EBUSY / EPERM locks)
      logger.warn(`Retrying to clear directory: ${dirPath}. Attempt ${attempt}/${retries}`, err);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

// IPC handlers for backup/restore
withErrorHandling('create-backup', () => {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    logger.userAction('create-backup-requested');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupsPath, `backup-${timestamp}.zip`);
    const output = fs.createWriteStream(backupFile);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', async () => {
      try {
        const songCount = (await fs.readdir(songsPath)).length;
        const playlistCount = (await fs.readdir(playlistsPath)).length;
        logger.info('Backup created successfully', { backupFile, playlistCount, songCount });
        resolve(backupFile);
      } catch (err) {
        logger.error('Error getting backup stats', err);
        reject(err);
      }
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        logger.warn('Archiver warning: ', err);
      } else {
        logger.error('Archiver error: ', err);
        reject(err);
      }
    });

    archive.on('error', (err) => {
      logger.error('Error creating backup archive', err);
      reject(err);
    });

    archive.pipe(output);
    archive.directory(playlistsPath, 'playlists');
    archive.directory(songsPath, 'songs');
    archive.finalize();
  });
});

withErrorHandling('restore-backup', async (event, backupFile) => {
  const startTime = Date.now();
  try {
    logger.userAction('restore-backup-requested', { backupFile });

    // Notify renderer to stop playback and release file handles
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stop-playback');
      // Give renderer a moment to release file locks
      // Ask renderer to stop playback and wait for confirmation (max 3s)
      const playbackStopped = new Promise(res => {
        const timeout = setTimeout(() => res(false), 3000);
        ipcMain.once('playback-stopped', () => {
          clearTimeout(timeout);
          res(true);
        });
      });
      mainWindow.webContents.send('stop-playback');
      await playbackStopped;
    }

    // Clear existing data with robust retry handling to avoid file-lock errors
    await clearDirectoryWithRetries(playlistsPath);
    await clearDirectoryWithRetries(songsPath);

    // Extract backup to the app data directory
    await extract(backupFile, { dir: appDataPath });

    const songCount = (await fs.readdir(songsPath)).length;
    const playlistCount = (await fs.readdir(playlistsPath)).length;

    logger.info('Backup restored successfully', {
      backupFile,
      playlistsRestored: playlistCount,
      songsRestored: songCount
    });

    return true;
  } catch (error) {
    logger.error('Error restoring backup', error, { backupFile });
    throw error;
  }
});

withErrorHandling('get-backups', async () => {
  const startTime = Date.now();
  try {
    logger.userAction('get-backups-requested');
    const files = await fs.readdir(backupsPath);
    const backups = [];

    for (const file of files) {
      if (file.endsWith('.zip') && file.startsWith('backup-')) {
        const filePath = path.join(backupsPath, file);
        const stats = await fs.stat(filePath);
        backups.push({
          name: file,
          path: filePath,
          createdAt: stats.birthtime
        });
      }
    }

    const sortedBackups = backups.sort((a, b) => b.createdAt - a.createdAt);
    return sortedBackups;
  } catch (error) {
    logger.error('Error getting backups', error);
    throw error;
  }
});

withErrorHandling('delete-backup', async (event, backupPath) => {
  const startTime = Date.now();
  try {
    logger.userAction('delete-backup-requested', { backupPath });
    await fs.remove(backupPath);
    logger.info('Backup deleted successfully', { backupPath });
    return true;
  } catch (error) {
    logger.error('Error deleting backup', error, { backupPath });
    throw error;
  }
});

// Duration management


// File dialog handlers
withErrorHandling('show-open-dialog', async (options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  logger.info('Open dialog result', { canceled: result.canceled, fileCount: result.filePaths?.length || 0 });
  return result;
});

withErrorHandling('show-save-dialog', async (options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  logger.info('Save dialog result', { canceled: result.canceled, filePath: result.filePath });
  return result;
});

withErrorHandling('select-music-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Music Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Audio Files',
        extensions: ['mp3', 'flac', 'ogg', 'm4a', 'wav']
      },
      {
        name: 'All Files',
        extensions: ['*']
      }
    ]
  });
  logger.info('Music file selection result', { canceled: result.canceled, fileCount: result.filePaths?.length || 0 });
  return result;
});

withErrorHandling('export-all-songs', async () => {
  const startTime = Date.now();
  try {
    logger.userAction('export-all-songs-requested');

    // Show directory selection dialog
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Export Destination',
      properties: ['openDirectory'],
      buttonLabel: 'Select Folder'
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, message: 'Export cancelled by user' };
    }

    const exportPath = result.filePaths[0];
    logger.info('Export destination selected', { exportPath });

    // Get all song files from the songs directory
    const songFiles = await fs.readdir(songsPath);
    const audioFiles = songFiles.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp3', '.flac', '.ogg', '.m4a', '.wav'].includes(ext);
    });

    if (audioFiles.length === 0) {
      return { success: false, message: 'No audio files found to export' };
    }

    logger.info(`Starting export of ${audioFiles.length} audio files`);

    // Copy each audio file to the export directory
    let copiedCount = 0;
    let failedCount = 0;
    const failedFiles = [];

    for (const file of audioFiles) {
      try {
        const sourcePath = path.join(songsPath, file);
        const destPath = path.join(exportPath, file);

        // Check if file already exists and create unique name if needed
        let finalDestPath = destPath;
        if (await fs.pathExists(destPath)) {
          const basename = path.basename(file, path.extname(file));
          const ext = path.extname(file);
          const timestamp = Date.now();
          finalDestPath = path.join(exportPath, `${basename}_${timestamp}${ext}`);
        }

        await fs.copy(sourcePath, finalDestPath);
        copiedCount++;
        logger.info('File exported successfully', { file, destPath: finalDestPath });
      } catch (error) {
        failedCount++;
        failedFiles.push(file);
        logger.warn('Failed to export file', error, { file });
      }
    }

    const summary = {
      total: audioFiles.length,
      copied: copiedCount,
      failed: failedCount,
      failedFiles,
      exportPath
    };

    logger.info('Export completed', summary);

    return {
      success: true,
      message: `Export completed! ${copiedCount} files copied${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
      ...summary
    };

  } catch (error) {
    logger.error('Error during export', error);
    throw error;
  }
});

// Frontend logging handler
ipcMain.handle('log-frontend-event', async (event, logEntry) => {
  try {
    const { level = 'INFO', message = '', data } = logEntry || {};

    // Keep renderer logs visible in the main-process console, but do NOT forward
    // them back to the renderer to avoid duplicate log entries.
    const prefix = `[RENDERER ${level}]`;
    const args = data ? [prefix, message, data] : [prefix, message];

    switch (level) {
      case 'ERROR':
        console.error(...args);
        break;
      case 'WARN':
        console.warn(...args);
        break;
      default:
        console.log(...args);
        break;
    }

    return true;
  } catch (error) {
    // Ensure any failure here does not create an infinite logging loop.
    return false;
  }
});

// System-level volume control to bypass browser limitations
// IPC handler for opening external links
withErrorHandling('open-external-link', async (event, url) => {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('Invalid URL');
  }
  await shell.openExternal(url);
  return { success: true };
});

withErrorHandling('set-system-volume', async (volumeMultiplier) => {
  if (os.platform() !== 'win32') {
    logger.warn('System volume control not implemented for this platform.');
    return;
  }

  const volumePercent = Math.min(Math.round(volumeMultiplier * 100), 65535);
  const csharpCode = `
    using System.Runtime.InteropServices;
    public class Audio {
      [DllImport("user32.dll")]
      public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
      public static void SetVolume(int volume) {
        int command = 14 << 16;
        int level = volume * 655;
        SendMessage(0xFFFF, 0x319, 0x30292, command | level);
      }
    }
  `;

  const psCommand = `
    Add-Type -TypeDefinition '${csharpCode.replace(/'/g, "''")}';
    [Audio]::SetVolume(${volumePercent});
  `;

  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`, (error, stdout, stderr) => {
      if (error) {
        logger.error('Error setting system volume via PowerShell', { error: error.message, stderr });
        reject(error);
      } else {
        resolve();
      }
    });
  });
});



// App event handlers


app.on('window-all-closed', async () => {
  // Clean up worker pool and broadcast server
  await cleanupWorkerPool();
  await cleanupBroadcastServer();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
