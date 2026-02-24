const { ipcRenderer } = require('electron');
const path = require('path');
const { generateSessionId } = require('../utils/idGenerator');

// Frontend logging utility
class FrontendLogger {
  constructor() {
    this.sessionId = generateSessionId();
    this.startTime = Date.now();
  }


  async log(level, message, data = null) {
    // Also log to the renderer console for easier debugging
    const consoleArgs = [`[${level}] ${message}`];
    if (data) {
      consoleArgs.push(data);
    }
    switch (level) {
      case 'INFO':
        console.info(...consoleArgs);
        break;
      case 'WARN':
        console.warn(...consoleArgs);
        break;
      case 'ERROR':
        console.error(...consoleArgs);
        break;
      default:
        console.log(...consoleArgs);
        break;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      level,
      message,
      data,
      url: window.location.href,
      userAgent: navigator.userAgent
    };
    // (media event clock sync is set in setupAudioEventListeners())

    // Send to main process for UI display
    try {
      await ipcRenderer.invoke('log-frontend-event', logEntry);
    } catch (error) {
      // Silently fail if IPC fails to avoid loops
    }
  }

  async info(message, data = null) {
    await this.log('INFO', message, data);
  }

  async warn(message, data = null) {
    await this.log('WARN', message, data);
  }

  async error(message, error = null, data = null) {
    const errorData = {
      ...data,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : null
    };
    await this.log('ERROR', message, errorData);
  }

  async userAction(action, details = null) {
    await this.log('USER_ACTION', action, details);
  }
}

const frontendLogger = new FrontendLogger();

// ---------------------------------------------------------------------------
// Real-time log forwarding from main process & worker pool to renderer console
// ---------------------------------------------------------------------------
// Any call to utils/logger.js in the main process emits a `main-log` event.
// The ProcessWorkerPool emits a `worker-log` event that main.js forwards.
// The handlers below dump those messages directly to the DevTools console so
// the USER can always see what is happening without switching to the terminal.

ipcRenderer.on('main-log', (_, log) => {
  try {
    const { level = 'info', message = '', data } = log || {};
    const prefix = `[MAIN ${level.toUpperCase()}]`;
    const args = data ? [prefix, message, data] : [prefix, message];
    (console[level] || console.log)(...args);
  } catch (err) {
    console.error('[MAIN LOG] Failed to render log', err, log);
  }
});

ipcRenderer.on('worker-log', (_, log) => {
  try {
    const { level = 'info', message = '', data, workerId } = log || {};
    const prefix = `[WORKER${workerId !== undefined ? ' ' + workerId : ''} ${level.toUpperCase()}]`;
    const args = data ? [prefix, message, data] : [prefix, message];
    (console[level] || console.log)(...args);
  } catch (err) {
    console.error('[WORKER LOG] Failed to render log', err, log);
  }
});

// Handle comprehensive download completion notices
ipcRenderer.on('show-download-completion-notice', (_, data) => {
  try {
    const { title, message, ageRestrictedCount, failedCount, ageRestrictedTracks, failedTracks } = data;
    console.warn('[DOWNLOAD COMPLETION]', title, { ageRestrictedCount, failedCount, ageRestrictedTracks, failedTracks });

    // Build detailed track list
    let trackDetails = '';
    if (ageRestrictedTracks.length > 0) {
      trackDetails += `\n\nAge-restricted tracks: ${ageRestrictedTracks.slice(0, 3).join(', ')}${ageRestrictedTracks.length > 3 ? ` and ${ageRestrictedTracks.length - 3} more...` : ''}`;
    }
    if (failedTracks.length > 0) {
      trackDetails += `\n\nFailed tracks: ${failedTracks.slice(0, 3).join(', ')}${failedTracks.length > 3 ? ` and ${failedTracks.length - 3} more...` : ''}`;
    }

    // Show comprehensive notification
    showErrorNotification(
      title,
      `${message}${trackDetails}`
    );
  } catch (err) {
    console.error('[DOWNLOAD COMPLETION] Failed to show notice', err, data);
  }
});

// Keep legacy handler for backward compatibility
ipcRenderer.on('show-age-restricted-notice', (_, data) => {
  try {
    const { message, count, tracks } = data;
    console.warn('[AGE RESTRICTED]', message, { count, tracks });

    // Show user-friendly notification
    showErrorNotification(
      'Age-Restricted Content',
      `${message}\n\nAffected tracks: ${tracks.slice(0, 3).join(', ')}${tracks.length > 3 ? ` and ${tracks.length - 3} more...` : ''}`
    );
  } catch (err) {
    console.error('[AGE RESTRICTED] Failed to show notice', err, data);
  }
});

// Broadcast event handlers
ipcRenderer.on('broadcast-status-changed', (_, data) => {
  try {
    updateBroadcastStatus(data.running, data.url);
    frontendLogger.info('Broadcast status changed', data);
  } catch (err) {
    console.error('[BROADCAST] Failed to handle status change', err, data);
  }
});

ipcRenderer.on('broadcast-error', (_, data) => {
  try {
    showErrorNotification('Broadcast Error', data.error);
    frontendLogger.error('Broadcast server error', data);
  } catch (err) {
    console.error('[BROADCAST] Failed to handle error', err, data);
  }
});


