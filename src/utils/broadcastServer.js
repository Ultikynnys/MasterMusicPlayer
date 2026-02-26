const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('./logger');

// --- Theme helpers to mirror renderer behavior ---
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function hexToRgb(hex) {
  const cleaned = hex.replace('#', '');
  const bigint = parseInt(cleaned.length === 3 ? cleaned.split('').map(c => c + c).join('') : cleaned, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}
function rgbToHex(r, g, b) {
  const toHex = (v) => ('0' + v.toString(16)).slice(-2);
  return `#${toHex(clamp(Math.round(r), 0, 255))}${toHex(clamp(Math.round(g), 0, 255))}${toHex(clamp(Math.round(b), 0, 255))}`;
}
// Lighten/darken by percentage (positive lightens, negative darkens)
function lightenColor(hex, percent) {
  try {
    const { r, g, b } = hexToRgb(hex);
    const p = percent / 100;
    const lr = p >= 0 ? r + (255 - r) * p : r * (1 + p);
    const lg = p >= 0 ? g + (255 - g) * p : g * (1 + p);
    const lb = p >= 0 ? b + (255 - b) * p : b * (1 + p);
    return rgbToHex(lr, lg, lb);
  } catch (err) {
    logger.warn('Failed to lighten color, returning fallback hex', { hex, percent, error: err.message });
    return hex;
  }
}
function luminance({ r, g, b }) {
  const a = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function isLightColor(hex) {
  try {
    return luminance(hexToRgb(hex)) > 0.6;
  } catch (err) {
    logger.warn('Failed to check if color is light, assuming false', { hex, error: err.message });
    return false;
  }
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
      accessToken: '',
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

    // Avoid leaking access token in logs
    const sanitized = { ...this.config, accessToken: this.config.accessToken ? '[redacted]' : '' };
    logger.info('Broadcast server config updated', { config: sanitized });
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
    const t = s.track ? {
      id: s.track.id,
      name: s.track.name,
      artist: s.track.artist || 'Unknown Artist',
      duration: s.track.duration || 0,
      volume: typeof s.track.volume === 'number' ? s.track.volume : 1
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
    let token = url.searchParams.get('token');
    // Also support Authorization: Bearer <token>
    if (!token && typeof req.headers['authorization'] === 'string') {
      const m = /^(?:Bearer)\s+(.+)$/i.exec(req.headers['authorization']);
      if (m) token = m[1];
    }
    return !!token && token === this.config.accessToken;
  }

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

      // Validate token unless requesting public static assets
      const isPublicAsset = (pathname === '/favicon.ico' || pathname.startsWith('/assets/'));
      if (!isPublicAsset && !this.validateToken(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing access token' }));
        return;
      }

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
        case '/api/theme':
          await this.serveThemeConfig(req, res);
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
    const html = this.generateNowPlayingHTML();
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...this.getSecurityHeaders('text/html') });
    res.end(html);
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
   * Serve theme configuration
   */
  async serveThemeConfig(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...this.getSecurityHeaders('application/json') });
    res.end(JSON.stringify({
      theme: this.themeConfig
    }));
  }

  /**
   * Serve application logo
   */
  async serveLogo(req, res) {
    try {
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
      ].filter(Boolean);
      let found = '';
      for (const p of candidates) { if (await fs.pathExists(p)) { found = p; break; } }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Logo not found' }));
        return;
      }

      const logoBuffer = await fs.readFile(found);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': logoBuffer.length,
        // Cache for 7 days
        'Cache-Control': 'public, max-age=604800, immutable',
        ...this.getSecurityHeaders('image/png')
      });
      res.end(logoBuffer);
    } catch (error) {
      logger.error('Error serving logo', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Failed to serve logo' }));
    }
  }

  /**
   * Serve application icon
   */
  async serveIcon(req, res) {
    try {
      const candidates = [
        path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
        path.join(__dirname, '..', 'renderer', 'assets', 'MMP_Logo.png'),
        // packaged locations
        process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'icon.png') : '',
        process.resourcesPath ? path.join(process.resourcesPath, 'app.asar', 'src', 'renderer', 'assets', 'MMP_Logo.png') : '',
        process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'icon.png') : '',
        process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'renderer', 'assets', 'MMP_Logo.png') : ''
      ].filter(Boolean);
      let found = '';
      for (const p of candidates) { if (await fs.pathExists(p)) { found = p; break; } }
      if (!found) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Icon not found' }));
        return;
      }

      const iconBuffer = await fs.readFile(found);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': iconBuffer.length,
        // Cache for 7 days
        'Cache-Control': 'public, max-age=604800, immutable',
        ...this.getSecurityHeaders('image/png')
      });
      res.end(iconBuffer);
    } catch (error) {
      logger.error('Error serving icon', error);
      res.writeHead(500, { 'Content-Type': 'application/json', ...this.getSecurityHeaders('application/json') });
      res.end(JSON.stringify({ error: 'Failed to serve icon' }));
    }
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
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'";
    }
    if (this.config.hsts) {
      headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
    }
    return headers;
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
    const surfaceColor = theme.surfaceColor || (lightBg ? lightenColor(secondaryColor, -15) : lightenColor(secondaryColor, 20));
    const borderColor = theme.borderColor || (lightBg ? lightenColor(secondaryColor, -30) : lightenColor(secondaryColor, 40));
    const hoverColor = theme.hoverColor || lightenColor(primaryColor, 15);
    const secondaryHover = theme.secondaryHover || lightenColor(secondaryColor, 15);
    const sliderHandle = lightenColor(primaryColor, 10);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Now Playing - Master Music Player</title>
    <link rel="icon" type="image/png" href="/assets/icon.png">
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
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
        }

        /* Top application banner */
        .banner {
            position: sticky;
            top: 0;
            width: 100%;
            background: ${surfaceColor};
            border-bottom: 1px solid ${borderColor};
            z-index: 5;
        }
        .banner-inner {
            max-width: 900px;
            margin: 0 auto;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            font-weight: 700;
            font-size: 1.25rem;
        }
        .banner-title { display: flex; align-items: center; gap: 0.75rem; }
        .banner-inner img { width: 28px; height: 28px; border-radius: 6px; }
        .banner-actions .link {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.35rem 0.75rem;
            border-radius: 6px;
            background: ${containerColor};
            border: 1px solid ${borderColor};
            color: ${textColor};
            text-decoration: none;
            font-weight: 600;
        }
        .banner-actions .link:hover { background: ${secondaryHover}; }
        
        .container {
            text-align: center;
            max-width: 600px;
            padding: 2rem;
            background: ${surfaceColor};
            border: 1px solid ${borderColor};
            border-radius: 8px;
            box-shadow: none;
            margin-top: 1.5rem;
        }
        
        /* legacy in-card logo removed */
        
        .track-info {
            margin-bottom: 2rem;
        }
        
        .track-name {
            font-size: 1.8rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            word-break: break-word;
        }
        
        .track-artist {
            font-size: 1.1rem;
            opacity: 0.8;
            margin-top: -0.25rem;
            margin-bottom: 0.75rem;
        }
        
        .playlist-name {
            font-size: 0.95rem;
            opacity: 0.7;
            margin-bottom: 0.75rem;
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
        
        .buffer-status { margin-bottom: 1rem; }
        .buffer-container {
            width: 100%;
            max-width: 400px;
            height: 6px;
            background: ${containerColor};
            border-radius: 3px;
            overflow: hidden;
            margin: 0.25rem auto 0.35rem auto;
        }
        .buffer-fill {
            height: 100%;
            width: 0%;
            background: ${lightenColor(primaryColor, -25)};
            transition: width 120ms linear;
        }
        .buffer-text { font-size: 0.9rem; opacity: 0.75; }
        
        /* simplified UI: removed net-info, time-diff, dual-times */
        
        .volume-control {
            display: grid;
            grid-template-columns: auto 220px auto;
            align-items: center;
            justify-content: center;
            column-gap: 0.5rem;
            width: 100%;
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
            width: 220px;
            height: 6px;
            background: ${containerColor};
            border-radius: 3px;
            outline: none;
            -webkit-appearance: none;
            appearance: none;
        }
        .volume-slider::-webkit-slider-runnable-track { height: 6px; background: ${containerColor}; border-radius: 3px; }
        .volume-slider::-moz-range-track { height: 6px; background: ${containerColor}; border-radius: 3px; }
        
        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 20px;
            height: 20px;
            background: ${sliderHandle};
            border-radius: 50%;
            cursor: pointer;
            border: 2px solid ${borderColor};
            margin-top: -7px; /* center thumb over 6px track */
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
    <div class="banner">
        <div class="banner-inner">
            <div class="banner-title">
                <img src="/assets/logo" alt="Master Music Player" onerror="this.style.display='none'">
                Master Music Player
            </div>
            <div class="banner-actions">
                <a class="link github-link" href="https://github.com/Ultikynnys/MasterMusicPlayer" target="_blank" rel="noopener">GitHub</a>
            </div>
        </div>
    </div>
    <div class="container">
        
        <div class="track-info">
            <div class="track-name" id="track-name">${trackName}</div>
            <div class="track-artist" id="track-artist">${track && track.artist ? track.artist : ''}</div>
            <div class="playlist-name" id="playlist-name">${this.currentState.playlist && this.currentState.playlist.name ? this.currentState.playlist.name : ''}</div>
            <div class="status">
                <span class="status-indicator ${isPlaying ? 'status-playing' : 'status-paused'}" id="status-indicator"></span>
                <span id="status-text">${isPlaying ? 'Playing' : 'Paused'}</span>
            </div>
            <div class="progress-info">
                <span id="current-time">0:00</span>
                <span> / </span>
                <span id="total-time">0:00</span>
            </div>
            <div class="buffer-status">
                <div class="buffer-container"><div class="buffer-fill" id="buffer-fill"></div></div>
                <div class="buffer-text" id="buffer-text">Buffered: 0%</div>
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
        let isConnected = false;
        let audioPlayer = null;
        let currentTrackId = null; // string form for stable comparison
        let currentAudioUrl = '';
        let lastTrackChangeAt = 0;
        let deviceVolume = 1; // local slider volume (0..1), independent from app master
        let trackVolume = ${this.currentState.track && typeof this.currentState.track.volume === 'number' ? this.currentState.track.volume : 1}; // per-track (0..1)
        // Simplified broadcast: no drift thresholds or ping measurement
        
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
        
        // Last known server state for UI clock
        let uiBaseCurrent = 0;
        let uiBaseTimestamp = 0;
        let uiIsPlaying = false;
        let uiDuration = 0;
        let localEnded = false; // if client finished the track earlier, wait for server track change
        let lastActionAppliedAt = 0; // timestamp of last processed explicit action
        let firstSyncAfterConnect = false; // start at displayed time on first sync after connect

        function updateUiClock() {
            try {
                if (uiBaseTimestamp === 0) return;
                const elapsed = uiIsPlaying ? (Date.now() - uiBaseTimestamp) / 1000 : 0;
                let t = uiBaseCurrent + elapsed;
                if (uiDuration > 0) t = Math.min(t, uiDuration);
                document.getElementById('current-time').textContent = formatTime(t);
                if (uiDuration > 0) document.getElementById('total-time').textContent = formatTime(uiDuration);
            } catch (err) {
              logger.warn('Failed to set audio current time from broadcast update', { error: err.message });
            }
        }

        // Keep UI clock ticking
        setInterval(updateUiClock, 250);

        

        // No playback rate drift correction in simplified mode

        // Removed time-diff display and related calculations

        // Update buffered progress UI using media buffered ranges
        function updateBufferUI() {
            try {
                const fill = document.getElementById('buffer-fill');
                const text = document.getElementById('buffer-text');
                if (!audioPlayer || !fill || !text) return;
                const dur = audioPlayer.duration;
                let pct = 0;
                if (isFinite(dur) && dur > 0 && audioPlayer.buffered && audioPlayer.buffered.length) {
                    const end = audioPlayer.buffered.end(audioPlayer.buffered.length - 1);
                    pct = Math.max(0, Math.min(100, (end / dur) * 100));
                }
                fill.style.width = pct.toFixed(1) + '%';
                text.textContent = 'Buffered: ' + pct.toFixed(0) + '%';
            } catch (err) {
                console.warn('Failed to update buffer UI', err);
            }
        }

        // No ping measurement in simplified mode

        // Unified handler for applying state updates (used by SSE)
        function processUpdate(state, allowSync = true) {
            // Update track info
            document.getElementById('track-name').textContent = 
                state.track ? state.track.name : 'No track playing';
            document.getElementById('track-artist').textContent = 
                (state.track && state.track.artist) ? state.track.artist : '';
            const pn = (state.playlistName && typeof state.playlistName === 'string') ? state.playlistName : '';
            document.getElementById('playlist-name').textContent = pn;
            
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
            
            // Update progress info (no system-time extrapolation)
            const serverTimeNow = (typeof state.serverCurrentTime === 'number') ? state.serverCurrentTime : (typeof state.currentTime === 'number' ? state.currentTime : 0);
            if (typeof serverTimeNow === 'number' && typeof state.duration === 'number') {
                document.getElementById('current-time').textContent = formatTime(serverTimeNow);
                document.getElementById('total-time').textContent = formatTime(state.duration);
                // Update UI clock base for smooth display (UI-only)
                uiBaseCurrent = serverTimeNow;
                uiBaseTimestamp = Date.now();
                uiIsPlaying = !!state.isPlaying;
                uiDuration = state.duration || 0;
                // Server time is UI-only; no diff computation in simplified mode
            }
            
            // Update audio player if connected
            if (isConnected && audioPlayer && state.track) {
                const incomingId = String(state.track.id);
                // Check if track has changed (debounce to avoid rapid reload loops)
                const trackChanged = currentTrackId !== incomingId;
                if (trackChanged) {
                trackVolume = (state.track && typeof state.track.volume === 'number') ? state.track.volume : 1;
                    // Debounce track change handling to avoid rapid reload loops
                    const nowTs = Date.now();
                    if (nowTs - lastTrackChangeAt < 800) {
                        return; // ignore rapid duplicate updates
                    }
                    lastTrackChangeAt = nowTs;
                    currentTrackId = incomingId;
                    localEnded = false; // new track -> clear early-end gate
                    // Simplified: no offset calibration required
                    const audioUrl = getApiUrl('/api/audio', { v: incomingId });
                    if (currentAudioUrl !== audioUrl) {
                        currentAudioUrl = audioUrl;
                        audioPlayer.src = audioUrl;
                        audioPlayer.load();
                    }
                    const onMeta = () => {
                        audioPlayer.removeEventListener('loadedmetadata', onMeta);
                        // On first sync after connect, start at the currently displayed UI time; otherwise start at 0 on track changes
                        const displayed = (() => {
                            if (!uiBaseTimestamp) return uiBaseCurrent || 0;
                            const elapsed = uiIsPlaying ? (Date.now() - uiBaseTimestamp) / 1000 : 0;
                            let t = (uiBaseCurrent || 0) + elapsed;
                            if (uiDuration > 0) t = Math.min(t, uiDuration);
                            return t;
                        })();
                        const startAt = firstSyncAfterConnect ? displayed : 0;
                        try { audioPlayer.currentTime = startAt; } catch (err) {
                          logger.warn('Failed to set current time during local playback sync', { startAt, error: err.message });
                        }
                        firstSyncAfterConnect = false;
                        applyEffectiveVolume();
                        updateBufferUI();
                        if (state.isPlaying) {
                            audioPlayer.play().catch(e => console.log('Playback failed:', e));
                        }
                    };
                    audioPlayer.addEventListener('loadedmetadata', onMeta);
                } else {
                    // Same track - sync time and play/pause using serverCurrentTime only
                    if (allowSync) {
                        const serverTime = (typeof state.serverCurrentTime === 'number') ? state.serverCurrentTime : (typeof state.currentTime === 'number' ? state.currentTime : 0);
                        
                        // Reset localEnded if an explicit seek/repeat happens or the server time goes back significantly
                        if (state.action === 'seek' || (localEnded && typeof state.duration === 'number' && (state.duration - serverTime) > 1.0)) {
                            localEnded = false;
                        }

                        // If server already ended this track, pause locally and wait
                        const serverEnded = (typeof state.duration === 'number' && state.duration > 0 && (serverTime >= (state.duration - 0.2)));
                        if (serverEnded) {
                            localEnded = true;
                            audioPlayer.pause();
                            const st = document.getElementById('status-text');
                            if (st) st.textContent = 'Waiting for next track...';
                        } else if (localEnded) {
                            // Client ended early: pause and wait until server switches tracks
                            audioPlayer.pause();
                            if (state.isPlaying) {
                                const st = document.getElementById('status-text');
                                if (st) st.textContent = 'Waiting for next track...';
                            }
                        } else {
                            // Only on explicit seek: set playback position to serverTime
                            if (state.action === 'seek') {
                                const ts = (typeof state.actionAt === 'number') ? state.actionAt : Date.now();
                                if (ts > lastActionAppliedAt) {
                                    audioPlayer.currentTime = serverTime;
                                    audioPlayer.playbackRate = 1.0;
                                    lastActionAppliedAt = ts; // apply once per action event
                                }
                            } else {
                                // Apply hard drift correction only (no playbackRate stretching to avoid audio rubberbanding)
                                const diff = serverTime - audioPlayer.currentTime;
                                if (Math.abs(diff) > 2.5) {
                                    // Hard sync if drift is > 2.5 seconds
                                    audioPlayer.currentTime = serverTime;
                                }
                                
                                // Always enforce normal speed
                                if (audioPlayer.playbackRate !== 1.0) {
                                    audioPlayer.playbackRate = 1.0;
                                }
                            }
                        }
                    }
                    if (!localEnded) {
                        if (allowSync && state.isPlaying && audioPlayer.paused) {
                            audioPlayer.play().catch(e => console.log('Playback failed:', e));
                        } else if (allowSync && !state.isPlaying && !audioPlayer.paused) {
                            audioPlayer.pause();
                        }
                    } else {
                        // Ensure paused while waiting
                        audioPlayer.pause();
                    }
                    applyEffectiveVolume();
                    updateBufferUI();
                }
            } else if (isConnected && audioPlayer && !state.track) {
                currentTrackId = null;
                audioPlayer.pause();
                audioPlayer.src = '';
                currentAudioUrl = '';
            }
        }
        
        // (heartbeat fallback removed)
        
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
                firstSyncAfterConnect = true;
                
                // Reset track ID to force reload on next update
                currentTrackId = null;
                
                // Load current track
                audioPlayer.src = getApiUrl('/api/audio', { v: Date.now() });
                audioPlayer.load();
                applyEffectiveVolume();
                updateBufferUI();
                // Buffer progress listeners
                try {
                    audioPlayer.addEventListener('progress', updateBufferUI);
                    audioPlayer.addEventListener('loadedmetadata', updateBufferUI);
                    audioPlayer.addEventListener('seeking', updateBufferUI);
                    audioPlayer.addEventListener('seeked', updateBufferUI);
                    audioPlayer.addEventListener('ended', () => { localEnded = true; });
                } catch (err) {
                  logger.warn('Failed to pause local audio sync', { error: err.message });
                }
                
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
        
        // Initialize Server-Sent Events with auto-reconnect
        let es = null;
        let reconnectTimeout = null;
        let sseConnected = false;
        
        function initSSE() {
            if (es) {
                es.close();
                es = null;
            }
            try {
                es = new EventSource(getApiUrl('/api/events'));
                
                es.onopen = () => {
                    console.log('SSE connected');
                    sseConnected = true;
                    const st = document.getElementById('status-text');
                    if (st && st.textContent.includes('Reconnecting')) {
                        st.textContent = isConnected && currentTrackId ? 'Playing' : 'Waiting for track...';
                    }
                };

                es.addEventListener('state_update', (e) => {
                    try {
                        const payload = JSON.parse(e.data);
                        const state = payload ? payload.data : null;
                        if (state) processUpdate(state);
                    } catch (err) { console.log('SSE parse error', err); }
                });
                
                es.onerror = () => {
                    console.log('SSE error, connection lost');
                    sseConnected = false;
                    es.close();
                    
                    const st = document.getElementById('status-text');
                    if (st) st.textContent = 'Reconnecting...';
                    
                    // Attempt to reconnect after 3 seconds
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = setTimeout(initSSE, 3000);
                };
            } catch (err) {
                console.log('SSE initialization failed', err);
                clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(initSSE, 5000);
            }
        }
        
        // Start connection
        initSSE();

    </script>
</body>
</html>`;
  }
}

module.exports = BroadcastServer;
