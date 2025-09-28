const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');

// --- Theme helpers to mirror renderer behavior ---
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function hexToRgb(hex) {
  const cleaned = hex.replace('#','');
  const bigint = parseInt(cleaned.length === 3 ? cleaned.split('').map(c=>c+c).join('') : cleaned, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}
function rgbToHex(r,g,b){
  const toHex = (v)=>('0'+v.toString(16)).slice(-2);
  return `#${toHex(clamp(Math.round(r),0,255))}${toHex(clamp(Math.round(g),0,255))}${toHex(clamp(Math.round(b),0,255))}`;
}
// Lighten/darken by percentage (positive lightens, negative darkens)
function lightenColor(hex, percent){
  try{
    const {r,g,b} = hexToRgb(hex);
    const p = percent/100;
    const lr = p >= 0 ? r + (255 - r)*p : r*(1+p);
    const lg = p >= 0 ? g + (255 - g)*p : g*(1+p);
    const lb = p >= 0 ? b + (255 - b)*p : b*(1+p);
    return rgbToHex(lr,lg,lb);
  }catch{ return hex; }
}
function luminance({r,g,b}){
  const a=[r,g,b].map(v=>{v/=255;return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4)});
  return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2];
}
function isLightColor(hex){
  try{ return luminance(hexToRgb(hex)) > 0.6; }catch{ return false; }
}

class BroadcastServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.isRunning = false;
    this.config = {
      enabled: false,
      host: '127.0.0.1',
      port: 4583,
      publicHost: '',
      requireToken: true,
      accessToken: ''
    };
    this.currentState = {
      track: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 1,
      playlist: null,
      repeat: false,
      shuffle: false
    };
    this.clients = new Set();
    this.themeConfig = {};
  }

  /**
   * Start the broadcast server
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Broadcast server is already running');
      return false;
    }

    if (!this.config.enabled) {
      logger.info('Broadcast server is disabled');
      return false;
    }

    try {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      return new Promise((resolve, reject) => {
        this.server.listen(this.config.port, this.config.host, (err) => {
          if (err) {
            logger.error('Failed to start broadcast server', err);
            reject(err);
            return;
          }

          this.isRunning = true;
          logger.info(`Broadcast server started on ${this.config.host}:${this.config.port}`);
          this.emit('started', { host: this.config.host, port: this.config.port });
          resolve(true);
        });

        this.server.on('error', (err) => {
          logger.error('Broadcast server error', err);
          this.emit('error', err);
          reject(err);
        });
      });
    } catch (error) {
      logger.error('Error starting broadcast server', error);
      throw error;
    }
  }

  /**
   * Stop the broadcast server
   */
  async stop() {
    if (!this.isRunning || !this.server) {
      return true;
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.clients.clear();
        logger.info('Broadcast server stopped');
        this.emit('stopped');
        resolve(true);
      });
    });
  }

  /**
   * Update server configuration
   */
  updateConfig(newConfig) {
    const wasRunning = this.isRunning;
    const oldConfig = { ...this.config };
    
    this.config = { ...this.config, ...newConfig };
    
    // Generate token if required and not provided
    if (this.config.requireToken && !this.config.accessToken) {
      this.config.accessToken = this.generateAccessToken();
    }

    // Restart server if configuration changed and it was running
    if (wasRunning && (
      oldConfig.host !== this.config.host ||
      oldConfig.port !== this.config.port ||
      oldConfig.enabled !== this.config.enabled
    )) {
      this.stop().then(() => {
        if (this.config.enabled) {
          this.start();
        }
      });
    } else if (!wasRunning && this.config.enabled) {
      this.start();
    } else if (wasRunning && !this.config.enabled) {
      this.stop();
    }

    logger.info('Broadcast server config updated', { config: this.config });
    return this.config;
  }

  /**
   * Generate a secure access token
   */
  generateAccessToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Update the current playback state
   */
  updateState(newState) {
    this.currentState = { ...this.currentState, ...newState };
    this.broadcastStateUpdate();
    logger.debug('Broadcast state updated', this.currentState);
  }

  /**
   * Update theme configuration
   */
  updateTheme(themeConfig) {
    this.themeConfig = themeConfig || {};
    logger.debug('Broadcast theme updated', this.themeConfig);
  }

  /**
   * Broadcast state update to all connected clients
   */
  broadcastStateUpdate() {
    if (!this.isRunning) return;

    const stateData = JSON.stringify({
      type: 'state_update',
      data: this.currentState,
      timestamp: Date.now()
    });

    // In a real implementation, you'd send this to WebSocket clients
    // For now, we'll just emit an event
    this.emit('state_update', this.currentState);
  }

  /**
   * Get the shareable URL for the broadcast
   */
  getShareableUrl() {
    const host = this.config.publicHost || this.config.host;
    const baseUrl = `http://${host}:${this.config.port}`;
    
    if (this.config.requireToken && this.config.accessToken) {
      return `${baseUrl}?token=${this.config.accessToken}`;
    }
    
    return baseUrl;
  }

  /**
   * Validate access token from request
   */
  validateToken(req) {
    if (!this.config.requireToken) {
      return true;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    return token === this.config.accessToken;
  }

  /**
   * Handle HTTP requests
   */
  async handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Validate token if required
      if (!this.validateToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing access token' }));
        return;
      }

      // Route requests
      switch (pathname) {
        case '/':
          await this.serveNowPlayingPage(req, res);
          break;
        case '/api/state':
          await this.serveCurrentState(req, res);
          break;
        case '/api/heartbeat':
          await this.handleHeartbeat(req, res);
          break;
        case '/api/audio':
          await this.serveAudioStream(req, res);
          break;
        case '/api/theme':
          await this.serveThemeConfig(req, res);
          break;
        case '/assets/logo':
          await this.serveLogo(req, res);
          break;
        case '/assets/icon':
          await this.serveIcon(req, res);
          break;
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
      }
    } catch (error) {
      logger.error('Error handling broadcast request', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Serve the Now Playing page
   */
  async serveNowPlayingPage(req, res) {
    const html = this.generateNowPlayingHTML();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  /**
   * Serve current playback state as JSON
   */
  async serveCurrentState(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: this.currentState,
      timestamp: Date.now()
    }));
  }

  /**
   * Handle heartbeat requests for synchronization
   */
  async handleHeartbeat(req, res) {
    // Only accept GET requests for heartbeat
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Return current state with heartbeat response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      type: 'heartbeat',
      data: this.currentState,
      timestamp: Date.now()
    }));
  }

  /**
   * Serve audio stream for the current track
   */
  async serveAudioStream(req, res) {
    if (!this.currentState.track || !this.currentState.track.filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No track currently playing' }));
      return;
    }

    try {
      const filePath = this.currentState.track.filePath;
      
      if (!await fs.pathExists(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audio file not found' }));
        return;
      }

      const stat = await fs.stat(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        // Handle range requests for seeking
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        
        const stream = fs.createReadStream(filePath, { start, end });
        
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        
        stream.pipe(res);
      } else {
        // Serve entire file
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      }
    } catch (error) {
      logger.error('Error serving audio stream', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to serve audio' }));
    }
  }


  /**
   * Serve theme configuration
   */
  async serveThemeConfig(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      theme: this.themeConfig
    }));
  }

  /**
   * Serve application logo
   */
  async serveLogo(req, res) {
    try {
      const logoPath = path.join(__dirname, '..', '..', 'assets', 'logo.png');
      
      if (!await fs.pathExists(logoPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Logo not found' }));
        return;
      }

      const logoBuffer = await fs.readFile(logoPath);
      res.writeHead(200, { 
        'Content-Type': 'image/png',
        'Content-Length': logoBuffer.length,
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(logoBuffer);
    } catch (error) {
      logger.error('Error serving logo', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to serve logo' }));
    }
  }

  /**
   * Serve application icon
   */
  async serveIcon(req, res) {
    try {
      const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
      
      if (!await fs.pathExists(iconPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Icon not found' }));
        return;
      }

      const iconBuffer = await fs.readFile(iconPath);
      res.writeHead(200, { 
        'Content-Type': 'image/png',
        'Content-Length': iconBuffer.length,
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(iconBuffer);
    } catch (error) {
      logger.error('Error serving icon', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to serve icon' }));
    }
  }

  /**
   * Generate the Now Playing HTML page
   */
  generateNowPlayingHTML() {
    const track = this.currentState.track;
    const trackName = track ? track.name : 'No track playing';
    const isPlaying = this.currentState.isPlaying;
    const theme = this.themeConfig || {};
    
    // Base theme
    const primaryColor = theme.primaryColor || '#8b5cf6';
    const secondaryColor = theme.secondaryColor || '#374151';
    const textColor = theme.textIconColor || '#ffffff';
    const lightBg = isLightColor(secondaryColor);
    
    // Derived colors (match renderer applyTheme logic)
    const containerColor = theme.containerColor || (lightBg ? lightenColor(secondaryColor, -20) : lightenColor(secondaryColor, 25));
    const surfaceColor   = theme.surfaceColor   || (lightBg ? lightenColor(secondaryColor, -15) : lightenColor(secondaryColor, 20));
    const borderColor    = theme.borderColor    || (lightBg ? lightenColor(secondaryColor, -30) : lightenColor(secondaryColor, 40));
    const hoverColor     = theme.hoverColor     || lightenColor(primaryColor, 15);
    const secondaryHover = theme.secondaryHover || lightenColor(secondaryColor, 15);
    const sliderHandle   = lightenColor(primaryColor, 10);
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Now Playing - Master Music Player</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: ${secondaryColor};
            color: ${textColor};
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .container {
            text-align: center;
            max-width: 600px;
            padding: 2rem;
            background: ${surfaceColor};
            border: 1px solid ${borderColor};
            border-radius: 8px;
            box-shadow: none;
        }
        
        .logo {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 1rem;
            font-size: 2rem;
            font-weight: bold;
            margin-bottom: 2rem;
            opacity: 0.9;
        }
        
        .logo img {
            width: 48px;
            height: 48px;
            border-radius: 8px;
        }
        
        .track-info {
            margin-bottom: 2rem;
        }
        
        .track-name {
            font-size: 1.8rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            word-break: break-word;
        }
        
        .status {
            font-size: 1.2rem;
            opacity: 0.8;
            margin-bottom: 0.5rem;
        }
        
        .progress-info {
            font-size: 1rem;
            opacity: 0.7;
            margin-bottom: 1rem;
            font-family: monospace;
        }
        
        .controls {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        
        .volume-control {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .connection-control {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .connect-btn {
            background: ${primaryColor};
            border: 1px solid ${borderColor};
            color: ${textColor};
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 600;
            transition: all 0.3s ease;
            min-width: 150px;
        }
        
        .connect-btn:hover {
            background: ${hoverColor};
            border-color: ${borderColor};
            transform: translateY(-2px);
        }
        
        .connect-btn.connected {
            background: ${lightenColor(primaryColor, -5)};
            border-color: ${borderColor};
            color: ${textColor};
        }
        
        .connect-btn.connected:hover {
            background: ${lightenColor(primaryColor, 5)};
        }
        
        .volume-slider {
            width: 150px;
            height: 6px;
            background: ${containerColor};
            border-radius: 3px;
            outline: none;
            -webkit-appearance: none;
        }
        
        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 20px;
            height: 20px;
            background: ${sliderHandle};
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid ${borderColor};
        }
        
        .volume-slider::-moz-range-thumb {
            width: 20px;
            height: 20px;
            background: ${sliderHandle};
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid ${borderColor};
        }
        
        .audio-player {
            margin-bottom: 1rem;
        }
        
        audio {
            width: 100%;
            max-width: 400px;
        }
        
        .info {
            font-size: 0.9rem;
            opacity: 0.7;
            line-height: 1.5;
        }
        
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 0.5rem;
        }
        
        .status-playing {
            background: ${primaryColor};
            animation: pulse 2s infinite;
        }
        
        .status-paused {
            background: ${borderColor};
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <img src="/assets/logo" alt="Master Music Player" onerror="this.style.display='none'">
            Master Music Player
        </div>
        
        <div class="track-info">
            <div class="track-name" id="track-name">${trackName}</div>
            <div class="status">
                <span class="status-indicator ${isPlaying ? 'status-playing' : 'status-paused'}" id="status-indicator"></span>
                <span id="status-text">${isPlaying ? 'Playing' : 'Paused'}</span>
            </div>
            <div class="progress-info">
                <span id="current-time">0:00</span>
                <span> / </span>
                <span id="total-time">0:00</span>
            </div>
        </div>
        
        <div class="controls">
            <div class="volume-control">
                <span>🔊</span>
                <input type="range" class="volume-slider" id="volume-slider" 
                       min="0" max="100" value="100">
                <span id="volume-display">100%</span>
            </div>
            
            <div class="connection-control">
                <button class="connect-btn" id="connect-btn" onclick="toggleConnection()">
                    <span id="connection-status">Connect Audio</span>
                </button>
            </div>
        </div>
        
        <div class="audio-player" style="display:none;">
            <audio id="audio-player" ${track ? '' : 'style="display:none"'}>
                ${track ? `<source src="/api/audio${this.config.requireToken && this.config.accessToken ? '?token=' + this.config.accessToken : ''}" type="audio/mpeg">` : ''}
                Your browser does not support the audio element.
            </audio>
        </div>
        
        <div class="info">
            <p>Remote playback from Master Music Player</p>
            <p>Use the connect button to stream audio to this device</p>
            <p>Volume control is local to this device only</p>
        </div>
    </div>
    
    <script>
        let lastUpdateTime = 0;
        let isConnected = false;
        let audioPlayer = null;
        let currentTrackId = null;
        let deviceVolume = 1; // local slider volume (0..1), independent from app master
        let trackVolume = ${this.currentState.track && typeof this.currentState.track.volume === 'number' ? this.currentState.track.volume : 1}; // per-track (0..1)
        
        // Get token from URL
        const urlParams = new URLSearchParams(window.location.search);
        const accessToken = urlParams.get('token');
        
        // Helper to build API URLs with token + optional extra params
        function getApiUrl(endpoint, extraParams = {}) {
            const params = new URLSearchParams();
            // include caller-provided params first
            for (const [k, v] of Object.entries(extraParams)) {
                if (v !== undefined && v !== null) params.set(k, String(v));
            }
            if (accessToken) params.set('token', accessToken);
            const qs = params.toString();
            return qs ? (endpoint + '?' + qs) : endpoint;
        }
        
        // Helper function to format time in MM:SS format
        function formatTime(seconds) {
            if (isNaN(seconds) || seconds < 0) return '0:00';
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            return minutes + ':' + (remainingSeconds < 10 ? '0' : '') + remainingSeconds;
        }
        
        // Apply effective volume = deviceVolume * trackVolume
        function applyEffectiveVolume() {
            if (!audioPlayer) return;
            const v = Math.max(0, Math.min(1, deviceVolume * trackVolume));
            audioPlayer.volume = v;
        }
        
        // Send heartbeat and update state
        async function sendHeartbeat() {
            try {
                const response = await fetch(getApiUrl('/api/heartbeat'));
                const result = await response.json();
                
                if (result.success && result.timestamp > lastUpdateTime) {
                    lastUpdateTime = result.timestamp;
                    const state = result.data;
                    
                    // Update track info
                    document.getElementById('track-name').textContent = 
                        state.track ? state.track.name : 'No track playing';
                    
                    // Update status
                    const statusIndicator = document.getElementById('status-indicator');
                    const statusText = document.getElementById('status-text');
                    
                    if (state.isPlaying) {
                        statusIndicator.className = 'status-indicator status-playing';
                        statusText.textContent = 'Playing';
                    } else {
                        statusIndicator.className = 'status-indicator status-paused';
                        statusText.textContent = 'Paused';
                    }
                    
                    // Update progress info
                    if (state.currentTime !== undefined && state.duration !== undefined) {
                        const timeDiff = state.timestamp ? (Date.now() - state.timestamp) / 1000 : 0;
                        const currentTime = state.currentTime + (state.isPlaying ? timeDiff : 0);
                        
                        document.getElementById('current-time').textContent = formatTime(currentTime);
                        document.getElementById('total-time').textContent = formatTime(state.duration);
                    }
                    
                    // Update audio player if connected
                    if (isConnected && audioPlayer && state.track) {
                        // Check if track has changed
                        const trackChanged = currentTrackId !== state.track.id;
                        // Update track volume from state
                        trackVolume = (state.track && typeof state.track.volume === 'number') ? state.track.volume : 1;
                        if (trackChanged) {
                            currentTrackId = state.track.id;
                            console.log('Track changed to:', state.track.name);
                            
                            // Compute expected sync time based on heartbeat timestamp
                            const timeDiff = state.timestamp ? (Date.now() - state.timestamp) / 1000 : 0;
                            const expectedTime = (state.currentTime || 0) + (state.isPlaying ? timeDiff : 0);
                            
                            // Force reload audio source for new track with cache-busting version
                            const audioUrl = getApiUrl('/api/audio', { v: state.track.id });
                            audioPlayer.src = audioUrl;
                            audioPlayer.load(); // Force reload
                            
                            const onMeta = () => {
                                audioPlayer.removeEventListener('loadedmetadata', onMeta);
                                try { audioPlayer.currentTime = expectedTime; } catch (_) {}
                                // Apply per-track volume before play
                                applyEffectiveVolume();
                                if (state.isPlaying) {
                                    audioPlayer.play().catch(e => console.log('Playback failed:', e));
                                }
                            };
                            audioPlayer.addEventListener('loadedmetadata', onMeta);
                        } else {
                            // Same track - just sync position and state
                            
                            // Sync playback position with timestamp compensation
                            if (state.currentTime !== undefined && state.timestamp) {
                                const timeDiff = (Date.now() - state.timestamp) / 1000; // Convert to seconds
                                const expectedTime = state.currentTime + (state.isPlaying ? timeDiff : 0);
                                
                                // Only seek if the difference is significant (more than 2 seconds)
                                if (Math.abs(audioPlayer.currentTime - expectedTime) > 2) {
                                    audioPlayer.currentTime = expectedTime;
                                    console.log('Synced audio position to:', expectedTime.toFixed(2), 's');
                                }
                            }
                            
                            // Sync playback state
                            if (state.isPlaying && audioPlayer.paused) {
                                audioPlayer.play().catch(e => console.log('Playback failed:', e));
                            } else if (!state.isPlaying && !audioPlayer.paused) {
                                audioPlayer.pause();
                            }
                            // Apply effective volume on same-track updates as well
                            trackVolume = (state.track && typeof state.track.volume === 'number') ? state.track.volume : 1;
                            applyEffectiveVolume();
                        }
                    } else if (isConnected && audioPlayer && !state.track) {
                        // No track playing - clear current track
                        currentTrackId = null;
                        audioPlayer.pause();
                        audioPlayer.src = '';
                    }
                }
            } catch (error) {
                console.error('Heartbeat failed:', error);
            }
        }
        
        // Connection toggle
        function toggleConnection() {
            const connectBtn = document.getElementById('connect-btn');
            const connectionStatus = document.getElementById('connection-status');
            audioPlayer = document.getElementById('audio-player');
            
            if (!isConnected) {
                // Connect
                isConnected = true;
                connectBtn.classList.add('connected');
                connectionStatus.textContent = 'Disconnect Audio';
                
                // Reset track ID to force reload on next update
                currentTrackId = null;
                
                // Load current track
                audioPlayer.src = getApiUrl('/api/audio', { v: Date.now() });
                audioPlayer.load();
                applyEffectiveVolume();
                
                console.log('Audio connected');
            } else {
                // Disconnect
                isConnected = false;
                connectBtn.classList.remove('connected');
                connectionStatus.textContent = 'Connect Audio';
                
                // Stop and clear audio
                audioPlayer.pause();
                audioPlayer.src = '';
                currentTrackId = null;
                
                console.log('Audio disconnected');
            }
        }
        
        // Volume control
        const volumeSlider = document.getElementById('volume-slider');
        const volumeDisplay = document.getElementById('volume-display');
        
        volumeSlider.addEventListener('input', (e) => {
            deviceVolume = e.target.value / 100;
            volumeDisplay.textContent = e.target.value + '%';
            // Apply effective volume locally (no server communication)
            if (isConnected && audioPlayer) {
                applyEffectiveVolume();
            }
        });
        
        // Start heartbeat synchronization every 4 seconds
        sendHeartbeat();
        setInterval(sendHeartbeat, 4000);
    </script>
</body>
</html>`;
  }
}

module.exports = BroadcastServer;