// Helper function to convert hex color to RGB
function hexToRgb(hex) {
  if (!hex) return { r: 0, g: 0, b: 0 };
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

// Icon paths
const REPEAT_ICON = './assets/Repeat.svg';
const NO_REPEAT_ICON = './assets/NoRepeat.svg';
const SHUFFLE_ICON = './assets/Shuffle.png';
const NO_SHUFFLE_ICON = './assets/NoShuffle.png';

// ----- Audio setup -----
// Create a single hidden <audio> element that will be reused for every track
const audioElement = document.createElement('audio');
audioElement.id = 'audio-player';
audioElement.style.display = 'none';
document.body.appendChild(audioElement);

// Web Audio pipeline for true amplification beyond 1.0
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const srcNode = audioCtx.createMediaElementSource(audioElement);
const gainNode = audioCtx.createGain();
// Optional: tame clipping
const compressorNode = audioCtx.createDynamicsCompressor();

srcNode.connect(gainNode);
gainNode.connect(compressorNode);
compressorNode.connect(audioCtx.destination);

gainNode.gain.value = 1;
// A tiny floor to avoid absolute mathematical silence which some engines may treat as idle
const SILENT_GAIN_FLOOR = 1e-5; // ~-100 dB, effectively inaudible
function setPipelineGain(v) {
  try {
    const gv = (typeof v === 'number' && v > 0) ? v : SILENT_GAIN_FLOOR;
    gainNode.gain.value = gv;
  } catch (e) { frontendLogger.warn('setPipelineGain failed', e); }
}

// Global state
let currentPlaylist = null;
let currentTrack = null;
let currentTrackIndex = -1;
let isPlaying = false;
let isRepeat = false;
let isShuffle = false;
let shuffledIndices = []; // Array to store shuffled track indices
let shuffleIndex = -1; // Current position in shuffled array
let playlists = [];
// currentAudio removed - using audioElement instead
let appConfig = {};
let lastVolume = 1;
let globalVolume = 1; // New global volume multiplier
let isRestoringState = false; // Flag to prevent saving during restoration

// Audio context & visualizer globals
let audioContext = null;
let analyser = null;
let dataArray = null;

let elements = {};

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  // DOM elements
  elements = {
    // Audio element managed via Web Audio API
    audioPlayer: audioElement,

    // Loading
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingMessage: document.getElementById('loading-message'),

    // Playlists
    playlistsContainer: document.getElementById('playlists-container'),
    createPlaylistBtn: document.getElementById('create-playlist-btn'),
    currentPlaylistName: document.getElementById('current-playlist-name'),
    renamePlaylistBtn: document.getElementById('rename-playlist-btn'),
    deletePlaylistBtn: document.getElementById('delete-playlist-btn'),

    // Tracks
    tracksContainer: document.getElementById('tracks-container'),
    tracksList: document.getElementById('tracks-list'),
    dropZone: document.getElementById('drop-zone'),

    // Download
    urlInput: document.getElementById('url-input'),
    downloadBtn: document.getElementById('download-btn'),

    // Player controls
    playPauseBtn: document.getElementById('play-pause-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    repeatBtn: document.getElementById('repeat-btn'),
    shuffleBtn: document.getElementById('shuffle-btn'),
    progressSlider: document.getElementById('progress-slider'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeBtn: document.getElementById('volume-btn'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    currentTrackTitle: document.getElementById('current-track-title'),
    currentTrackArtist: document.getElementById('current-track-artist'),

    // Visualizer
    visualizer: document.getElementById('visualizer'),
    backgroundVisualizer: document.getElementById('background-visualizer'),

    // Modals
    themeModal: document.getElementById('theme-modal'),
    settingsModal: document.getElementById('settings-modal'),
    backupModal: document.getElementById('backup-modal'),
    playlistNameModal: document.getElementById('playlist-name-modal'),
    trackRenameModal: document.getElementById('track-rename-modal'),

    // Theme controls
    themeBtn: document.getElementById('theme-btn'),
    primaryColor: document.getElementById('primary-color'),
    secondaryColor: document.getElementById('secondary-color'),
    textIconColor: document.getElementById('text-icon-color'),
    visualizerColor: document.getElementById('visualizer-color'),
    saveThemeBtn: document.getElementById('save-theme-btn'),
    resetThemeBtn: document.getElementById('reset-theme-btn'),

    // Backup controls
    backupBtn: document.getElementById('backup-btn'),
    createBackupBtn: document.getElementById('create-backup-btn'),
    backupsList: document.getElementById('backups-list'),

    // Settings controls
    settingsBtn: document.getElementById('settings-btn'),
    visualizerEnabled: document.getElementById('visualizer-enabled'),
    saveRepeatState: document.getElementById('save-repeat-state'),
    saveTrackTime: document.getElementById('save-track-time'),

    // Broadcast controls
    broadcastEnabled: document.getElementById('broadcast-enabled'),
    broadcastHost: document.getElementById('broadcast-host'),
    broadcastPort: document.getElementById('broadcast-port'),
    broadcastPublicHost: document.getElementById('broadcast-public-host'),
    broadcastRequireToken: document.getElementById('broadcast-require-token'),
    generateTokenBtn: document.getElementById('generate-token-btn'),
    openBroadcastBtn: document.getElementById('open-broadcast-btn'),
    broadcastStatus: document.getElementById('broadcast-status'),
    shareableUrl: document.getElementById('shareable-url'),
    copyUrlBtn: document.getElementById('copy-url-btn'),

    // Playlist name modal
    playlistModalTitle: document.getElementById('playlist-modal-title'),
    playlistNameInput: document.getElementById('playlist-name-input'),
    savePlaylistNameBtn: document.getElementById('save-playlist-name-btn'),
    cancelPlaylistNameBtn: document.getElementById('cancel-playlist-name-btn'),

    // Track rename modal
    trackNameInput: document.getElementById('track-name-input'),
    saveTrackNameBtn: document.getElementById('save-track-name-btn'),
    cancelTrackNameBtn: document.getElementById('cancel-track-name-btn'),
  };
  try {
    frontendLogger.info('DOM content loaded, initializing app');
    const startTime = Date.now();

    appConfig = await ipcRenderer.invoke('get-app-config');
    await initializeApp();
    setupEventListeners();
    setupAudioContext();
    if (appConfig.visualizer.enabled) {
      setupVisualizer();
      setupBackgroundVisualizer();
    }
    setupErrorHandlers();

    // Restore playback state after everything is initialized
    await restorePlaybackState();
    // Start UI ticker to keep time/progress responsive even if ontimeupdate is throttled
    try { startUITicker(); } catch (e) { frontendLogger.warn('startUITicker failed', e); }

    frontendLogger.info('App initialization completed successfully');
  } catch (error) {
    frontendLogger.error('Failed to initialize app', error);
    showErrorNotification('Initialization Failed', 'The application failed to start correctly. Check logs for details.');
    throw error;
  }
});

async function handleDownloadComplete({ playlistId, downloadedTracks }) {
  if (currentPlaylist && currentPlaylist.id === playlistId) {
    frontendLogger.info('Download complete, refreshing current playlist.', { playlistId, newTracks: downloadedTracks.length });

    // Find the full playlist data from the master list
    const updatedPlaylist = playlists.find(p => p.id === playlistId);
    if (updatedPlaylist) {
      // Manually add new tracks to the local playlist object to ensure it's up-to-date
      // This is needed because the main process updates the file, but the renderer's state needs to be synced
      downloadedTracks.forEach(newTrack => {
        if (!currentPlaylist.tracks.some(t => t.id === newTrack.id)) {
          currentPlaylist.tracks.push(newTrack);
        }
      });

      // Re-render the tracks for the current playlist
      renderTracks();
    } else {
      // If the playlist is not in the master list, reload all playlists
      await loadPlaylists();
      const newlyLoadedPlaylist = playlists.find(p => p.id === playlistId);
      if (newlyLoadedPlaylist) {
        await selectPlaylist(newlyLoadedPlaylist);
      }
    }
  } else {
    // If the download was for a different playlist, just reload the playlist list in the background
    await loadPlaylists();
  }
}

function setupDownloadListeners() {
  ipcRenderer.on('download-started', () => {
    elements.loadingOverlay.style.display = 'flex';
    frontendLogger.info('Download started, showing loading overlay.');
  });

  ipcRenderer.on('download-finished', () => {
    elements.loadingOverlay.style.display = 'none';
    frontendLogger.info('Download finished, hiding loading overlay.');
  });

  // Note: download-complete handler is defined later in the IPC event listeners section

  // Note: download-error handler is defined later with proper error notification
}

async function initializeApp() {
  try {
    frontendLogger.info('Starting app initialization');

    // Load theme first to ensure consistent styling
    await loadTheme();

    // Apply theme consistency fixes
    applyThemeConsistencyFixes();

    // Load app version
    await loadAppVersion();

    // Load playlists
    await loadPlaylists();

    // Load backups
    await loadBackups();

    // Set initial state for buttons
    updateDownloadButtonState();

    frontendLogger.info('App initialized successfully');
  } catch (error) {
    frontendLogger.error('Error initializing app subsystems', error);
    showErrorNotification('Critical Error', 'Failed to initialize app subsystems. Restarting may be required.');
    throw error;
  }
}

// Theme management
async function loadTheme() {
  const startTime = Date.now();
  try {
    frontendLogger.info('Loading theme configuration');
    const storedTheme = await ipcRenderer.invoke('get-theme-config');
    const theme = {
      primaryColor: (storedTheme && storedTheme.primaryColor) || '#8b5cf6',
      secondaryColor: (storedTheme && storedTheme.secondaryColor) || '#374151',
      textIconColor: (storedTheme && storedTheme.textIconColor) || '#ffffff',
      visualizerColor: (storedTheme && storedTheme.visualizerColor) || '#10b981'
    };

    applyTheme(theme);
    updateThemeInputs(theme);
    frontendLogger.info('Theme loaded successfully');
  } catch (error) {
    frontendLogger.error('Error loading theme', error);
    showErrorNotification('Theme Error', 'Failed to load theme settings. Default styles will be used.');
  }
}

function updateDownloadButtonState() {
  if (currentPlaylist) {
    elements.downloadBtn.disabled = false;
    elements.downloadBtn.textContent = 'Download';
    elements.downloadBtn.title = 'Download from URL';
  } else {
    elements.downloadBtn.disabled = true;
    elements.downloadBtn.textContent = 'No Playlist Selected';
    elements.downloadBtn.title = 'Please select a playlist first';
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.style.setProperty('--primary-color', theme.primaryColor);
  root.style.setProperty('--secondary-color', theme.secondaryColor);
  root.style.setProperty('--visualizer-color', theme.visualizerColor || '#10b981');

  // Calculate theme-based text colors first
  const isLightBackground = getContrastColor(theme.secondaryColor).color === '#1f2937';

  // Calculate slider handle color as a shade of primary color
  const sliderHandleColor = lightenColor(theme.primaryColor, 10);
  const sliderHandleBorder = lightenColor(theme.primaryColor, -30); // Darker border
  root.style.setProperty('--slider-handle-color', sliderHandleColor);
  root.style.setProperty('--slider-handle-border', sliderHandleBorder);

  // Calculate placeholder color as a shade of secondary color
  const placeholderColor = isLightBackground ?
    lightenColor(theme.secondaryColor, -20) : // Darker shade for light backgrounds
    lightenColor(theme.secondaryColor, 40);   // Lighter shade for dark backgrounds
  root.style.setProperty('--placeholder-color', placeholderColor);


  // Use user-defined text and icon color without outline
  const textColor = theme.textIconColor || '#ffffff';

  // Create container colors that provide good contrast
  let containerColor, surfaceColor, borderColor;

  if (isLightBackground) {
    // Light background - use darker containers
    containerColor = lightenColor(theme.secondaryColor, -20); // Darker secondary
    surfaceColor = lightenColor(theme.secondaryColor, -15); // Darker secondary
    borderColor = lightenColor(theme.secondaryColor, -30); // Darker border
  } else {
    // Dark background - use lighter containers
    containerColor = lightenColor(theme.secondaryColor, 25);
    surfaceColor = lightenColor(theme.secondaryColor, 20);
    borderColor = lightenColor(theme.secondaryColor, 40);
  }

  // Create hover tints for theme colors
  const primaryHover = lightenColor(theme.primaryColor, 15);
  const secondaryHover = lightenColor(theme.secondaryColor, 15);

  // Apply calculated colors
  root.style.setProperty('--container-color', containerColor);
  root.style.setProperty('--surface-color', surfaceColor);
  root.style.setProperty('--border-color', borderColor);
  root.style.setProperty('--hover-color', primaryHover);
  root.style.setProperty('--secondary-hover', secondaryHover);
  root.style.setProperty('--theme-text-color', textColor);
  root.style.setProperty('--theme-text-shadow', 'none');
  root.style.setProperty('--theme-icon-color', textColor); // Icons use same color as text

  // Apply theme text styling to body
  document.body.style.color = textColor;
  document.body.style.textShadow = 'none';

  // Apply icon color to all SVG icons (excluding Ko-fi)
  applyIconColors(textColor);
}

function applyIconColors(iconColor) {
  // Apply color to all SVG icons except Ko-fi buttons
  const svgIcons = document.querySelectorAll('svg');
  svgIcons.forEach(svg => {
    const parentButton = svg.closest('button');
    // Skip Ko-fi buttons
    if (parentButton && parentButton.id === 'kofi-btn') {
      return;
    }

    // Apply color to SVG stroke and fill
    svg.style.stroke = iconColor;
    if (svg.getAttribute('fill') !== 'none' && svg.getAttribute('fill') !== 'currentColor') {
      svg.style.fill = iconColor;
    }
  });

  // Apply color to SVG images using stencil approach
  const svgImages = document.querySelectorAll('img[src$=".svg"]');

  svgImages.forEach(img => {
    // Skip Ko-fi image
    if (img.classList.contains('kofi-image')) {
      return;
    }

    // Use SVG as stencil - apply theme color directly
    applySVGStencilColor(img, iconColor);
  });
}

// Apply SVG stencil coloring - use SVG as mask with theme color
function applySVGStencilColor(imgElement, color) {
  // Use CSS mask to apply the SVG as a stencil with the theme color
  const originalSrc = imgElement.src;

  // Create a wrapper div if it doesn't exist
  let wrapper = imgElement.parentElement;
  if (!wrapper.classList.contains('svg-stencil-wrapper')) {
    wrapper = document.createElement('div');
    wrapper.className = 'svg-stencil-wrapper';
    imgElement.parentNode.insertBefore(wrapper, imgElement);
    wrapper.appendChild(imgElement);

    // Apply wrapper styles
    wrapper.style.display = 'inline-block';
    wrapper.style.width = imgElement.width ? imgElement.width + 'px' : 'auto';
    wrapper.style.height = imgElement.height ? imgElement.height + 'px' : 'auto';
  }

  // Apply stencil effect using CSS mask
  wrapper.style.backgroundColor = color;
  wrapper.style.webkitMask = `url(${originalSrc}) no-repeat center`;
  wrapper.style.mask = `url(${originalSrc}) no-repeat center`;
  wrapper.style.webkitMaskSize = 'contain';
  wrapper.style.maskSize = 'contain';

  // Hide the original image
  imgElement.style.opacity = '0';
  imgElement.style.position = 'absolute';
}

function applyThemeConsistencyFixes() {
  // Ensure all dynamically created elements inherit proper styling
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Apply theme text styling to new elements
          if (!node.style.color && !node.classList.contains('btn')) {
            const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-text-color').trim();
            if (themeColor) {
              node.style.color = themeColor;
              node.style.textShadow = 'none';
            }
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Global animation frame handle for visualizer
let animationId = null;

function toggleVisualizer(enabled) {
  if (enabled) {
    if (!analyser) {
      setupAudioContext(); // This will set up the analyser and connect it properly
      setupVisualizer();
      setupBackgroundVisualizer();
    }
  } else {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (analyser) {
      // Disconnect analyser but maintain audio pipeline
      gainNode.disconnect();
      analyser.disconnect();
      // Reconnect gainNode directly to compressorNode to bypass analyser
      gainNode.connect(compressorNode);
      analyser = null;
    }
    const visualizer = elements.visualizer;
    if (visualizer) {
      const context = visualizer.getContext('2d');
      context.clearRect(0, 0, visualizer.width, visualizer.height);
    }
  }
}

// --- Playback clock using AudioContext time (robust when backgrounded) ---
let clockRunning = false;
let clockAnchorTrackTime = 0; // seconds at last anchor
let clockAnchorCtxTime = 0;   // audioCtx.currentTime at last anchor

function beginClock() {
  try {
    clockAnchorTrackTime = audioElement ? (audioElement.currentTime || 0) : 0;
    clockAnchorCtxTime = audioCtx ? (audioCtx.currentTime || 0) : 0;
    clockRunning = true;
  } catch (err) {
    frontendLogger.warn('Failed to begin media clock tracking', err);
  }
}

function pauseClock() {
  try {
    // Freeze anchor to the most accurate reading
    const nowT = getAccurateCurrentTime();
    clockAnchorTrackTime = nowT;
    clockAnchorCtxTime = audioCtx ? (audioCtx.currentTime || 0) : 0;
    clockRunning = false;
  } catch (err) {
    frontendLogger.warn('Failed to pause media clock tracking', err);
  }
}

function seekClock(newTime) {
  try {
    clockAnchorTrackTime = Math.max(0, Number(newTime) || 0);
    clockAnchorCtxTime = audioCtx ? (audioCtx.currentTime || 0) : 0;
  } catch (err) {
    frontendLogger.warn('Failed to seek media clock anchor', err);
  }
}

function getAccurateCurrentTime() {
  try {
    if (clockRunning && audioCtx && audioCtx.state !== 'suspended') {
      const delta = (audioCtx.currentTime || 0) - (clockAnchorCtxTime || 0);
      let t = (clockAnchorTrackTime || 0) + (isFinite(delta) ? delta : 0);
      const dur = audioElement ? (audioElement.duration || 0) : 0;
      if (dur > 0) t = Math.min(t, dur);
      if (t < 0) t = 0;
      return t;
    }
    return audioElement ? (audioElement.currentTime || 0) : 0;
  } catch (err) {
    frontendLogger.warn('Error reading accurate audio time, falling back to basic element time', err);
    return audioElement ? (audioElement.currentTime || 0) : 0;
  }
}

function startUITicker() {
  try {
    const TICK_MS = 250; // 4 Hz
    // Use a Web Worker for the ticker to avoid Chrome's background tab throttling (which caps setInterval at 1000ms)
    const workerCode = `
      let interval;
      self.onmessage = function(e) {
        if (e.data.command === 'start') {
          interval = setInterval(() => self.postMessage('tick'), e.data.interval);
        } else if (e.data.command === 'stop') {
          clearInterval(interval);
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    let lastBroadcastSync = 0;

    worker.onmessage = () => {
      try {
        if (!audioElement) return;
        const t = getAccurateCurrentTime();
        if (elements.currentTime) elements.currentTime.textContent = formatTime(t);
        if (elements.progressSlider) {
          if (!elements.progressSlider.max || Number(elements.progressSlider.max) === 0) {
            elements.progressSlider.max = audioElement.duration || 0;
          }
          elements.progressSlider.value = t;
        }

        // Unthrottled broadcast state update (~4 Hz)
        const now = Date.now();
        if (now - lastBroadcastSync > 250) {
          lastBroadcastSync = now;
          try { updateBroadcastState(); } catch (err) {
            frontendLogger.warn('Failed to update broadcast state from worker ticker', err);
          }
        }
      } catch (err) {
        frontendLogger.warn('UI ticker worker onmessage encountered an error', err);
      }
    };

    worker.postMessage({ command: 'start', interval: TICK_MS });
  } catch (err) {
    frontendLogger.warn('Failed to start UI ticker worker, falling back to setInterval', err);
    const TICK_MS = 250;
    let lastBroadcastSync = 0;
    setInterval(() => {
      try {
        if (!audioElement) return;
        const t = getAccurateCurrentTime();
        if (elements.currentTime) elements.currentTime.textContent = formatTime(t);
        if (elements.progressSlider) {
          if (!elements.progressSlider.max || Number(elements.progressSlider.max) === 0) {
            elements.progressSlider.max = audioElement.duration || 0;
          }
          elements.progressSlider.value = t;
        }

        const now = Date.now();
        if (now - lastBroadcastSync > 250) {
          lastBroadcastSync = now;
          try { updateBroadcastState(); } catch (err) {
            frontendLogger.warn('Failed to update broadcast state from interval ticker', err);
          }
        }
      } catch (err) {
        frontendLogger.warn('UI ticker interval encountered an error', err);
      }
    }, TICK_MS);
  }
}

function updateThemeInputs(theme) {
  elements.primaryColor.value = theme.primaryColor;
  elements.secondaryColor.value = theme.secondaryColor;
  elements.textIconColor.value = theme.textIconColor || '#ffffff';
  elements.visualizerColor.value = theme.visualizerColor || '#10b981';
}

// Playlist management
async function loadPlaylists() {
  const startTime = Date.now();
  try {
    frontendLogger.info('Loading playlists');
    playlists = await ipcRenderer.invoke('get-playlists');
    renderPlaylists();
    frontendLogger.info('Playlists loaded successfully', { count: playlists.length });
  } catch (error) {
    frontendLogger.error('Error loading playlists', error);
    showErrorNotification('Load Error', 'Failed to load playlists.');
  }
}

function renderPlaylists() {
  frontendLogger.info(`Rendering ${playlists.length} playlists.`);
  elements.playlistsContainer.innerHTML = '';

  if (!playlists || playlists.length === 0) {
    frontendLogger.warn('No playlists to render.');
    return;
  }

  playlists.forEach(playlist => {
    try {
      const playlistElement = createPlaylistElement(playlist);
      elements.playlistsContainer.appendChild(playlistElement);
    } catch (error) {
      frontendLogger.error('Error creating playlist element', error, { playlistId: playlist?.id });
      showErrorNotification('Render Error', `Failed to display playlist: ${playlist?.name || 'unknown'}`);
    }
  });
}

// Generic helper to create DOM elements
function createDOMElement(tag, className, dataset = {}, textContent = '') {
  const el = document.createElement(tag);
  el.className = className;
  if (textContent) {
    el.textContent = textContent;
  }
  for (const key in dataset) {
    el.dataset[key] = dataset[key];
  }
  return el;
}

function createPlaylistElement(playlist) {
  const playlistEl = createDOMElement('div', 'playlist-item', { playlistId: playlist.id });
  if (currentPlaylist && currentPlaylist.id === playlist.id) {
    playlistEl.classList.add('active');
  }

  const header = createDOMElement('div', 'playlist-item-header');
  const name = createDOMElement('span', 'playlist-name', {}, playlist.name);
  const actions = createDOMElement('div', 'playlist-item-actions');

  const renameButton = createDOMElement('button', 'btn btn-small btn-icon btn-primary');
  renameButton.title = 'Rename Playlist';
  renameButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-edit-2 icon-white"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;
  renameButton.onclick = () => renamePlaylist(playlist.id);

  const deleteButton = createDOMElement('button', 'btn btn-small btn-icon btn-secondary');
  deleteButton.title = 'Delete Playlist';
  deleteButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trash-2 icon-white"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
  deleteButton.onclick = () => deletePlaylist(playlist.id);

  actions.append(renameButton, deleteButton);
  header.append(name, actions);

  const trackCount = createDOMElement('div', 'playlist-track-count', {}, formatPlaylistInfo(playlist));

  playlistEl.append(header, trackCount);

  playlistEl.addEventListener('click', (e) => {
    if (!e.target.closest('button')) {
      frontendLogger.info('Playlist clicked', { playlistId: playlist.id, playlistName: playlist.name });
      selectPlaylist(playlist);
    }
  });

  playlistEl.addEventListener('dragover', handleDragOver);
  playlistEl.addEventListener('drop', (e) => handleTrackDrop(e, playlist.id));

  return playlistEl;
}

async function selectPlaylist(playlist) {
  try {
    frontendLogger.userAction('playlist-selected', { playlistId: playlist.id, playlistName: playlist.name, trackCount: playlist.tracks.length });

    currentPlaylist = playlist;

    // Update UI
    document.querySelectorAll('.playlist-item').forEach(item => {
      item.classList.remove('active');
    });

    document.querySelector(`[data-playlist-id="${playlist.id}"]`).classList.add('active');

    elements.currentPlaylistName.textContent = playlist.name;


    updateDownloadButtonState();

    renderTracks();

    // Generate shuffled indices if shuffle is enabled
    if (isShuffle) {
      generateShuffledIndices();
      frontendLogger.info('Generated shuffled indices for new playlist', { playlistId: playlist.id });
    }


  } catch (error) {
    frontendLogger.error('Error selecting playlist', error, { playlistId: playlist?.id });
    showErrorNotification('Playlist Error', `Failed to select playlist: ${playlist?.name || 'unknown'}`);
  }
}

function renderTracks() {
  if (!currentPlaylist) {
    // Clear only track items, preserving the drop zone
    elements.tracksList.querySelectorAll('.track-item').forEach(item => item.remove());
    return;
  }

  // Clear existing track items but preserve the drop zone
  elements.tracksList.querySelectorAll('.track-item').forEach(item => item.remove());

  // Append new tracks after the drop zone
  currentPlaylist.tracks.forEach((track, index) => {
    if (!track) return; // safety guard
    const trackElement = createTrackElement(track, index);
    elements.tracksList.appendChild(trackElement);
  });
}

function createTrackElement(track, index) {
  const trackEl = createDOMElement('div', 'track-item', { trackId: track.id, trackIndex: index });
  if (currentTrack && currentTrack.id === track.id) {
    trackEl.classList.add('playing');
  }

  if (typeof track.volume === 'undefined' || track.volume === null) {
    track.volume = 0.5;
  }

  const dragHandle = createDOMElement('div', 'drag-handle');
  dragHandle.draggable = true;
  dragHandle.title = 'Drag to reorder';
  dragHandle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-menu"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;

  const trackInfoEl = createDOMElement('div', 'track-info');
  const trackName = createDOMElement('div', 'track-name', {}, track.name);
  const trackDetails = createDOMElement('div', 'track-details');
  const fileType = track.filePath ? path.extname(track.filePath).slice(1) : (track.fileType || 'mp3');
  const typeSpan = createDOMElement('span', 'track-type', {}, fileType ? fileType.toUpperCase() : 'N/A');
  const durationSpan = createDOMElement('span', 'track-duration', {}, track.duration ? formatTime(track.duration) : '');
  trackDetails.append(typeSpan, durationSpan);
  trackInfoEl.append(trackName, trackDetails);

  const actions = createDOMElement('div', 'track-actions');
  const volumeControl = createDOMElement('div', 'track-volume-control');
  volumeControl.draggable = false;

  // Add volume icon
  const volumeIcon = createDOMElement('span', 'track-volume-icon');
  const getVolumeIcon = (volume) => {
    if (volume === 0) {
      return svgVolumeMute.replace('width="24" height="24"', 'width="16" height="16"');
    } else if (volume > 0 && volume <= 0.5) {
      return svgVolumeLow.replace('width="24" height="24"', 'width="16" height="16"');
    } else {
      return svgVolumeHigh.replace('width="24" height="24"', 'width="16" height="16"');
    }
  };
  volumeIcon.innerHTML = getVolumeIcon(track.volume);

  const volumeSlider = createDOMElement('input', 'slider track-volume-slider');
  volumeSlider.type = 'range';
  volumeSlider.min = 0;
  volumeSlider.max = 100;
  volumeSlider.value = track.volume * 100;
  volumeSlider.title = 'Track Volume';

  volumeControl.append(volumeIcon, volumeSlider);

  const renameButton = createDOMElement('button', 'btn btn-small btn-icon btn-primary track-rename-btn');
  renameButton.title = 'Rename Track';
  renameButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-edit-2 icon-white"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;

  const removeButton = createDOMElement('button', 'btn btn-small btn-icon btn-secondary track-remove-btn');
  removeButton.title = 'Remove from Playlist';
  removeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trash-2 icon-white"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;

  actions.append(volumeControl, renameButton, removeButton);
  trackEl.append(dragHandle, trackInfoEl, actions);

  volumeSlider.addEventListener('input', async (e) => {
    track.volume = e.target.value / 100;

    // Update the volume icon
    volumeIcon.innerHTML = getVolumeIcon(track.volume);

    savePlaylist(true);
    if (currentTrack && currentTrack.id === track.id) {
      const finalVolume = track.volume * globalVolume;
      setPipelineGain(finalVolume);
    }
    // Notify broadcast server so remote stream applies new track volume
    try { updateBroadcastState(); } catch (err) {
      frontendLogger.warn('Failed to update broadcast state on volume slider change', err);
    }
  });

  dragHandle.addEventListener('dragstart', handleTrackDragStart);
  trackEl.addEventListener('dragover', handleDragOver);
  trackEl.addEventListener('drop', handleTrackReorder);

  removeButton.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTrackFromCurrentPlaylist(track.id);
  });

  return trackEl;
}

async function removeTrackFromCurrentPlaylist(trackId) {
  if (!currentPlaylist) return;

  const trackIndex = currentPlaylist.tracks.findIndex(t => t.id === trackId);
  frontendLogger.info('removeTrackFromCurrentPlaylist', { trackId, trackIndex, currentTrackIndex, playlistLength: currentPlaylist.tracks.length });

  if (trackIndex > -1) {
    // If the removed track is the current one, stop playback.
    if (currentTrack && currentTrack.id === trackId) {
      // Temporarily detach error handler to avoid benign MEDIA_ELEMENT_ERROR when src is cleared
      const originalOnError = audioElement.onerror;
      const originalOnEnded = audioElement.onended;
      audioElement.onerror = null;
      audioElement.onended = null; // Temporarily disable to avoid automatic advance while clearing src
      audioElement.pause();
      audioElement.src = '';
      // Restore error handler asynchronously to prevent missing real errors
      setTimeout(() => {
        audioElement.onerror = originalOnError;
        audioElement.onended = originalOnEnded; // Restore onended handler
      }, 0);
      currentTrack = null;
      isPlaying = false;
      resetPlayerUI();
    }

    currentPlaylist.tracks.splice(trackIndex, 1);
    await savePlaylist(true);
    renderTracks();
    frontendLogger.info('Track removed from playlist', { trackId: trackId, playlistId: currentPlaylist.id });
  } else {
    frontendLogger.warn('Attempted to remove a track not found in the current playlist', { trackId: trackId });
  }
}

function resetPlayerUI() {
  elements.currentTrackTitle.textContent = 'No track selected';
  elements.currentTrackArtist.textContent = '';
  elements.currentTime.textContent = '0:00';
  elements.totalTime.textContent = '0:00';
  if (elements.progressSlider) elements.progressSlider.value = 0;

  // Clear playlist header data attributes for phone mode display
  const playlistHeader = document.querySelector('.playlist-header');
  if (playlistHeader) {
    playlistHeader.setAttribute('data-track-title', 'No track selected');
    playlistHeader.setAttribute('data-track-artist', '');
  }

  const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-play icon-white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  elements.playPauseBtn.innerHTML = playIcon;
  updateTrackHighlight();
}

// ---- Revised playTrack using single <audio> and Web Audio ----

// Audio playback with system volume control
let lastPlayedTrack = null;
let playbackAttempts = 0;
let lastFailedAttemptTime = 0;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown before retrying failed tracks

async function playTrack(track, index) {
  frontendLogger.info('playTrack', { trackId: track ? track.id : null, index });
  const startTime = Date.now();

  // Prevent infinite loops - if same track fails repeatedly, skip it temporarily
  if (lastPlayedTrack === track.id) {
    playbackAttempts++;
    if (playbackAttempts > 3) {
      const now = Date.now();
      // Check if enough time has passed since last failed attempt
      if (now - lastFailedAttemptTime < RETRY_COOLDOWN_MS) {
        frontendLogger.warn(`Skipping track ${track.name} - too many failed attempts (will retry in ${Math.ceil((RETRY_COOLDOWN_MS - (now - lastFailedAttemptTime)) / 60000)} minutes)`);
        // Skip to next track without deleting the problematic track
        if (currentPlaylist && currentPlaylist.tracks.length > 0) {
          playNext();
        }
        return;
      } else {
        // Reset attempts after cooldown period
        frontendLogger.info(`Retrying track ${track.name} after cooldown period`);
        playbackAttempts = 0;
        lastFailedAttemptTime = 0;
      }
    }
  } else {
    lastPlayedTrack = track.id;
    playbackAttempts = 0;
  }

  // Stop any currently playing track before starting a new one.
  audioElement.pause();

  try {

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    let absolutePath = track.filePath;
    if (!require('path').isAbsolute(track.filePath)) {
      absolutePath = require('path').join(require('path').dirname(require('path').dirname(__dirname)), 'data', track.filePath);
    }

    const normalizedPath = absolutePath.replace(/\\/g, '/');
    const fileUrl = `file:///${normalizedPath}`;

    audioElement.src = fileUrl;
    audioElement.load();
    audioElement.volume = 1;
    audioElement.muted = false; // keep unmuted; use gainNode for silence
    audioElement.playbackRate = 1.0; // enforce normal speed

    currentTrack = track;
    currentTrackIndex = index;
    // Immediately publish new track state to broadcast server
    try { updateBroadcastState(); } catch (err) {
      frontendLogger.warn('Failed to broadcast track state before playback start', err);
    }

    const finalVolume = track.volume * globalVolume;
    setPipelineGain(finalVolume);

    currentAudio = audioElement;

    const playPromise = audioElement.play();

    if (playPromise !== undefined) {
      playPromise.then(() => {
        // Playback started successfully.
        isPlaying = true;
        try { beginClock(); } catch (err) {
          frontendLogger.warn('Failed to begin media clock on successful play promise resolution', err);
        }
        updatePlayerUI();
        updateTrackHighlight();
      }).catch(error => {
        if (error.name !== 'AbortError') {
          frontendLogger.error('Audio playback error', error, { trackId: track.id });
        }
      });
    }



  } catch (error) {
    frontendLogger.error('Error playing track', error, {
      trackId: track.id,
      trackName: track.name,
      filePath: track.filePath
    });
    showErrorNotification('Playback Error', `Failed to load track ${track.title || track.name}`);

    // Set failed attempt timestamp for cooldown logic
    if (lastPlayedTrack === track.id && playbackAttempts >= 3) {
      lastFailedAttemptTime = Date.now();
    }
  }
}

function updateRepeatIcon() {
  if (!elements.repeatBtn) return;
  const iconSrc = isRepeat ? REPEAT_ICON : NO_REPEAT_ICON;
  elements.repeatBtn.innerHTML = `<img src="${iconSrc}" alt="${isRepeat ? 'Repeat enabled' : 'Repeat disabled'}" width="32" height="32">`;
  elements.repeatBtn.classList.toggle('active', isRepeat);

  // Apply current theme color to the newly created SVG image using stencil approach
  const img = elements.repeatBtn.querySelector('img');
  if (img) {
    const currentIconColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-icon-color').trim() || '#ffffff';
    applySVGStencilColor(img, currentIconColor);
  }
}

function updateShuffleIcon() {
  if (!elements.shuffleBtn) return;
  const iconSrc = isShuffle ? SHUFFLE_ICON : NO_SHUFFLE_ICON;
  elements.shuffleBtn.innerHTML = `<img src="${iconSrc}" alt="${isShuffle ? 'Shuffle enabled' : 'Shuffle disabled'}" width="32" height="32">`;
  elements.shuffleBtn.classList.toggle('active', isShuffle);

  // Apply current theme color to the newly created image using stencil approach
  const img = elements.shuffleBtn.querySelector('img');
  if (img) {
    const currentIconColor = getComputedStyle(document.documentElement).getPropertyValue('--theme-icon-color').trim() || '#ffffff';
    applySVGStencilColor(img, currentIconColor);
  }
}

let availableIndices = [];
let playedIndices = [];

function generateShuffledIndices() {
  if (!currentPlaylist || currentPlaylist.tracks.length === 0) {
    availableIndices = [];
    playedIndices = [];
    return;
  }

  // Reset both arrays
  availableIndices = Array.from({ length: currentPlaylist.tracks.length }, (_, i) => i);
  playedIndices = [];

  // Fisher-Yates shuffle the available indices
  for (let i = availableIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [availableIndices[i], availableIndices[j]] = [availableIndices[j], availableIndices[i]];
  }

  // Log the newly generated shuffle pool
  frontendLogger.info('Generated new shuffle pool', { availableIndices: [...availableIndices] });
}

function toggleShuffle() {
  isShuffle = !isShuffle;
  updateShuffleIcon();

  if (isShuffle) {
    // Generate new shuffle order when enabling shuffle
    generateShuffledIndices();
    frontendLogger.info('Shuffle enabled', { playlistLength: currentPlaylist?.tracks.length });
  } else {
    // Clear shuffle data when disabling
    availableIndices = [];
    playedIndices = [];
    frontendLogger.info('Shuffle disabled');
  }

  // Save shuffle state to config
  if (appConfig.playbackState) {
    appConfig.playbackState.isShuffle = isShuffle;
    ipcRenderer.invoke('save-app-config', appConfig);
  }
}

function setupAudioEventListeners() {
  let lastSaveTime = 0;
  const SAVE_INTERVAL = 5000; // Save every 5 seconds

  audioElement.onloadedmetadata = () => {
    if (elements.totalTime) elements.totalTime.textContent = formatTime(audioElement.duration);
    if (elements.progressSlider) elements.progressSlider.max = audioElement.duration;
    // Inform broadcast listeners about new duration/metadata
    try { updateBroadcastState(); } catch (err) {
      frontendLogger.warn('Failed to update broadcast state on loaded metadata', err);
    }
  };
  audioElement.ontimeupdate = () => {
    // Throttled save of playback position
    const now = Date.now();
    if (now - lastSaveTime > SAVE_INTERVAL) {
      lastSaveTime = now;
      savePlaybackState();
    }
  };

  audioElement.onended = () => {
    frontendLogger.info('audioElement ended', { isRepeat, currentTrackIndex, playlistLength: currentPlaylist ? currentPlaylist.tracks.length : 0 });
    if (isRepeat) {
      // Restart current track seamlessly
      audioElement.currentTime = 0;
      audioElement.play();
      isPlaying = true;
      updatePlayerUI();
    } else {
      playNext();
    }
  };

  // Notify broadcast on any seek (mouse, keyboard, programmatic)
  audioElement.onseeked = () => {
    try { seekClock(audioElement ? (audioElement.currentTime || 0) : 0); } catch (err) {
      frontendLogger.warn('Failed to seek clock on media seeked event', err);
    }
    try { updateBroadcastState({ action: 'seek' }); } catch (err) {
      frontendLogger.warn('Failed to update broadcast state on media seeked event', err);
    }
  };

  // Sync clock with core media events and keep rate normalized
  try {
    audioElement.onplay = () => { try { beginClock(); } catch (err) { frontendLogger.warn('Clock sync: onplay failed', err); } };
    audioElement.onpause = () => { try { pauseClock(); } catch (err) { frontendLogger.warn('Clock sync: onpause failed', err); } };
    audioElement.onseeking = () => { try { seekClock(audioElement ? (audioElement.currentTime || 0) : 0); } catch (err) { frontendLogger.warn('Clock sync: onseeking failed', err); } };
    audioElement.onratechange = () => { try { audioElement.playbackRate = 1.0; } catch (err) { frontendLogger.warn('Clock sync: onratechange failed', err); } };
  } catch (err) {
    frontendLogger.warn('Failed to bind clock sync event listeners', err);
  }

  audioElement.onerror = () => {
    // Ignore benign errors triggered when src is intentionally cleared (e.g., MEDIA_ELEMENT_ERROR: Empty src attribute)
    const mediaErr = audioElement.error;
    // Suppress callbacks triggered when src is cleared or no media error information is available
    if (!audioElement.src || !currentTrack || !mediaErr || Object.keys(mediaErr).length === 0 || (mediaErr.message && mediaErr.message.includes('Empty src attribute'))) {
      return;
    }
    frontendLogger.error('Audio playback error', mediaErr, { trackId: currentTrack ? currentTrack.id : 'unknown' });
  };

  // Keep AudioContext active and playback rate normalized on visibility changes
  try {
    document.addEventListener('visibilitychange', async () => {
      try {
        if (!document.hidden && audioCtx && audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        if (audioElement) {
          audioElement.playbackRate = 1.0;
        }
      } catch (err) {
        frontendLogger.warn('Error during visibility change visibility recovery', err);
      }
    });
  } catch (err) {
    frontendLogger.warn('Failed to bind visibilitychange event listener', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupAudioEventListeners();
  updateRepeatIcon();
  updateShuffleIcon();
});

function updatePlayerUI() {
  if (currentTrack) {
    // Update track title if element exists
    if (elements.currentTrackTitle) {
      elements.currentTrackTitle.textContent = currentTrack.name;
    }
    // Update track artist if element exists
    if (elements.currentTrackArtist) {
      elements.currentTrackArtist.textContent = currentTrack.artist || 'Unknown Artist';
    }

    // Update playlist header data attributes for phone mode display
    const playlistHeader = document.querySelector('.playlist-header');
    if (playlistHeader) {
      playlistHeader.setAttribute('data-track-title', currentTrack.name);
      playlistHeader.setAttribute('data-track-artist', currentTrack.artist || 'Unknown Artist');
    }

    const playIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-play icon-white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    const pauseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-pause icon-white"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
    elements.playPauseBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
    updateRepeatIcon();
    updateShuffleIcon();

    // Update broadcast state
    updateBroadcastState();
  } else {
    resetPlayerUI();

    // Update broadcast state for no track
    updateBroadcastState();
  }
}

function updateTrackHighlight() {
  document.querySelectorAll('.track-item').forEach(item => {
    item.classList.remove('playing');
  });

  if (currentTrack) {
    const trackElement = document.querySelector(`[data-track-id="${currentTrack.id}"]`);
    if (trackElement) {
      trackElement.classList.add('playing');
    }
  }
}

// Audio context and visualizer
function setupAudioContext() {
  // Use the existing audio context and connect the analyser to the existing pipeline
  if (analyser) {
    return; // already set up
  }
  try {
    // Use the existing audioCtx instead of creating a new one
    audioContext = audioCtx;
    analyser = audioContext.createAnalyser();

    // Connect the analyser to the existing audio pipeline
    // Insert analyser between gainNode and compressorNode
    gainNode.disconnect(compressorNode);
    gainNode.connect(analyser);
    analyser.connect(compressorNode);

    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);

    frontendLogger.info('Audio context connected to visualizer successfully');
  } catch (error) {
    frontendLogger.error('Error setting up audio context', error);
  }
}

function setupVisualizer() {
  const canvas = elements.visualizer;
  const ctx = canvas.getContext('2d');

  function draw() {
    // Skip rendering when analyser isn't ready or when audio is not playing to save CPU
    if (!analyser || !dataArray || audioElement.paused) {
      animationId = requestAnimationFrame(draw);
      return;
    }

    analyser.getByteFrequencyData(dataArray);

    // Clear canvas completely for sharp bars
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / dataArray.length) * 2.5;
    let barHeight;
    let x = 0;

    // Get the current visualizer color from CSS
    const visualizerColor = getComputedStyle(document.documentElement).getPropertyValue('--visualizer-color').trim() || '#10b981';
    const rgb = hexToRgb(visualizerColor);

    for (let i = 0; i < dataArray.length; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height;

      // Use theme color with intensity variations
      const intensity = barHeight / canvas.height;
      const r = Math.floor(rgb.r * intensity + (255 - rgb.r) * 0.2);
      const g = Math.floor(rgb.g * intensity + (255 - rgb.g) * 0.2);
      const b = Math.floor(rgb.b * intensity + (255 - rgb.b) * 0.2);

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }

    // Schedule next frame and keep handle so we can cancel later
    animationId = requestAnimationFrame(draw);
  }

  // Start the visualizer loop and store the frame id so it can be cancelled
  animationId = requestAnimationFrame(draw);
}

// Background visualizer function
function setupBackgroundVisualizer() {
  const canvas = elements.backgroundVisualizer;
  if (!canvas) {
    frontendLogger.error('Background visualizer canvas not found');
    return;
  }

  frontendLogger.info('Setting up background visualizer', { canvas: !!canvas });
  const ctx = canvas.getContext('2d');

  // Set canvas size to match the content area
  function resizeCanvas() {
    // Dynamically calculate sidebar and header sizes to support vertical / collapsed layouts
    const sidebar = document.querySelector('.sidebar');
    const visibleSidebarWidth = (sidebar && getComputedStyle(sidebar).display !== 'none') ? sidebar.offsetWidth : 0;

    const header = document.querySelector('.header');
    const headerHeight = header ? header.offsetHeight : 0;

    // Position the canvas immediately after the sidebar / below the header
    canvas.style.left = `${visibleSidebarWidth}px`;
    canvas.style.top = `${headerHeight}px`;

    canvas.width = window.innerWidth - visibleSidebarWidth;
    canvas.height = window.innerHeight - headerHeight;
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  function drawBackground() {
    // Clear canvas completely for sharp bars (no fade effect)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Get the current visualizer color from CSS
    const visualizerColor = getComputedStyle(document.documentElement).getPropertyValue('--visualizer-color').trim() || '#10b981';
    const rgb = hexToRgb(visualizerColor);

    if (!analyser || !dataArray) {
      // Show a test pattern when no audio is playing
      const numBars = 64;
      const barWidth = canvas.width / numBars;
      const time = Date.now() * 0.001;

      for (let i = 0; i < numBars; i++) {
        const barHeight = (Math.sin(time + i * 0.1) * 0.5 + 0.5) * canvas.height * 0.3;
        const alpha = 0.4;

        ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
        ctx.fillRect(i * barWidth, canvas.height - barHeight, barWidth - 1, barHeight);
      }

      requestAnimationFrame(drawBackground);
      return;
    }

    analyser.getByteFrequencyData(dataArray);

    const barWidth = (canvas.width / dataArray.length) * 3;
    let barHeight;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height * 0.9;

      // Use theme color with higher alpha for sharp, visible bars
      const intensity = dataArray[i] / 255;
      const alpha = Math.max(0.3, intensity * 0.8); // Minimum alpha for visibility

      ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
      ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

      x += barWidth + 1;
    }

    requestAnimationFrame(drawBackground);
  }

  drawBackground();
}

// SVG icons for volume states
const svgVolumeMute = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-white"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
const svgVolumeLow = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-white"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
const svgVolumeHigh = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-white"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;

function updateVolumeIcon(volume) {
  if (!elements.volumeBtn) return;

  if (volume === 0) {
    elements.volumeBtn.innerHTML = svgVolumeMute;
  } else if (volume > 0 && volume <= 0.5) {
    elements.volumeBtn.innerHTML = svgVolumeLow;
  } else {
    elements.volumeBtn.innerHTML = svgVolumeHigh;
  }
}

function setVolume(volume) {
  // Allow amplification above 1.0 safely via GainNode
  if (currentTrack) {
    const finalVolume = currentTrack.volume * volume;
    setPipelineGain(finalVolume);
  } else {
    setPipelineGain(volume);
  }
  // Do NOT toggle the underlying media element's muted flag.
  // In Chromium/Electron, background tabs/windows with muted or silent media
  // can be subject to playback/timer throttling. Rely solely on the Web Audio
  // gainNode to achieve true silence at volume 0, which keeps the media pipeline
  // active at normal speed even when unfocused.
  globalVolume = volume;
  updateVolumeIcon(volume);

}

function toggleMute() {
  const isMuted = globalVolume === 0;
  if (isMuted) {
    setVolume(lastVolume || 1);
    elements.volumeSlider.value = (lastVolume || 1) * 100;
  } else {
    lastVolume = globalVolume;
    setVolume(0);
    elements.volumeSlider.value = 0;
  }
}

// Backup functions
async function loadBackups() {
  try {
    const backups = await ipcRenderer.invoke('get-backups');
    renderBackups(backups);
  } catch (error) {
    frontendLogger.error('Error loading backups', error);
    showErrorNotification('Backup Error', 'Failed to load backups.');
  }
}

function renderBackups(backups) {
  elements.backupsList.innerHTML = '';

  backups.forEach(backup => {
    const backupElement = createBackupElement(backup);
    elements.backupsList.appendChild(backupElement);
  });
}

function createBackupElement(backup) {
  const div = document.createElement('div');
  div.className = 'backup-item';

  const infoDiv = document.createElement('div');
  infoDiv.className = 'backup-info';
  infoDiv.innerHTML = `
    <span class="backup-name">${backup.name}</span>
    <span class="backup-date">Created: ${new Date(backup.createdAt).toLocaleString()}</span>
  `;

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'backup-actions';

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'btn btn-secondary';
  restoreBtn.textContent = 'Restore';
  restoreBtn.addEventListener('click', () => restoreBackup(backup.path));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-secondary';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteBackup(backup.path));

  actionsDiv.appendChild(restoreBtn);
  actionsDiv.appendChild(deleteBtn);

  div.appendChild(infoDiv);
  div.appendChild(actionsDiv);

  return div;
}

async function createBackup() {
  try {
    frontendLogger.info('Creating backup...');
    showLoading('Creating backup archive...');
    const backupFile = await ipcRenderer.invoke('create-backup');
    frontendLogger.info('Backup created successfully', { backupFile });
    await loadBackups(); // Refresh the list
  } catch (error) {
    frontendLogger.error('Error creating backup', error);
    showErrorNotification('Backup Error', 'Failed to create backup.');
  } finally {
    hideLoading();
  }
}

async function restoreBackup(backupPath) {
  if (await confirmDialog('Restoring a backup will overwrite current data. Are you sure?', 'Restore Backup')) {
    try {
      frontendLogger.info('Restoring backup...', { backupPath });
      showLoading('Restoring from backup...');
      await ipcRenderer.invoke('restore-backup', backupPath);
      frontendLogger.info('Backup restored successfully');

      // Reload the app to apply changes
      window.location.reload();
    } catch (error) {
      frontendLogger.error('Error restoring backup', error);
      showErrorNotification('Restore Error', 'Failed to restore backup.');
    } finally {
      hideLoading();
    }
  }
}

async function deleteBackup(backupPath) {
  if (await confirmDialog('Are you sure you want to delete this backup?', 'Delete Backup')) {
    try {
      await ipcRenderer.invoke('delete-backup', backupPath);
      await loadBackups();
    } catch (error) {
      frontendLogger.error('Error deleting backup', error);
      showErrorNotification('Backup Error', 'Failed to delete backup.');
    }
  }
}

// Event listeners
let isSeekDragging = false; // shared between UI handlers and audioElement.onseeked
function setupEventListeners() {
  // Player controls
  if (elements.playPauseBtn) elements.playPauseBtn.addEventListener('click', togglePlayPause);
  if (elements.prevBtn) elements.prevBtn.addEventListener('click', playPrevious);
  if (elements.nextBtn) elements.nextBtn.addEventListener('click', playNext);
  if (elements.repeatBtn) elements.repeatBtn.addEventListener('click', toggleRepeat);
  if (elements.shuffleBtn) elements.shuffleBtn.addEventListener('click', toggleShuffle);
  // Throttle broadcasting of seek events while dragging to avoid flooding
  let lastSeekBroadcast = 0;
  let seekBroadcastTimer = null;
  function scheduleSeekBroadcast() {
    const now = Date.now();
    const THROTTLE = 250; // 4 per second
    if (now - lastSeekBroadcast >= THROTTLE) {
      lastSeekBroadcast = now;
      try { updateBroadcastState({ action: 'seek' }); } catch (err) {
        frontendLogger.warn('Failed to broadcast throttled seek event', err);
      }
    } else {
      if (seekBroadcastTimer) clearTimeout(seekBroadcastTimer);
      seekBroadcastTimer = setTimeout(() => {
        lastSeekBroadcast = Date.now();
        try { updateBroadcastState({ action: 'seek' }); } catch (err) {
          frontendLogger.warn('Failed to broadcast throttled seek event', err);
        }
      }, THROTTLE - (now - lastSeekBroadcast));
    }
  }

  if (elements.progressSlider) {
    elements.progressSlider.addEventListener('mousedown', () => { isSeekDragging = true; });
    elements.progressSlider.addEventListener('touchstart', () => { isSeekDragging = true; }, { passive: true });
    elements.progressSlider.addEventListener('mouseup', () => { isSeekDragging = false; });
    elements.progressSlider.addEventListener('mouseleave', () => { isSeekDragging = false; });
    elements.progressSlider.addEventListener('touchend', () => { isSeekDragging = false; });
    elements.progressSlider.addEventListener('touchcancel', () => { isSeekDragging = false; });
  }

  if (elements.progressSlider) elements.progressSlider.addEventListener('input', (e) => {
    if (audioElement) {
      audioElement.currentTime = e.target.value;
      try { seekClock(e.target.value); } catch (err) {
        frontendLogger.warn('Failed to seek clock on slider input', err);
      }
      // Throttled broadcast while dragging
      scheduleSeekBroadcast();
    }
  });
  if (elements.progressSlider) elements.progressSlider.addEventListener('change', () => {
    // Final broadcast on release
    if (seekBroadcastTimer) { clearTimeout(seekBroadcastTimer); seekBroadcastTimer = null; }
    lastSeekBroadcast = Date.now();
    isSeekDragging = false;
    try { seekClock(audioElement ? (audioElement.currentTime || 0) : 0); } catch (err) {
      frontendLogger.warn('Failed to seek clock on slider change', err);
    }
    try { updateBroadcastState({ action: 'seek' }); } catch (err) {
      frontendLogger.warn('Failed to broadcast seek event on slider change', err);
    }
  });
  if (elements.volumeSlider) elements.volumeSlider.addEventListener('input', async (e) => {
    globalVolume = e.target.value / 100;

    if (currentTrack && audioElement) {
      const finalVolume = currentTrack.volume * globalVolume;
      gainNode.gain.value = finalVolume;
    }
    updateVolumeIcon(globalVolume);

  });
  if (elements.volumeBtn) {
    elements.volumeBtn.addEventListener('click', toggleMute);
    // Set initial volume icon
    updateVolumeIcon(globalVolume);
  }

  // Playlist controls
  if (elements.createPlaylistBtn) elements.createPlaylistBtn.addEventListener('click', () => showPlaylistNameModal());
  if (elements.deletePlaylistBtn) elements.deletePlaylistBtn.addEventListener('click', deleteCurrentPlaylist);

  // Download
  if (elements.downloadBtn) elements.downloadBtn.addEventListener('click', downloadFromUrl);

  // Theme
  if (elements.themeBtn) elements.themeBtn.addEventListener('click', () => showModal('theme-modal'));
  if (elements.saveThemeBtn) elements.saveThemeBtn.addEventListener('click', saveTheme);
  if (elements.resetThemeBtn) elements.resetThemeBtn.addEventListener('click', resetTheme);

  // Backup
  if (elements.backupBtn) elements.backupBtn.addEventListener('click', () => showModal('backup-modal'));
  if (elements.createBackupBtn) elements.createBackupBtn.addEventListener('click', createBackup);

  // Settings
  if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', () => {
    loadSettings().then(() => showModal('settings-modal'));
  });


  // Support buttons - Ko-fi and GitHub
  const setupExternalLink = (btnId, url, actionName) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          await ipcRenderer.invoke('open-external-link', url);
          frontendLogger.userAction(`${actionName}-link-opened`);
        } catch (error) {
          frontendLogger.error(`Failed to open ${actionName} link`, error);
        }
      });
    }
  };

  setupExternalLink('kofi-btn', 'https://ko-fi.com/r60dr60d', 'kofi');
  setupExternalLink('github-btn', 'https://github.com/Ultikynnys/MasterMusicPlayer', 'github');

  // Broadcast controls
  if (elements.generateTokenBtn) {
    elements.generateTokenBtn.addEventListener('click', async () => {
      try {
        const result = await ipcRenderer.invoke('generate-broadcast-token');
        if (result.success) {
          elements.shareableUrl.value = result.url;
          showSuccessNotification('New access token generated successfully');
          frontendLogger.userAction('broadcast-token-generated');
        }
      } catch (error) {
        frontendLogger.error('Failed to generate broadcast token', error);
        showErrorNotification('Failed to generate token', error.message);
      }
    });
  }

  if (elements.openBroadcastBtn) {
    elements.openBroadcastBtn.addEventListener('click', async () => {
      try {
        const url = elements.shareableUrl.value;
        if (url) {
          await ipcRenderer.invoke('open-external-link', url);
          frontendLogger.userAction('broadcast-page-opened');
        }
      } catch (error) {
        frontendLogger.error('Failed to open broadcast page', error);
        showErrorNotification('Failed to open broadcast page', error.message);
      }
    });
  }

  if (elements.copyUrlBtn) {
    elements.copyUrlBtn.addEventListener('click', async () => {
      try {
        const url = elements.shareableUrl.value;
        if (url) {
          await navigator.clipboard.writeText(url);
          showSuccessNotification('URL copied to clipboard');
          frontendLogger.userAction('broadcast-url-copied');
        }
      } catch (error) {
        frontendLogger.error('Failed to copy URL', error);
        showErrorNotification('Failed to copy URL', error.message);
      }
    });
  }

  // Auto-save settings when any setting changes
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal) {
    const formElements = settingsModal.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select, textarea');

    formElements.forEach(element => {
      const configPath = element.dataset.configPath;
      if (!configPath) return; // Skip elements without config path

      element.addEventListener('change', async (e) => {
        // Handle special cases that need immediate UI updates
        if (configPath === 'visualizer.enabled') {
          toggleVisualizerCanvas(e.target.checked);
        } else if (configPath.startsWith('broadcast.')) {
          // Handle broadcast settings changes
          await saveBroadcastSettings();
        }

        // Auto-save all settings
        await saveSettings();
        frontendLogger.info('Setting auto-saved', { configPath, value: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
      });
    });
  }



  // Modal controls
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      hideModal(e.target.closest('.modal').id);
    });
  });

  // Modal save/cancel buttons
  const modalButtons = [
    { save: 'savePlaylistNameBtn', cancel: 'cancelPlaylistNameBtn', modal: 'playlist-name-modal', saveHandler: savePlaylistName },
    { save: 'saveTrackNameBtn', cancel: 'cancelTrackNameBtn', modal: 'track-rename-modal', saveHandler: saveTrackName }
  ];

  modalButtons.forEach(({ save, cancel, modal, saveHandler }) => {
    if (elements[save]) elements[save].addEventListener('click', saveHandler);
    if (elements[cancel]) elements[cancel].addEventListener('click', () => hideModal(modal));
  });

  // Drag and drop
  elements.dropZone.addEventListener('dragover', handleDragOver);
  elements.dropZone.addEventListener('drop', handleFileDrop);

  // Click to select files
  elements.dropZone.addEventListener('click', handleDropZoneClick);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboardShortcuts);

  // Track actions (event delegation)
  elements.tracksList.addEventListener('click', (e) => {
    // Skip if clicking on volume slider or its children
    if (e.target.closest('.track-volume-slider, .volume-control, .volume-icon')) {
      e.stopPropagation();
      return;
    }

    const renameBtn = e.target.closest('.track-rename-btn');
    const removeBtn = e.target.closest('.track-remove-btn');

    if (renameBtn) {
      e.stopPropagation();
      const trackElement = e.target.closest('.track-item');
      if (trackElement) {
        const trackId = trackElement.dataset.trackId;
        if (currentPlaylist) {
          const track = currentPlaylist.tracks.find(t => t.id === trackId);
          if (track) {
            showTrackRenameModal(track);
          }
        }
      }
    } else if (removeBtn) {
      e.stopPropagation();
      const trackElement = e.target.closest('.track-item');
      if (trackElement) {
        const trackId = trackElement.dataset.trackId;
        removeTrackFromCurrentPlaylist(trackId);
      }


    } else {
      const trackElement = e.target.closest('.track-item');
      if (trackElement) {
        const trackIndex = parseInt(trackElement.dataset.trackIndex);
        if (!isNaN(trackIndex) && currentPlaylist && currentPlaylist.tracks[trackIndex]) {
          playTrack(currentPlaylist.tracks[trackIndex], trackIndex);
        }
      }
    }
  });

  // Save playback state when window is about to close
  window.addEventListener('beforeunload', (e) => {
    // Use synchronous approach for beforeunload to ensure it completes
    try {
      if (!appConfig.playbackState) {
        appConfig.playbackState = {};
      }

      appConfig.playbackState.volume = globalVolume;
      appConfig.playbackState.currentTrackId = currentTrack ? currentTrack.id : null;
      appConfig.playbackState.currentPlaylistId = currentPlaylist ? currentPlaylist.id : null;
      appConfig.playbackState.currentTime = audioElement.currentTime || 0;
      appConfig.playbackState.isRepeat = isRepeat;

      // Fire and forget - don't wait for response
      ipcRenderer.invoke('save-app-config', appConfig);
      frontendLogger.info('Playback state saved on window close');
    } catch (error) {
      frontendLogger.error('Failed to save playback state on close', error);
    }
  });
}

