const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');

const { lightenColor, isLightColor } = require('./themeUtils');

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
      // Security options
      allowedIps: [],            // e.g. ["127.0.0.1", "192.168.1.0/24"] (CIDR not parsed yet, exact IPs supported)
      trustProxy: false,         // if true, use X-Forwarded-For for client IP
      hsts: false                // add HSTS header when serving behind TLS/reverse proxy
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
    this.sseClients = new Set(); // Set<http.ServerResponse>
    this.themeConfig = {};
    // Basic rate limiting (per IP)
    this.rateLimit = new Map();
    this.rateLimitConfig = { windowMs: 60_000, max: 120 };
    this.appDataPath = null;
  }

  /**
   * Inject application data path for local resource resolution
   */
  setAppDataPath(dataPath) {
    this.appDataPath = dataPath;
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
        // Close and clear SSE clients
        for (const res of this.sseClients) {
          try {
            res.end();
          } catch (err) {
            logger.warn('Failed to cleanly close SSE client on shutdown', { error: err.message });
          }
        }
        this.sseClients.clear();
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
   * Update the current playback state
   */
  updateState(newState) {
    const now = Date.now();
    const prev = this.currentState || {};
    // Merge new snapshot (no server-side extrapolation bookkeeping)
    this.currentState = { ...prev, ...newState };
    // Record ephemeral action timestamp for fallbacks (heartbeat)
    if (newState && newState.action) {
      this.currentState.action = newState.action;
      this.currentState.actionAt = now;
    }
    this.broadcastStateUpdate();
    // Log only sanitized state to avoid leaking paths
    logger.debug('Broadcast state updated (public)', this.buildPublicState());
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
      data: this.buildPublicState()
    });

    // In a real implementation, you'd send this to WebSocket clients
    // For now, we'll just emit an event
    this.emit('state_update', this.currentState);

    // Push to SSE clients immediately
    const payload = `event: state_update\n` +
      `data: ${stateData}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch (err) {
        logger.warn('Failed to push state update to SSE client', { error: err.message });
        // Assume disconnected client, clean it up
        this.sseClients.delete(res);
      }
    }
  }

  // Return a sanitized, minimal state suitable for public clients
  buildPublicState() {
    const s = this.currentState || {};
    const serverNow = Date.now();
    // Publish raw currentTime without extrapolation
    const base = (typeof s.currentTime === 'number') ? s.currentTime : 0;
    const dur = s.duration || (s.track && s.track.duration) || 0;
    let effectiveCurrent = base;
    if (dur > 0) effectiveCurrent = Math.min(effectiveCurrent, dur);
    const ephemeralAction = (s.action && (serverNow - (s.actionAt || 0) < 1500)) ? s.action : null;
    let albumArtUrl = null;
    if (s.track && s.track.thumbnail) {
      if (s.track.thumbnail.startsWith('http')) albumArtUrl = s.track.thumbnail;
      else albumArtUrl = `/api/album-art?t=${encodeURIComponent(s.track.id)}`;
    } else if (s.playlist && s.playlist.iconPath) {
      if (s.playlist.iconPath.startsWith('http')) albumArtUrl = s.playlist.iconPath;
      else albumArtUrl = `/api/album-art?p=${encodeURIComponent(s.playlist.id)}`;
    }

    const t = s.track ? {
      id: s.track.id,
      name: s.track.name,
      artist: s.track.artist || 'Unknown Artist',
      duration: s.track.duration || 0,
      volume: typeof s.track.volume === 'number' ? s.track.volume : 1,
      thumbnail: albumArtUrl
    } : null;
    return {
      track: t,
      isPlaying: !!s.isPlaying,
      currentTime: effectiveCurrent,
      serverCurrentTime: effectiveCurrent,
      duration: s.duration || 0,
      playlistName: s.playlist && s.playlist.name ? s.playlist.name : null,
      repeat: !!s.repeat,
      shuffle: !!s.shuffle,
      timestamp: serverNow,
      action: ephemeralAction,
      actionAt: ephemeralAction ? (s.actionAt || 0) : null
    };
  }

  /**
   * Get the shareable URL for the broadcast
   */
  getShareableUrl() {
    const host = this.config.publicHost || this.config.host;
    const baseUrl = `http://${host}:${this.config.port}`;

    return baseUrl;
  }

  // Token validation removed per user request

  /**
   * Handle HTTP requests
   */
  async handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // Short-circuit OPTIONS requests (no permissive CORS by default; same-origin is used)
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Serve public static assets EARLY (no token/IP/rate-limit required)
      const p = pathname.toLowerCase();
      if (p === '/favicon.ico' || p === '/assets/logo' || p === '/assets/logo/' || p === '/assets/logo.png' || p === '/assets/icon' || p === '/assets/icon/' || p === '/assets/icon.png') {
        if (p.includes('logo')) {
          await this.serveLogo(req, res);
        } else {
          await this.serveIcon(req, res);
        }
        return;
      }

      // IP allowlist (if configured)
      const clientIp = this.getClientIp(req);
      if (Array.isArray(this.config.allowedIps) && this.config.allowedIps.length > 0) {
        if (!this.config.allowedIps.includes(clientIp)) {
          res.writeHead(403, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
      }

      // Rate limit (skip for audio streaming to prevent stutter)
      if (pathname !== '/api/audio' && this.isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      // Token validation removed. Server relies on rate limits and IP whitelists if configured.

      // Route requests
      switch (pathname) {
        case '/':
          await this.serveNowPlayingPage(req, res);
          break;
        case '/api/events':
          await this.serveEvents(req, res);
          break;
        case '/api/state':
          await this.serveCurrentState(req, res);
          break;
        case '/api/audio':
          await this.serveAudioStream(req, res);
          break;
        case '/api/album-art':
          await this.serveAlbumArt(req, res);
          break;
        case '/api/theme':
          await this.serveThemeConfig(req, res);
          break;
        case '/broadcast.css':
          await this.serveStaticFile(req, res, path.join(__dirname, 'broadcast.css'), 'text/css');
          break;
        case '/broadcast.css.map':
          await this.serveStaticFile(req, res, path.join(__dirname, 'broadcast.css.map'), 'application/json');
          break;
        case '/broadcastClient.js':
          await this.serveStaticFile(req, res, path.join(__dirname, 'broadcastClient.js'), 'application/javascript');
          break;
        // (assets already handled early)
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain', ...this.getSecurityHeaders('text/plain') });
          res.end('Not Found');
      }
    } catch (error) {
      logger.error('Error handling broadcast request', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Serve the Now Playing page
   */
  async serveNowPlayingPage(req, res) {
    const html = await this.generateNowPlayingHTML();
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...this.getSecurityHeaders('text/html') });
    res.end(html);
  }

  /**
   * Generalized Static Asset Server
   */
  async serveStaticFile(req, res, filePath, contentType) {
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ...this.getSecurityHeaders(contentType)
      });
      res.end(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`Static file not found: ${path.basename(filePath)}`);
        res.writeHead(404, { 'Content-Type': 'text/plain', ...this.getSecurityHeaders('text/plain') });
        res.end('Not Found');
      } else {
        logger.error(`Error serving ${path.basename(filePath)}`, err);
        res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  }



  /**
   * Server-Sent Events endpoint for realtime state updates
   */
  async serveEvents(req, res) {
    // Only GET allowed
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Connection': 'keep-alive',
      ...this.getSecurityHeaders('text/event-stream')
    });

    // Register client
    this.sseClients.add(res);

    // Send initial event with current state
    const stateData = JSON.stringify({
      type: 'state_update',
      data: this.buildPublicState()
    });
    res.write(`event: state_update\n`);
    res.write(`data: ${stateData}\n\n`);

    // Keep-alive ping comments
    const ka = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch (err) {
        logger.warn('Failed to send SSE keepalive ping, clearing client', { error: err.message });
        clearInterval(ka);
        this.sseClients.delete(res);
      }
    }, 25000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(ka);
      this.sseClients.delete(res);
      try {
        res.end();
      } catch (err) {
        logger.warn('Failed to end SSE response on connection close', { error: err.message });
      }
    });
  }

  /**
   * Serve current playback state as JSON
   */
  async serveCurrentState(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...this.getSecurityHeaders('application/json') });
    res.end(JSON.stringify({
      success: true,
      data: this.buildPublicState(),
      timestamp: Date.now()
    }));
  }

  // (heartbeat endpoint removed; SSE is authoritative)

  /**
   * Serve audio stream for the current track
   */
  async serveAudioStream(req, res) {
    // Allow only GET and HEAD to stream audio
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
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

      if (req.method === 'HEAD') {
        // Send only headers for current full file (no body)
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Content-Disposition': 'inline; filename="track.mp3"',
          ...this.getSecurityHeaders('audio/mpeg')
        });
        res.end();
      } else if (range) {
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
          'Expires': '0',
          'Content-Disposition': 'inline; filename="track.mp3"',
          ...this.getSecurityHeaders('audio/mpeg')
        });

        stream.pipe(res);
      } else {
        // Serve entire file
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
          'Content-Disposition': 'inline; filename="track.mp3"',
          ...this.getSecurityHeaders('audio/mpeg')
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      }
    } catch (error) {
      logger.error('Error serving audio stream', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Failed to serve audio' }));
    }
  }

  /**
   * Serve local album artwork (icon or thumbnail depending on context)
   */
  async serveAlbumArt(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    try {
      const state = this.currentState;
      let finalPath = null;

      // Preferred context: Track local thumbnail 
      if (state.track && state.track.thumbnail && this.appDataPath && !state.track.thumbnail.startsWith('http')) {
        finalPath = path.isAbsolute(state.track.thumbnail) ? state.track.thumbnail : path.join(this.appDataPath, state.track.thumbnail);
      }
      // Secondary context: Playlist Icon
      else if (state.playlist && state.playlist.iconPath && this.appDataPath) {
        if (!state.playlist.iconPath.startsWith('http')) {
          finalPath = path.isAbsolute(state.playlist.iconPath) ? state.playlist.iconPath : path.join(this.appDataPath, state.playlist.iconPath);
        }
      }

      if (!finalPath || !(await fs.pathExists(finalPath))) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...this.getSecurityHeaders('text/plain') });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(finalPath).toLowerCase();
      let mimeType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      if (ext === '.webp') mimeType = 'image/webp';
      if (ext === '.gif') mimeType = 'image/gif';
      if (ext === '.svg') mimeType = 'image/svg+xml';

      await this.serveStaticFile(req, res, finalPath, mimeType);
    } catch (error) {
      logger.error('Error serving album art', error);
      res.writeHead(500, { 'Content-Type': 'text/plain', ...this.getSecurityHeaders('text/plain') });
      res.end('Internal Server Error');
    }
  }


  /**
   * Serve theme configuration
   */
  async serveThemeConfig(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...this.getSecurityHeaders('application/json') });
    res.end(JSON.stringify({
      theme: this.themeConfig
    }));
  }

  /**
   * Universal Fallback Image Server
   */
  async serveFallbackImage(req, res, candidates, errorMsg) {
    try {
      const validCandidates = candidates.filter(Boolean);
      let found = '';
      for (const p of validCandidates) { if (await fs.pathExists(p)) { found = p; break; } }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg }));
        return;
      }

      const buffer = await fs.readFile(found);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buffer.length,
        // Cache for 7 days
        'Cache-Control': 'public, max-age=604800, immutable',
        ...this.getSecurityHeaders('image/png')
      });
      res.end(buffer);
    } catch (error) {
      logger.error(`Error serving ${errorMsg.toLowerCase()}`, error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: `Failed to serve ${errorMsg.toLowerCase()}` }));
    }
  }

  /**
   * Serve application logo
   */
  async serveLogo(req, res) {
    const candidates = [
      path.join(__dirname, '..', 'renderer', 'assets', 'MMP_Logo.png'),
      path.join(__dirname, '..', 'renderer', 'assets', 'MMP_Banner.png'),
      path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      // packaged locations
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'MMP_Logo.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'MMP_Banner.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'icon.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'MMP_Logo.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'MMP_Banner.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'icon.png') : ''
    ];
    await this.serveFallbackImage(req, res, candidates, 'Logo not found');
  }

  /**
   * Serve application icon
   */
  async serveIcon(req, res) {
    const candidates = [
      path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      path.join(__dirname, '..', 'renderer', 'assets', 'MMP_Logo.png'),
      // packaged locations
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'icon.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'MMP_Logo.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'icon.png') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'MMP_Logo.png') : ''
    ];
    await this.serveFallbackImage(req, res, candidates, 'Icon not found');
  }

  // --- Security helpers ---
  getClientIp(req) {
    try {
      if (this.config.trustProxy) {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
          const first = String(xff).split(',')[0].trim();
          return first.startsWith('::ffff:') ? first.slice(7) : (first === '::1' ? '127.0.0.1' : first);
        }
      }
      const ra = req.socket?.remoteAddress || '';
      if (!ra) return '';
      if (ra.startsWith('::ffff:')) return ra.slice(7);
      if (ra === '::1') return '127.0.0.1';
      return ra;
    } catch (err) {
      logger.warn('Failed to extract client IP from request', { error: err.message });
      return '';
    }
  }

  isRateLimited(ip) {
    if (!ip) return false;
    const now = Date.now();
    const windowMs = this.rateLimitConfig.windowMs;
    const max = this.rateLimitConfig.max;
    let entry = this.rateLimit.get(ip);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      this.rateLimit.set(ip, entry);
    }
    entry.count++;
    return entry.count > max;
  }

  getSecurityHeaders(contentType = 'text/plain') {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    };
    // Add CSP for HTML pages
    if (contentType.includes('text/html')) {
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'";
    }
    if (this.config.hsts) {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
    return headers;
  }

  /**
   * Generate the Now Playing HTML page
   */
  async generateNowPlayingHTML() {
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
    const surfaceColor = theme.surfaceColor || (lightBg ? lightenColor(secondaryColor, -15) : lightenColor(secondaryColor, 20));
    const borderColor = theme.borderColor || (lightBg ? lightenColor(secondaryColor, -30) : lightenColor(secondaryColor, 40));
    const hoverColor = theme.hoverColor || lightenColor(primaryColor, 15);
    const secondaryHover = theme.secondaryHover || lightenColor(secondaryColor, 15);
    const sliderHandle = lightenColor(primaryColor, 10);

    // Read template
    let template = '';
    try {
      const templatePath = path.join(__dirname, 'broadcast_template.html');
      template = await fs.readFile(templatePath, 'utf8');
    } catch (err) {
      logger.error('Failed to read broadcast_template.html', err);
      return '<h1>Internal Server Error: Missing Template</h1>';
    }

    // Logic variables for interpolation
    const trackArtist = track && track.artist ? track.artist : '';
    const playlistName = this.currentState.playlist && this.currentState.playlist.name ? this.currentState.playlist.name : '';
    const statusIndicatorClass = isPlaying ? 'status-playing' : 'status-paused';
    const statusText = isPlaying ? 'Playing' : 'Paused';
    const audioPlayerDisplay = track ? '' : 'style="display:none"';
    const audioSourceTag = track ? `<source src="/api/audio" type="audio/mpeg">` : '';
    const trackVolume = this.currentState.track && typeof this.currentState.track.volume === 'number' ? this.currentState.track.volume : 1;

    let albumArtUrl = null;
    if (track && track.thumbnail) {
      if (track.thumbnail.startsWith('http')) albumArtUrl = track.thumbnail;
      else albumArtUrl = `/api/album-art?t=${encodeURIComponent(track.id)}`;
    } else if (this.currentState.playlist && this.currentState.playlist.iconPath) {
      if (this.currentState.playlist.iconPath.startsWith('http')) albumArtUrl = this.currentState.playlist.iconPath;
      else albumArtUrl = `/api/album-art?p=${encodeURIComponent(this.currentState.playlist.id)}`;
    }

    const trackThumbnail = albumArtUrl || '';
    const thumbnailDisplay = albumArtUrl ? '' : 'style="display:none"';

    // Interpolate key-value pairs
    const vars = {
      primaryColor, secondaryColor, textColor, surfaceColor, borderColor, containerColor, hoverColor, secondaryHover, sliderHandle,
      lightenColorPrimaryMinus25: lightenColor(primaryColor, -25),
      lightenColorPrimaryMinus5: lightenColor(primaryColor, -5),
      lightenColorPrimaryPlus5: lightenColor(primaryColor, 5),
      trackName, trackArtist, playlistName, statusIndicatorClass, statusText, audioPlayerDisplay, audioSourceTag, trackVolume,
      trackThumbnail, thumbnailDisplay
    };

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return vars[key] !== undefined ? String(vars[key]) : match;
    });
  }
}

module.exports = BroadcastServer;
