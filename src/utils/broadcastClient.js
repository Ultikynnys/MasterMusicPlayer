let isConnected = false;
let audioPlayer = null;
let currentTrackId = null; // string form for stable comparison
let currentAudioUrl = '';
let lastTrackChangeAt = 0;
let deviceVolume = 1; // local slider volume (0..1), independent from app master
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
                    console.warn('Failed to set current time during local playback sync', { startAt, error: err.message });
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