// Player control functions
function togglePlayPause() {
  if (!audioElement || !currentTrack) return;

  if (isPlaying) {
    audioElement.pause();
    isPlaying = false;
    try { pauseClock(); } catch (e) { frontendLogger.warn('pauseClock failed', e); }
  } else {
    // Recalculate volume before resuming playback
    if (currentTrack) {
      const finalVolume = currentTrack.volume * globalVolume;
      setPipelineGain(finalVolume);
    }
    audioElement.play().then(() => { try { beginClock(); } catch (e) { frontendLogger.warn('beginClock failed', e); } }).catch(error => {
      frontendLogger.error('Error playing audio', error);
    });
    isPlaying = true;
  }
  updatePlayerUI();
}

function playNext() {
  frontendLogger.info('playNext called', { currentTrackIndex, playlistLength: currentPlaylist ? currentPlaylist.tracks.length : 0, isShuffle, shuffleIndex });
  if (!currentPlaylist || currentPlaylist.tracks.length === 0) return;

  let nextIndex;
  if (isShuffle) {
    if (availableIndices.length === 0) {
      // All songs played, regenerate available indices
      generateShuffledIndices();
    }

    if (availableIndices.length > 0) {
      frontendLogger.info('Shuffle pool before picking next', { availableIndices: [...availableIndices] });
      // Pick the next song from available indices and track it
      nextIndex = availableIndices.shift();
      frontendLogger.info('Picked index from shuffle pool', { removedIndex: nextIndex, remainingPool: [...availableIndices] });
      playedIndices.push(nextIndex);
    } else {
      // Shuffle generation completely exhausted or failed. Stop forcefully.
      frontendLogger.error('Shuffle generation failed and pool exhausted.');
      showErrorNotification('Playback Error', 'Failed to generate shuffle sequence.');
      stopTrack();
      return;
    }
  } else {
    // Normal sequential playback
    nextIndex = (currentTrackIndex + 1) % currentPlaylist.tracks.length;
  }

  const nextTrack = currentPlaylist.tracks[nextIndex];
  playTrack(nextTrack, nextIndex);
}

