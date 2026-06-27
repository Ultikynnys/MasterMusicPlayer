let isConnected = false;
let audioPlayer = null;
let currentTrackId = null; // string form for stable comparison
let deviceVolume = 1; // local slider volume (0..1), independent from app master
let lastWasPlaying = false;
let latestState = null;
const configEl = document.getElementById('broadcast-config');
const broadcastConfig = configEl ? JSON.parse(configEl.textContent) : { trackVolume: 1, theme: {} };
let trackVolume = broadcastConfig.trackVolume; // per-track (0..1)
// Simplified broadcast: no drift thresholds or ping measurement

// Helper to build API URLs with optional extra params (tokens removed)
function getApiUrl(endpoint, extraParams = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? (endpoint + '?' + qs) : endpoint;
}

function getStreamUrl(reason = 'stream') {
    return getApiUrl('/api/stream', {
        v: Date.now(),
        track: currentTrackId || '',
        reason
    });
}

function reloadStream(reason, shouldPlay) {
    if (!audioPlayer) return;

    audioPlayer.src = getStreamUrl(reason);
    audioPlayer.load();
    applyEffectiveVolume();

    if (shouldPlay) {
        audioPlayer.play().catch(e => console.log('Stream playback failed:', e));
    }
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
let lastActionAppliedAt = 0; // timestamp of last processed explicit action

function updateUiClock() {
    try {
        if (uiBaseTimestamp === 0) return;
        const elapsed = uiIsPlaying ? (Date.now() - uiBaseTimestamp) / 1000 : 0;
        let t = uiBaseCurrent + elapsed;
        if (uiDuration > 0) t = Math.min(t, uiDuration);
        document.getElementById('current-time').textContent = formatTime(t);
        if (uiDuration > 0) document.getElementById('total-time').textContent = formatTime(uiDuration);
    } catch (err) {
        console.warn('Failed to set audio current time from broadcast update', { error: err.message });
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
    latestState = state;

    // Update track info
    document.getElementById('track-name').textContent =
        state.track ? state.track.name : 'No track playing';
    document.getElementById('track-artist').textContent =
        (state.track && state.track.artist) ? state.track.artist : '';

    const thumbnailEl = document.getElementById('track-thumbnail');
    if (thumbnailEl) {
        if (state.track && state.track.thumbnail) {
            thumbnailEl.src = state.track.thumbnail;
            thumbnailEl.style.display = '';
        } else {
            thumbnailEl.src = '';
            thumbnailEl.style.display = 'none';
        }
    }

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

    // Audio uses one Shoutcast/ICY-style stream; SSE drives metadata and stream changes.
    if (isConnected && audioPlayer && state.track) {
        const incomingId = String(state.track.id);
        const trackChanged = currentTrackId !== incomingId;
        if (trackChanged) {
            trackVolume = (state.track && typeof state.track.volume === 'number') ? state.track.volume : 1;
            currentTrackId = incomingId;
            if (state.isPlaying) reloadStream('track-change', true);
        } else if (allowSync) {
            trackVolume = (state.track && typeof state.track.volume === 'number') ? state.track.volume : 1;
            const actionAt = (typeof state.actionAt === 'number') ? state.actionAt : Date.now();

            if (state.action === 'seek' && actionAt > lastActionAppliedAt) {
                lastActionAppliedAt = actionAt;
                if (state.isPlaying) reloadStream('seek', true);
            } else if (state.isPlaying && !lastWasPlaying) {
                reloadStream('resume', true);
            } else if (state.isPlaying && audioPlayer.paused) {
                audioPlayer.play().catch(e => console.log('Stream playback failed:', e));
            } else if (!state.isPlaying && !audioPlayer.paused) {
                audioPlayer.pause();
            }

            applyEffectiveVolume();
            updateBufferUI();
        }

        lastWasPlaying = !!state.isPlaying;
    } else if (isConnected && audioPlayer && !state.track) {
        currentTrackId = null;
        lastWasPlaying = false;
        audioPlayer.pause();
        audioPlayer.src = '';
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

        if (latestState) processUpdate(latestState);
        applyEffectiveVolume();
        updateBufferUI();
        // Buffer progress listeners
        try {
            audioPlayer.addEventListener('progress', updateBufferUI);
            audioPlayer.addEventListener('loadedmetadata', updateBufferUI);
            audioPlayer.addEventListener('seeking', updateBufferUI);
            audioPlayer.addEventListener('seeked', updateBufferUI);
        } catch (err) {
            console.warn('Failed to attach buffer listeners', err);
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
        lastWasPlaying = false;

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

// Initialize Server-Sent Events for playback state changes.
let es = null;

function initSSE() {
    if (es) {
        es.close();
        es = null;
    }
    try {
        es = new EventSource(getApiUrl('/api/events'));

        es.onopen = () => {
            console.log('SSE connected');
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
            const st = document.getElementById('status-text');
            if (st) st.textContent = 'Reconnecting...';
        };
    } catch (err) {
        console.log('SSE initialization failed', err);
    }
}

// Start connection
// Wait for DOM content to be loaded before attaching events
document.addEventListener('DOMContentLoaded', () => {
    // Apply server-injected theme variables
    const theme = broadcastConfig.theme;
    if (theme) {
        const root = document.documentElement;
        if (theme.primaryColor) root.style.setProperty('--primary-color', theme.primaryColor);
        if (theme.secondaryColor) root.style.setProperty('--secondary-color', theme.secondaryColor);
        if (theme.textColor) root.style.setProperty('--text-color', theme.textColor);
        if (theme.surfaceColor) root.style.setProperty('--surface-color', theme.surfaceColor);
        if (theme.borderColor) root.style.setProperty('--border-color', theme.borderColor);
        if (theme.containerColor) root.style.setProperty('--container-color', theme.containerColor);
        if (theme.hoverColor) root.style.setProperty('--hover-color', theme.hoverColor);
        if (theme.secondaryHover) root.style.setProperty('--secondary-hover', theme.secondaryHover);
        if (theme.sliderHandleColor) root.style.setProperty('--slider-handle-color', theme.sliderHandleColor);
        if (theme.lightenPrimaryMinus25) root.style.setProperty('--lighten-primary-minus-25', theme.lightenPrimaryMinus25);
        if (theme.lightenPrimaryMinus5) root.style.setProperty('--lighten-primary-minus-5', theme.lightenPrimaryMinus5);
        if (theme.lightenPrimaryPlus5) root.style.setProperty('--lighten-primary-plus-5', theme.lightenPrimaryPlus5);
    }

    initSSE();
});