function playPrevious() {
  frontendLogger.info('playPrevious called', { currentTrackIndex, playlistLength: currentPlaylist ? currentPlaylist.tracks.length : 0, isShuffle, shuffleIndex });
  if (!currentPlaylist || currentPlaylist.tracks.length === 0) return;

  let prevIndex;
  if (isShuffle) {
    if (playedIndices.length > 1) {
      // Go back to the previously played song
      playedIndices.pop(); // Remove current song
      prevIndex = playedIndices[playedIndices.length - 1];
      // Put the current song back into available indices
      if (currentTrackIndex >= 0) {
        availableIndices.unshift(currentTrackIndex);
      }
    } else {
      // No previous songs in history. Instead of falling back to sequential previous,
      // restart the current track to strictly enforce standard playback expectations.
      frontendLogger.info('No previous history in shuffle mode, restarting current track');
      if (typeof audioElement !== 'undefined' && audioElement) {
        audioElement.currentTime = 0;
        try { seekClock(0); } catch (err) { frontendLogger.warn('Seek clock failed', err); }
        try { updateBroadcastState({ action: 'seek' }); } catch (err) { frontendLogger.warn('Broadcast seek failed', err); }
      }
      return;
    }
  } else {
    // Normal sequential playback
    prevIndex = currentTrackIndex === 0 ? currentPlaylist.tracks.length - 1 : currentTrackIndex - 1;
  }

  const prevTrack = currentPlaylist.tracks[prevIndex];
  playTrack(prevTrack, prevIndex);
}

function toggleRepeat() {
  isRepeat = !isRepeat;
  updateRepeatIcon();
  updatePlayerUI();

}

function stopTrack() {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    isPlaying = false;
    updatePlayerUI();
  }
}

// Utility functions

let loadingTimeout = null;

function showLoading(message) {
  console.log('showLoading called with message:', message); // Debug log
  const overlay = document.getElementById('loading-overlay');
  const messageElement = overlay.querySelector('p');
  if (messageElement) {
    messageElement.textContent = message;
  }
  overlay.classList.remove('hidden');

  // Clear any existing timeout
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
}

function hideLoading() {
  console.log('hideLoading called'); // Debug log
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('hidden');

  // Clear the timeout when hiding
  if (loadingTimeout) {
    clearTimeout(loadingTimeout);
    loadingTimeout = null;
  }
}

// Shared notification modal helper (DRY: used by both error and success notifications)
function showNotificationModal(title, message) {
  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  const yesBtn = document.getElementById('confirm-yes-btn');
  const noBtn = document.getElementById('confirm-no-btn');

  titleEl.textContent = title;
  messageEl.textContent = message;
  yesBtn.textContent = 'OK';
  noBtn.style.display = 'none';

  const cleanup = () => {
    yesBtn.removeEventListener('click', onClose);
    modal.querySelector('.modal-close').removeEventListener('click', onClose);
    noBtn.style.display = '';
    hideModal('confirm-modal');
  };

  const onClose = () => {
    cleanup();
  };

  yesBtn.addEventListener('click', onClose);
  modal.querySelector('.modal-close').addEventListener('click', onClose);

  showModal('confirm-modal');
  yesBtn.focus();
}

function showErrorNotification(title, message) {
  frontendLogger.info('Showing error notification', { title, message });
  showNotificationModal(title, message);
}

function showSuccessNotification(title, message) {
  frontendLogger.info('Showing success notification', { title, message });
  showNotificationModal(title, message);
}

function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function calculatePlaylistDuration(playlist) {
  if (!playlist.tracks || playlist.tracks.length === 0) {
    return 0;
  }

  return playlist.tracks.reduce((total, track) => {
    // Handle null/undefined tracks or duration values
    if (!track || track.duration == null) {
      return total;
    }
    return total + track.duration;
  }, 0);
}

function formatPlaylistInfo(playlist) {
  const trackCount = playlist.tracks.length;
  const totalDuration = calculatePlaylistDuration(playlist);
  const trackText = trackCount === 1 ? 'track' : 'tracks';

  if (totalDuration === 0) {
    return `${trackCount} ${trackText}`;
  }

  return `${trackCount} ${trackText} • ${formatTime(totalDuration)}`;
}

function lightenColor(color, percent) {
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);

  let newR, newG, newB;

  if (percent > 0) {
    // Lighten
    newR = Math.min(255, Math.floor(r + (255 - r) * (percent / 100)));
    newG = Math.min(255, Math.floor(g + (255 - g) * (percent / 100)));
    newB = Math.min(255, Math.floor(b + (255 - b) * (percent / 100)));
  } else {
    // Darken
    const factor = (100 + percent) / 100;
    newR = Math.max(0, Math.floor(r * factor));
    newG = Math.max(0, Math.floor(g * factor));
    newB = Math.max(0, Math.floor(b * factor));
  }

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`;
}

function getContrastColor(backgroundColor) {
  // Calculate luminance of background color
  const hex = backgroundColor.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16) / 255;
  const g = parseInt(hex.substr(2, 2), 16) / 255;
  const b = parseInt(hex.substr(4, 2), 16) / 255;

  // Convert to linear RGB
  const toLinear = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b);

  // Calculate luminance
  const luminance = 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;

  // Return appropriate text color and shadow
  if (luminance > 0.5) {
    // Light background - use dark text
    return {
      color: '#1f2937',
      textShadow: '1px 1px 2px rgba(255, 255, 255, 0.8)'
    };
  } else {
    // Dark background - use light text
    return {
      color: 'white',
      textShadow: '1px 1px 2px rgba(0, 0, 0, 0.8)'
    };
  }
}

function showModal(modalId) {
  const modalEl = document.getElementById(modalId);
  // Append to body to guarantee highest stacking context and avoid stale layout issues
  if (modalEl && modalEl.parentElement !== document.body) {
    document.body.appendChild(modalEl);
  }
  modalEl.classList.remove('hidden');
}

function hideModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
}

// Show confirm dialog returning a promise that resolves to true/false
function confirmDialog(message, title = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const titleEl = document.getElementById('confirm-title');
    const yesBtn = document.getElementById('confirm-yes-btn');
    const noBtn = document.getElementById('confirm-no-btn');

    msgEl.textContent = message;
    titleEl.textContent = title;

    const cleanup = () => {
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      modal.querySelector('.modal-close').removeEventListener('click', onNo);
      hideModal('confirm-modal');
    };

    const onYes = () => {
      cleanup();
      resolve(true);
    };
    const onNo = () => {
      cleanup();
      resolve(false);
    };

    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    modal.querySelector('.modal-close').addEventListener('click', onNo);

    showModal('confirm-modal');
    yesBtn.focus();
  });
}

// Download functionality
async function downloadFromUrl() {
  frontendLogger.info('Download button clicked');

  const url = elements.urlInput.value.trim();
  if (!url || !currentPlaylist) {
    frontendLogger.warn('Download attempted with missing URL or playlist', { url: !!url, hasPlaylist: !!currentPlaylist });
    showErrorNotification('Missing Information', 'Please enter a URL and select a playlist first.');
    return;
  }

  const startTime = Date.now();
  try {
    frontendLogger.userAction('download-from-url-initiated', {
      url,
      playlistId: currentPlaylist.id,
      playlistName: currentPlaylist.name
    });

    // Show loading overlay immediately when download starts
    console.log('Starting download for URL:', url); // Debug log
    showLoading('Preparing download...');

    console.log('Sending IPC download request...'); // Debug log
    const result = await ipcRenderer.invoke('download-from-url', {
      url: url,
      playlistId: currentPlaylist.id
    });
    console.log('IPC download request result:', result); // Debug log

    elements.urlInput.value = '';
    frontendLogger.info('Download request sent successfully', { url });
  } catch (error) {
    hideLoading(); // Hide loading on error
    frontendLogger.error('Error downloading from URL', error, { url, playlistId: currentPlaylist?.id });
    showErrorNotification('Download Error', 'Error downloading from URL. Please check the URL and try again.');
  }
}

// removeTrackFromPlaylist removed — dead code, removeTrackFromCurrentPlaylist is used instead

// Playlist management functions
function renamePlaylist(playlistId) {
  const playlist = playlists.find(p => p.id === playlistId);
  if (playlist) {
    selectPlaylist(playlist);
    showPlaylistNameModal(true);
  }
}

async function deletePlaylist(playlistId) {
  const playlistToDelete = playlists.find(p => p.id === playlistId);
  if (!playlistToDelete) return;

  if (await confirmDialog(`Are you sure you want to delete \"${playlistToDelete.name}\"?`, 'Delete Playlist')) {
    try {
      await ipcRenderer.invoke('delete-playlist', playlistId);

      // Stop playback if the currently playing track belonged to the playlist we are deleting
      if (currentTrack && playlistToDelete.tracks.some(t => t.id === currentTrack.id)) {
        stopTrack();
        currentTrack = null;
        currentTrackIndex = -1;
        updateTrackHighlight();
      }

      playlists = playlists.filter(p => p.id !== playlistId);

      if (currentPlaylist && currentPlaylist.id === playlistId) {
        currentPlaylist = null;
        elements.currentPlaylistName.textContent = 'Select a playlist';
        if (elements.renamePlaylistBtn) elements.renamePlaylistBtn.disabled = true;
        if (elements.deletePlaylistBtn) elements.deletePlaylistBtn.disabled = true;
        updateDownloadButtonState();
        renderTracks(); // Clear the track list
      }

      renderPlaylists(); // Refresh the playlist list
    } catch (error) {
      frontendLogger.error('Error deleting playlist', error, { playlistId });
      showErrorNotification('Playlist Error', 'Failed to delete playlist.');
    }
  }
}

async function showPlaylistNameModal(isRename = false) {
  // Log opening of playlist name modal
  await frontendLogger.userAction(isRename ? 'playlist-rename-modal-opened' : 'playlist-create-modal-opened');
  if (isRename) {
    elements.playlistModalTitle.textContent = 'Rename Playlist';
    elements.playlistNameInput.value = currentPlaylist.name;
    elements.savePlaylistNameBtn.dataset.action = 'rename';
  } else {
    elements.playlistModalTitle.textContent = 'Create Playlist';
    elements.playlistNameInput.value = '';
    elements.savePlaylistNameBtn.dataset.action = 'create';
  }

  elements.playlistNameInput.removeAttribute('disabled');
  showModal('playlist-name-modal');
  // Ensure focus after any CSS/display updates
  // Retry focusing a few times in case layout/paint delays prevent it
  const tryFocus = (retries = 5) => {
    if (!retries) return;
    if (document.activeElement !== elements.playlistNameInput) {
      elements.playlistNameInput.focus();
      elements.playlistNameInput.select();
      setTimeout(() => tryFocus(retries - 1), 40);
    }
  };
  tryFocus();
}

async function savePlaylistName() {
  await frontendLogger.userAction('playlist-name-save-clicked');
  const name = elements.playlistNameInput.value.trim();
  if (!name) return;

  const action = elements.savePlaylistNameBtn.dataset.action;

  try {
    if (action === 'create') {
      await frontendLogger.info('Creating new playlist', { name });
      const newPlaylist = await ipcRenderer.invoke('create-playlist', name);
      playlists.push(newPlaylist);
      renderPlaylists();
    } else if (action === 'rename') {
      await frontendLogger.info('Renaming playlist', { oldName: currentPlaylist.name, newName: name, playlistId: currentPlaylist.id });
      currentPlaylist.name = name;
      await savePlaylist(true);
      elements.currentPlaylistName.textContent = name;

      // Update the name in the main playlists array as well
      const playlistInArray = playlists.find(p => p.id === currentPlaylist.id);
      if (playlistInArray) {
        playlistInArray.name = name;
      }

      renderPlaylists();
    }

    hideModal('playlist-name-modal');
  } catch (error) {
    frontendLogger.error('Error saving playlist:', error);
    showErrorNotification('Playlist Error', 'Failed to save playlist name.');
  }
}

async function deleteCurrentPlaylist() {
  if (!currentPlaylist) return;
  await deletePlaylist(currentPlaylist.id);
}

async function savePlaylist(skipRender = false) {
  if (!currentPlaylist) return;

  try {
    await ipcRenderer.invoke('update-playlist', currentPlaylist);

    // Update playlists array
    const index = playlists.findIndex(p => p.id === currentPlaylist.id);
    if (index !== -1) {
      playlists[index] = currentPlaylist;
    }
    if (!skipRender) {
      renderPlaylists();
    }
  } catch (error) {
    frontendLogger.error('Error saving playlist:', error);
    showErrorNotification('Playlist Error', 'Failed to save playlist.');
  }
}

// Track management
async function showTrackRenameModal(track) {
  await frontendLogger.userAction('track-rename-modal-opened', { trackId: track.id, currentName: track.name });
  elements.trackNameInput.value = track.name;
  elements.saveTrackNameBtn.dataset.trackId = track.id;
  showModal('track-rename-modal');
  elements.trackNameInput.focus();
}

async function saveTrackName() {
  await frontendLogger.userAction('track-name-save-clicked');
  const trackId = elements.saveTrackNameBtn.dataset.trackId;
  const newName = elements.trackNameInput.value.trim();

  if (!newName || !currentPlaylist) return;

  const track = currentPlaylist.tracks.find(t => t.id === trackId);
  if (track) {
    await frontendLogger.info('Renaming track', { trackId: track.id, oldName: track.name, newName });
    track.name = newName;
    await savePlaylist(true);
    renderTracks();
  }

  hideModal('track-rename-modal');
}

// removeTrackFromPlaylist was removed — it was dead code, use removeTrackFromCurrentPlaylist instead


// Drag and drop functionality
function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

// Helper function to read file as ArrayBuffer
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function handleFileDrop(e) {
  e.preventDefault();

  if (!currentPlaylist) {
    showErrorNotification('No Playlist Selected', 'Please select a playlist first');
    return;
  }

  const files = Array.from(e.dataTransfer.files);
  const audioFiles = files.filter(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    return ['mp3', 'flac', 'ogg', 'm4a', 'wav'].includes(ext);
  });

  // Process files sequentially to avoid overwhelming the system
  for (const file of audioFiles) {
    try {
      let track;

      // Check if file has a path (from file selector) or needs content reading (from drag & drop)
      if (file.path) {
        // File from file selector - use existing IPC handler
        track = await ipcRenderer.invoke('add-local-file', {
          filePath: file.path,
          playlistId: currentPlaylist.id
        });
      } else {
        // File from drag & drop - read content and use new IPC handler
        const fileContent = await readFileAsArrayBuffer(file);
        track = await ipcRenderer.invoke('add-local-file-content', {
          fileName: file.name,
          fileContent: Array.from(new Uint8Array(fileContent)),
          playlistId: currentPlaylist.id
        });
      }

      currentPlaylist.tracks.push(track);
      await savePlaylist(true);
      renderTracks();
    } catch (error) {
      frontendLogger.error('Error adding file', error, { fileName: file.name });
      showErrorNotification('File Error', `Failed to add file: ${file.name}`);
    }
  }
}

// Handle click on drop zone to open file selector
async function handleDropZoneClick() {
  if (!currentPlaylist) {
    showErrorNotification('No Playlist Selected', 'Please select a playlist first');
    return;
  }

  try {
    const result = await ipcRenderer.invoke('select-music-files');

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    // Process selected files using the same logic as drag and drop
    for (const filePath of result.filePaths) {
      try {
        const track = await ipcRenderer.invoke('add-local-file', {
          filePath: filePath,
          playlistId: currentPlaylist.id
        });

        currentPlaylist.tracks.push(track);
        await savePlaylist(true);
        renderTracks();
      } catch (error) {
        frontendLogger.error('Error adding file', error, { filePath });
        showErrorNotification('File Error', `Failed to add file: ${path.basename(filePath)}`);
      }
    }
  } catch (error) {
    frontendLogger.error('Error selecting music files', error);
    showErrorNotification('File Selection Error', 'Failed to open file selector');
  }
}

function handleTrackDragStart(e) {
  const item = e.target.closest('.track-item');
  if (!item) return;
  // Set drag data and replace default drag preview with a transparent pixel so no ghost image appears
  e.dataTransfer.setData('text/plain', item.dataset.trackIndex);
  const transparentPixel = new Image();
  // 1x1 transparent GIF
  transparentPixel.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  e.dataTransfer.setDragImage(transparentPixel, 0, 0);
  item.classList.add('dragging');
}

function handleTrackReorder(e) {
  e.preventDefault();

  const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'));
  const targetIndex = parseInt(e.target.closest('.track-item').dataset.trackIndex);

  if (draggedIndex !== targetIndex) {
    const draggedTrack = currentPlaylist.tracks[draggedIndex];
    currentPlaylist.tracks.splice(draggedIndex, 1);
    currentPlaylist.tracks.splice(targetIndex, 0, draggedTrack);

    savePlaylist(true);
    renderTracks();

    // After reordering, find the new index of the currently playing track
    if (currentTrack) {
      // Use optional chaining to safely access id in case of undefined blanks
      currentTrackIndex = currentPlaylist.tracks.findIndex(t => t?.id === currentTrack.id);
    }
  }

  document.querySelectorAll('.track-item').forEach(item => {
    item.classList.remove('dragging');
  });
}

function handleTrackDrop(e, playlistId) {
  e.preventDefault();

  const draggedIndex = parseInt(e.dataTransfer.getData('text/plain'));
  const draggedTrack = currentPlaylist.tracks[draggedIndex];

  if (playlistId !== currentPlaylist.id) {
    // Move track to different playlist
    const targetPlaylist = playlists.find(p => p.id === playlistId);
    if (targetPlaylist) {
      currentPlaylist.tracks.splice(draggedIndex, 1);
      targetPlaylist.tracks.push(draggedTrack);

      savePlaylist(true);
      ipcRenderer.invoke('update-playlist', targetPlaylist);
      renderTracks();
      renderPlaylists();
    }
  }
}

// Theme functions
async function saveTheme() {
  const theme = {
    primaryColor: elements.primaryColor.value,
    secondaryColor: elements.secondaryColor.value,
    textIconColor: elements.textIconColor.value,
    visualizerColor: elements.visualizerColor.value
  };

  try {
    await ipcRenderer.invoke('update-theme-config', theme);
    applyTheme(theme);
    hideModal('theme-modal');
  } catch (error) {
    frontendLogger.error('Error saving theme', error);
    showErrorNotification('Theme Error', 'Failed to save theme.');
  }
}

async function resetTheme() {
  const defaultTheme = {
    primaryColor: '#8b5cf6',
    secondaryColor: '#374151',
    textIconColor: '#ffffff',
    visualizerColor: '#10b981'
  };

  try {
    await ipcRenderer.invoke('update-theme-config', defaultTheme);
    applyTheme(defaultTheme);
    updateThemeInputs(defaultTheme);
  } catch (error) {
    frontendLogger.error('Error resetting theme', error);
    showErrorNotification('Theme Error', 'Failed to reset theme.');
  }
}

// Settings functions
async function loadSettings() {
  try {
    appConfig = await ipcRenderer.invoke('get-app-config');
    updateSettingsInputs(appConfig);

    // Initialize broadcast UI
    await updateBroadcastUI();

    return appConfig;
  } catch (error) {
    frontendLogger.error('Failed to load settings', error);
    showErrorNotification('Settings Error', 'Failed to load settings.');
    return null;
  }
}

// Load app version from package.json
async function loadAppVersion() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = version;
      frontendLogger.info('App version loaded', { version });
    }
  } catch (error) {
    frontendLogger.error('Failed to load app version', error);
  }
}

function updateSettingsInputs(config) {
  // Automatically scan all form elements in settings modal
  const settingsModal = document.getElementById('settings-modal');
  const formElements = settingsModal.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select, textarea');

  // Process each form element based on its data attributes
  formElements.forEach(element => {
    const configPath = element.dataset.configPath;
    const defaultValue = element.dataset.defaultValue;
    if (!configPath) return; // Skip elements without config path

    const pathParts = configPath.split('.');
    let configValue = config;

    // Navigate through the config object to get the value
    for (const part of pathParts) {
      configValue = configValue?.[part];
    }

    // Set the element value based on type, with fallback to default
    if (element.type === 'checkbox') {
      const defaultBool = defaultValue === 'true' || defaultValue === true;
      element.checked = configValue ?? defaultBool;
    } else if (element.type === 'number') {
      const defaultNum = parseInt(defaultValue) || 0;
      element.value = configValue ?? defaultNum;
    } else {
      element.value = configValue ?? (defaultValue || '');
    }
  });

  // Handle special UI updates
  const visualizerEnabled = config.visualizer?.enabled ?? true;
  toggleVisualizerCanvas(visualizerEnabled);
}

async function saveSettings() {
  // Start with a deep copy of the existing config to preserve all settings
  const newConfig = JSON.parse(JSON.stringify(appConfig));

  // Automatically scan all form elements in settings modal
  const settingsModal = document.getElementById('settings-modal');
  const formElements = settingsModal.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select, textarea');

  // Process each form element based on its data attributes
  formElements.forEach(element => {
    const configPath = element.dataset.configPath;
    if (!configPath) return; // Skip elements without config path

    const pathParts = configPath.split('.');
    let configSection = newConfig;

    // Navigate to the correct config section, creating objects as needed
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!configSection[part]) {
        configSection[part] = {};
      }
      configSection = configSection[part];
    }

    // Set the value based on element type
    const finalKey = pathParts[pathParts.length - 1];
    if (element.type === 'checkbox') {
      configSection[finalKey] = element.checked;
    } else if (element.type === 'number') {
      configSection[finalKey] = parseInt(element.value) || 0;
    } else {
      configSection[finalKey] = element.value;
    }
  });

  try {
    const success = await ipcRenderer.invoke('save-app-config', newConfig);
    if (success) {
      // Handle special cases that need immediate UI updates
      const oldVisualizerState = appConfig.visualizer?.enabled;
      const newVisualizerState = newConfig.visualizer?.enabled;

      if (oldVisualizerState !== newVisualizerState) {
        toggleVisualizer(newVisualizerState);
      }

      // Update local config completely
      appConfig = newConfig;

      frontendLogger.info('Settings saved successfully', { savedSettings: newConfig });
    } else {
      throw new Error('Failed to save settings');
    }
  } catch (error) {
    frontendLogger.error('Failed to save settings', error);
    showErrorNotification('Settings Error', 'Failed to save settings. Please try again.');
  }
}

// Broadcast-specific settings functions
async function saveBroadcastSettings() {
  try {
    const broadcastConfig = {
      enabled: elements.broadcastEnabled?.checked || false,
      host: elements.broadcastHost?.value || '127.0.0.1',
      port: parseInt(elements.broadcastPort?.value) || 4583,
      publicHost: elements.broadcastPublicHost?.value || '',
      requireToken: elements.broadcastRequireToken?.checked !== false,
      accessToken: appConfig.broadcast?.accessToken || ''
    };

    const result = await ipcRenderer.invoke('update-broadcast-config', broadcastConfig);
    if (result.success) {
      // Update local config
      appConfig.broadcast = result.config;

      // Update UI
      await updateBroadcastUI();

      frontendLogger.info('Broadcast settings saved successfully');
    }
  } catch (error) {
    frontendLogger.error('Failed to save broadcast settings', error);
    showErrorNotification('Broadcast Error', 'Failed to save broadcast settings. Please try again.');
  }
}

async function updateBroadcastUI() {
  try {
    const status = await ipcRenderer.invoke('get-broadcast-status');
    updateBroadcastStatus(status.running, status.url);

    if (status.config) {
      // Update form elements with current config
      if (elements.broadcastEnabled) elements.broadcastEnabled.checked = status.config.enabled;
      if (elements.broadcastHost) elements.broadcastHost.value = status.config.host;
      if (elements.broadcastPort) elements.broadcastPort.value = status.config.port;
      if (elements.broadcastPublicHost) elements.broadcastPublicHost.value = status.config.publicHost || '';
      if (elements.broadcastRequireToken) elements.broadcastRequireToken.checked = status.config.requireToken;
    }
  } catch (error) {
    frontendLogger.error('Failed to update broadcast UI', error);
  }
}

function updateBroadcastStatus(isRunning, url) {
  if (elements.broadcastStatus) {
    elements.broadcastStatus.textContent = isRunning ? 'Running' : 'Stopped';
    elements.broadcastStatus.className = `status-indicator ${isRunning ? 'running' : 'stopped'}`;
  }

  if (elements.shareableUrl) {
    elements.shareableUrl.value = url || '';
  }

  if (elements.openBroadcastBtn) {
    elements.openBroadcastBtn.disabled = !isRunning || !url;
  }

  if (elements.copyUrlBtn) {
    elements.copyUrlBtn.disabled = !url;
  }
}

function updateBroadcastState(extra = {}) {
  try {
    const broadcastState = {
      track: currentTrack ? {
        id: currentTrack.id,
        name: currentTrack.name,
        artist: currentTrack.artist || 'Unknown Artist',
        filePath: currentTrack.filePath,
        duration: currentTrack.duration || 0,
        volume: typeof currentTrack.volume === 'number' ? currentTrack.volume : 1
      } : null,
      isPlaying: isPlaying,
      currentTime: getAccurateCurrentTime(),
      duration: audioElement.duration || 0,
      volume: globalVolume,
      playlist: currentPlaylist ? {
        id: currentPlaylist.id,
        name: currentPlaylist.name
      } : null,
      repeat: isRepeat,
      shuffle: isShuffle,
      timestamp: Date.now(), // Add server timestamp for synchronization
      ...extra
    };

    // Send to main process for broadcast
    ipcRenderer.invoke('update-broadcast-state', broadcastState).catch(error => {
      frontendLogger.error('Failed to update broadcast state', error);
    });
  } catch (error) {
    frontendLogger.error('Error updating broadcast state', error);
  }
}

// Keep broadcasting state at ~1 Hz regardless of window focus, as some environments throttle
// timeupdate events and timers when unfocused. This ensures remote clients keep receiving
// the latest currentTime and play/pause status.
setInterval(() => {
  try { updateBroadcastState(); } catch (e) { frontendLogger.warn('Broadcast heartbeat failed', e); }
}, 1000);

async function resetSettings() {
  // Automatically generate default config from form elements
  const defaultConfig = {
    download: {
      retryAttempts: 3 // Keep this as it's not a form element
    }
  };

  // Scan form elements to build default config
  const settingsModal = document.getElementById('settings-modal');
  const formElements = settingsModal.querySelectorAll('input[type="checkbox"], input[type="text"], input[type="number"], select, textarea');

  formElements.forEach(element => {
    const configPath = element.dataset.configPath;
    const defaultValue = element.dataset.defaultValue;
    if (!configPath || !defaultValue) return;

    const pathParts = configPath.split('.');
    let configSection = defaultConfig;

    // Navigate to the correct config section, creating objects as needed
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!configSection[part]) {
        configSection[part] = {};
      }
      configSection = configSection[part];
    }

    // Set the default value based on element type
    const finalKey = pathParts[pathParts.length - 1];
    if (element.type === 'checkbox') {
      configSection[finalKey] = defaultValue === 'true';
    } else if (element.type === 'number') {
      configSection[finalKey] = parseInt(defaultValue) || 0;
    } else {
      configSection[finalKey] = defaultValue;
    }
  });

  try {
    const success = await ipcRenderer.invoke('save-app-config', defaultConfig);
    if (success) {
      updateSettingsInputs(defaultConfig);
      frontendLogger.info('Settings reset to default', { defaultConfig });
      showErrorNotification('Settings Reset', 'Settings reset to default values.');
    } else {
      throw new Error('Failed to reset settings');
    }
  } catch (error) {
    frontendLogger.error('Failed to reset settings', error);
    showErrorNotification('Settings Error', 'Failed to reset settings. Please try again.');
  }
}

// Playback state persistence functions
async function savePlaybackState() {
  // Don't save during restoration to avoid overwriting the state we're trying to restore
  if (isRestoringState) {
    return;
  }

  if (!appConfig.playbackState) {
    appConfig.playbackState = {};
  }

  // Update playback state in config
  appConfig.playbackState.volume = globalVolume;

  // Only update track/playlist info if they exist, otherwise preserve existing values
  if (currentTrack && currentTrack.id) {
    appConfig.playbackState.currentTrackId = currentTrack.id;
  }
  if (currentPlaylist && currentPlaylist.id) {
    appConfig.playbackState.currentPlaylistId = currentPlaylist.id;
  }

  // Only save track time if setting is enabled
  if (appConfig.playbackState.saveTrackTime !== false) {
    appConfig.playbackState.currentTime = audioElement.currentTime || 0;
  }

  // Only save repeat state if setting is enabled
  if (appConfig.playbackState.saveRepeatState !== false) {
    appConfig.playbackState.isRepeat = isRepeat;
  }

  // Save shuffle state
  appConfig.playbackState.isShuffle = isShuffle;

}

async function restorePlaybackState() {
  try {
    if (!appConfig.playbackState) {
      frontendLogger.info('No playback state to restore');
      return;
    }

    // Set flag to prevent saving during restoration
    isRestoringState = true;

    const state = appConfig.playbackState;
    frontendLogger.info('Starting playback state restoration', state);
    console.log('Restoring playback state:', state);
    console.log('Current playlist ID:', state.currentPlaylistId);
    console.log('Current track ID:', state.currentTrackId);
    console.log('Current time:', state.currentTime);
    console.log('Volume:', state.volume);
    console.log('Is repeat:', state.isRepeat);
    console.log('Is shuffle:', state.isShuffle);

    // Restore volume
    if (typeof state.volume === 'number' && state.volume >= 0) {
      globalVolume = state.volume;
      if (elements.volumeSlider) {
        // Convert back to slider scale (0-100)
        const sliderValue = globalVolume * 100;
        elements.volumeSlider.value = sliderValue;
      }
      updateVolumeIcon(globalVolume);
      frontendLogger.info('Volume restored', { volume: globalVolume, sliderValue: elements.volumeSlider?.value });
    }

    // Restore repeat state only if setting is enabled
    if (typeof state.isRepeat === 'boolean' && state.saveRepeatState !== false) {
      isRepeat = state.isRepeat;
      updateRepeatIcon();
    }

    // Restore shuffle state
    if (typeof state.isShuffle === 'boolean') {
      isShuffle = state.isShuffle;
      updateShuffleIcon();
      // If shuffle was enabled, we'll regenerate shuffled indices when a playlist is selected
    }

    // Restore playlist and track
    if (state.currentPlaylistId && state.currentTrackId) {
      console.log('Attempting to restore playlist and track');
      // Wait for playlists to be loaded
      await new Promise(resolve => {
        const checkPlaylists = () => {
          if (playlists.length > 0) {
            console.log('Playlists loaded, proceeding with restoration');
            resolve();
          } else {
            console.log('Waiting for playlists to load...');
            setTimeout(checkPlaylists, 100);
          }
        };
        checkPlaylists();
      });

      // Add a small delay to ensure everything is fully initialized
      await new Promise(resolve => setTimeout(resolve, 500));

      console.log('Looking for playlist:', state.currentPlaylistId);
      console.log('Available playlists:', playlists.map(p => ({ id: p.id, name: p.name })));

      const playlist = playlists.find(p => p.id === state.currentPlaylistId);
      if (playlist) {
        console.log('Found playlist:', playlist.name);
        selectPlaylist(playlist);

        console.log('Looking for track:', state.currentTrackId);
        console.log('Available tracks:', playlist.tracks.map(t => ({ id: t.id, name: t.name })));

        const trackIndex = playlist.tracks.findIndex(t => t.id === state.currentTrackId);
        if (trackIndex !== -1) {
          const track = playlist.tracks[trackIndex];
          console.log('Found track:', track.name, 'at index:', trackIndex);

          // Load the track but don't auto-play
          currentTrack = track;
          currentTrackIndex = trackIndex;

          // Set up audio source
          audioElement.src = track.filePath;

          // Wait for metadata to load, then set current time
          audioElement.addEventListener('loadedmetadata', () => {
            // Only restore track time if setting is enabled
            if (typeof state.currentTime === 'number' && state.currentTime >= 0 && state.saveTrackTime !== false) {
              audioElement.currentTime = state.currentTime;
            }
            updatePlayerUI();
            updateTrackHighlight();
          }, { once: true });

          frontendLogger.info('Restored track position', {
            trackName: track.name,
            currentTime: state.currentTime
          });
        } else {
          console.log('Track not found with ID:', state.currentTrackId);
          frontendLogger.warn('Track not found during restoration', { trackId: state.currentTrackId });
        }
      } else {
        console.log('Playlist not found with ID:', state.currentPlaylistId);
        frontendLogger.warn('Playlist not found during restoration', { playlistId: state.currentPlaylistId });
      }
    } else {
      console.log('No playlist or track ID to restore');
    }

  } catch (error) {
    frontendLogger.error('Failed to restore playback state', error);
  } finally {
    // Clear restoration flag
    isRestoringState = false;
    frontendLogger.info('Playback state restoration completed');
  }
}

// Helper to show/hide visualizer canvas
function toggleVisualizerCanvas(enabled) {
  const canvas = document.getElementById('visualizer');
  const bgCanvas = document.getElementById('background-visualizer');
  if (canvas) canvas.style.display = enabled ? 'block' : 'none';
  if (bgCanvas) bgCanvas.style.display = enabled ? 'block' : 'none';
}

// Keyboard shortcuts
function handleKeyboardShortcuts(e) {
  if (e.target.tagName === 'INPUT') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowRight':
      if (e.ctrlKey) {
        e.preventDefault();
        playNext();
      }
      break;
    case 'ArrowLeft':
      if (e.ctrlKey) {
        e.preventDefault();
        playPrevious();
      }
      break;
    case 'KeyR':
      if (e.ctrlKey) {
        e.preventDefault();
        toggleRepeat();
      }
      break;
    case 'KeyS':
      if (e.ctrlKey) {
        e.preventDefault();
        toggleShuffle();
      }
      break;
    case 'F5':
      e.preventDefault();
      // Force reset the app by reloading the window
      window.location.reload();
      break;
  }
}

// Global error handlers
function setupErrorHandlers() {
  // Global error handler
  window.addEventListener('error', (event) => {
    frontendLogger.error('Global error caught', event.error, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      message: event.message
    });
  });

  // Unhandled promise rejection handler
  window.addEventListener('unhandledrejection', (event) => {
    frontendLogger.error('Unhandled promise rejection', event.reason, {
      promise: event.promise
    });
  });

  // Enhanced audio error handling system
  let errorHandlingInProgress = false;

  // Primary error handler - catches most errors
  audioElement.addEventListener('error', async (event) => {
    if (errorHandlingInProgress) return;
    await handleAudioError('error_event', event.target.error, audioElement.src);
  });

  // Secondary handler - catches load failures
  audioElement.addEventListener('loadstart', () => {
    // Reset error flag when starting new load
    errorHandlingInProgress = false;
  });

  // Catch network errors that don't trigger 'error' event
  audioElement.addEventListener('loadend', async () => {
    if (audioElement.networkState === HTMLMediaElement.NETWORK_NO_SOURCE && currentTrack) {
      await handleAudioError('network_no_source', null, audioElement.src);
    }
  });

  async function handleAudioError(errorType, error, src) {
    if (errorHandlingInProgress || !currentTrack) return;
    errorHandlingInProgress = true;

    frontendLogger.error(`Audio Error [${errorType}]`, error, {
      track: currentTrack.name,
      src: src
    });

    // Don't remove tracks automatically - just skip to next track
    frontendLogger.warn(`Skipping problematic track: ${currentTrack.name} (track preserved in playlist)`);

    // Set failed attempt timestamp for cooldown logic
    if (lastPlayedTrack === currentTrack.id) {
      lastFailedAttemptTime = Date.now();
    }

    // Continue playback without removing the track
    if (currentPlaylist && currentPlaylist.tracks.length > 0) {
      setTimeout(() => playNext(), 100); // Small delay to avoid rapid loops
    } else {
      resetPlayerUI();
    }
  }

  frontendLogger.info('Error handlers setup completed');
}

// IPC event listeners
// Note: worker-log and main-log handlers are defined at the top of the file (lines 88-108)

// showLoadingOverlay/hideLoadingOverlay removed — use showLoading/hideLoading instead

// Upload cookies.txt button handler
try {
  const uploadCookiesBtn = document.getElementById('upload-cookies-btn');
  const cookiesStatusSpan = document.getElementById('cookies-status');

  async function updateCookiesStatus() {
    try {
      const { exists, valid } = await ipcRenderer.invoke('get-cookies-status');
      if (cookiesStatusSpan) {
        if (!exists) {
          cookiesStatusSpan.textContent = 'No cookies';
          cookiesStatusSpan.className = 'status-indicator status-missing';
        } else if (!valid) {
          cookiesStatusSpan.textContent = 'Invalid cookies';
          cookiesStatusSpan.className = 'status-indicator status-warn';
        } else {
          cookiesStatusSpan.textContent = 'Cookies valid';
          cookiesStatusSpan.className = 'status-indicator status-ok';
        }
      }
    } catch {
      if (cookiesStatusSpan) {
        cookiesStatusSpan.textContent = 'Status unknown';
        cookiesStatusSpan.classList.remove('status-ok', 'status-missing');
      }
    }
  }

  updateCookiesStatus();
  if (uploadCookiesBtn) {
    uploadCookiesBtn.addEventListener('click', async () => {
      try {
        showLoading('Uploading cookies.txt...');
        const success = await ipcRenderer.invoke('upload-cookies-file');
        hideLoading();
        if (success) {
          showSuccessNotification('Cookies Uploaded', 'Your cookies.txt file has been saved successfully.');
          await updateCookiesStatus();
        } else {
          showErrorNotification('Upload Cancelled', 'No file was selected.');
        }
      } catch (err) {
        hideLoading();
        frontendLogger.error('Failed to upload cookies.txt', err);
        showErrorNotification('Upload Error', 'Failed to upload cookies.txt. Please try again.');
      }
    });
  }
} catch (uiErr) {
  console.error('Failed to wire cookies.txt upload button', uiErr);
}

// Track current download progress
let currentDownloadProgress = {
  title: '',
  percentage: 0,
  isDownloading: false
};

// Helper function to reset download progress
function resetDownloadProgress() {
  currentDownloadProgress = {
    title: '',
    percentage: 0,
    isDownloading: false
  };
}



// Helper to reload playlists and refresh the UI, typically after a background update
async function reloadAndRefreshUI(playlistIdToRefresh = null) {
  frontendLogger.info('Reloading playlists and refreshing UI');
  await loadPlaylists();

  if (playlistIdToRefresh && currentPlaylist && currentPlaylist.id === playlistIdToRefresh) {
    const updatedPlaylist = playlists.find(p => p.id === playlistIdToRefresh);
    if (updatedPlaylist) {
      currentPlaylist = updatedPlaylist;
      renderTracks();
      frontendLogger.info('Currently selected playlist has been refreshed.');
    }
  }
}

ipcRenderer.on('download-complete', async (event, data) => {
  frontendLogger.info('Download completed', data);

  resetDownloadProgress();

  // Add a small delay so users can see the completion message
  setTimeout(() => {
    hideLoading();
  }, 2000); // 2 second delay

  if (data && data.downloadedTracks && data.downloadedTracks.length > 0) {
    await reloadAndRefreshUI(data.playlistId);
  }
});

// Helper function to refresh playlist UI after changes
function refreshPlaylistUI(playlistId = null) {
  renderPlaylists();
  if (currentPlaylist && (!playlistId || currentPlaylist.id === playlistId)) {
    renderTracks();
  }
}

// Helper to add new tracks to a playlist and refresh UI
function handleNewTracks(playlistId, tracksToAdd) {
  if (!tracksToAdd || tracksToAdd.length === 0) {
    return;
  }

  frontendLogger.info(`Received ${tracksToAdd.length} new track(s) for playlist ${playlistId}`);

  const playlist = playlists.find(p => p.id === playlistId);
  if (playlist) {
    playlist.tracks.push(...tracksToAdd);
    refreshPlaylistUI(playlistId);
    frontendLogger.info(`Playlist updated successfully with ${tracksToAdd.length} new track(s).`);
  } else {
    frontendLogger.warn('Target playlist sync error. Reloading full playlist tree.', { playlistId });
    showErrorNotification('Desync Warning', 'The currently selected playlist data is out of sync. Reloading UI.');
    loadPlaylists();
  }
}

ipcRenderer.on('track-downloaded', (event, { playlistId, track }) => {
  if (track) {
    handleNewTracks(playlistId, [track]);
  }
});

ipcRenderer.on('download-progress', (event, { taskId, progress, trackInfo }) => {
  console.log('Download progress received:', { taskId, progress, trackInfo }); // Debug log
  frontendLogger.info('Download progress update', { taskId, progress, track: trackInfo?.title || 'unknown' });

  let message = '';
  if (trackInfo) {
    // Stage: preparing downloads with total track count
    if (trackInfo.totalTracks !== undefined) {
      message = trackInfo.title;
      if (trackInfo.skippedTracks > 0) {
        message += ` (${trackInfo.skippedTracks} already exist)`;
      }
    } else
      // Special case: initial metadata fetch
      if (taskId === 'fetching-info') {
        message = trackInfo.title;
      } else if (trackInfo.completed !== undefined && trackInfo.total !== undefined) {
        // Overall progress message
        const progressPercent = typeof progress === 'number' ? `${progress}%` : '';
        message = `${trackInfo.title} (${trackInfo.completed}/${trackInfo.total}) ${progressPercent}`;

        if (trackInfo.successful > 0 || trackInfo.failed > 0) {
          const stats = [];
          if (trackInfo.successful > 0) stats.push(`${trackInfo.successful} successful`);
          if (trackInfo.failed > 0) stats.push(`${trackInfo.failed} failed`);
          if (stats.length > 0) {
            message += ` - ${stats.join(', ')}`;
          }
        }
      } else {
        // Individual track progress
        const titlePart = trackInfo.title ? `"${trackInfo.title}"` : '...';
        const progressPart = typeof progress === 'number' ? `${progress.toFixed(1)}%` : '';
        message = `Downloading ${titlePart} ${progressPart}`.trim();
      }
  } else {
    // Fallback message
    const progressPart = typeof progress === 'number' ? `${progress.toFixed(1)}%` : '';
    message = `Downloading... ${progressPart}`.trim();
  }

  console.log('Updating loading message to:', message); // Debug log
  showLoading(message);
});

// Stop playback when requested by main process (e.g., before backup restore)
ipcRenderer.on('stop-playback', () => {
  try {
    if (typeof currentAudio !== 'undefined' && currentAudio && typeof currentAudio.pause === 'function') {
      currentAudio.pause();
      currentAudio.src = '';
    }
    if (typeof audioElement !== 'undefined' && audioElement && typeof audioElement.pause === 'function') {
      audioElement.pause();
      audioElement.src = '';
    }
    isPlaying = false;
    resetPlayerUI();
    frontendLogger.info('Playback stopped by main process');
    // Notify main process that playback has been fully stopped
    ipcRenderer.send('playback-stopped');
  } catch (err) {
    console.warn('Failed to stop playback', err);
  }
});

ipcRenderer.on('download-error', (event, errorData) => {
  // Enhanced error logging with more details
  frontendLogger.error('Download failed with error details', errorData, {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    downloadInProgress: currentDownloadProgress.isDownloading
  });

  // Reset progress tracking
  resetDownloadProgress();

  hideLoading();

  // Show proper UI notification instead of alert
  showErrorNotification(
    'Download Failed',
    errorData.error || 'Please check the URL and try again. See DevTools console for details.'
  );
});



ipcRenderer.on('durations-updated', async (event, result) => {
  frontendLogger.info(`Duration update completed: ${result.updated} tracks updated, ${result.failed} failed`);

  if (result.updated > 0) {
    await reloadAndRefreshUI(currentPlaylist?.id);
  }
});

ipcRenderer.on('tracks-downloaded', (event, { playlistId, newTracks }) => {
  try {
    handleNewTracks(playlistId, newTracks);
  } catch (error) {
    frontendLogger.error('Error handling downloaded tracks event', error, { playlistId });
  }
});

// Export all songs functionality
async function exportAllSongs() {
  try {
    frontendLogger.info('Export all songs requested');

    // Show loading state
    showLoading('Preparing export...');

    // Call the main process to handle the export
    const result = await ipcRenderer.invoke('export-all-songs');

    hideLoading();

    if (result.success) {
      showSuccessNotification('Export Complete', result.message);
      frontendLogger.info('Export completed successfully', {
        total: result.total,
        copied: result.copied,
        failed: result.failed,
        exportPath: result.exportPath
      });
    } else {
      showErrorNotification('Export Failed', result.message);
      frontendLogger.warn('Export failed', { message: result.message });
    }
  } catch (error) {
    hideLoading();
    frontendLogger.error('Export error', error);
    showErrorNotification('Export Error', 'An error occurred during export. Please try again.');
  }
}

// Set up export button event listener when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const exportButton = document.getElementById('export-songs-btn');
  if (exportButton) {
    exportButton.addEventListener('click', exportAllSongs);
    frontendLogger.info('Export button event listener added');
  } else {
    frontendLogger.warn('Export button not found in DOM');
  }
});
