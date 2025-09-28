![Master Music Player Banner](Showcase/MMP_Banner.png)

<a href="https://ko-fi.com/r60dr60d" target="_blank"><img src="Showcase/support_me_on_kofi_dark.png" alt="Support me on Ko-fi" height="35"></a>

# Master Music Player

An Electron-based music player that serves as a wrapper for [yt-dlp](https://github.com/yt-dlp/yt-dlp), providing an intuitive interface for downloading and managing music from YouTube, SoundCloud, and Bandcamp.

## Features

### Core Functionality
- **Multi-source Downloads**: Download music from YouTube, SoundCloud, and Bandcamp using yt-dlp.
- **Age-Restricted Content Support**: Integrated cookies.txt handling for downloading age-restricted YouTube videos with smart fallback strategies.
- **Playlist Management**: Create, rename, and delete playlists.
- **Audio Playback**: Support for FLAC, MP3, OGG, and M4A formats.
- **Music Visualizer**: Real-time audio visualization.
- **Drag & Drop**: Add local files and reorder tracks.
- **Broadcast (Now Playing) Server**: Optional HTTP page that shows the current track, streams audio, and updates live via SSE. Generates a shareable URL.

## Visual Showcase

![Playlist Download](Showcase/showcase1.webp)
*Downloading playlists with age-restricted content support*

![Local File Upload](Showcase/showcase6.webp)
*Drag & drop local music files from your computer*

![Theme Customization](Showcase/showcase2.webp)
*Customizable themes with dynamic backgrounds*

![Backup Creation](Showcase/showcase3.webp)
*Easy backup and restore functionality*

![Settings Panel](Showcase/showcase4.png)
*Comprehensive settings and configuration*

![Drag & Drop](Showcase/showcase5.webp)
*Intuitive drag & drop file management*

### Advanced Features
- **Theme Customization**: Configurable color themes with dynamic backgrounds.
- **Backup & Restore**: Save and restore playlists and tracks.
- **Track Management**: Rename tracks, view file types, remove tracks.
- **Playlist Organization**: Drag tracks between playlists.
- **Per-track volume** Control with persistence.
- **YouTube Cookies Integration**: Upload cookies.txt files through Settings → YouTube Cookies to access age-restricted content with automatic validation and status indicators.

## Broadcast (Now Playing)

The app can host a small HTTP server that shows a Now Playing page and streams the active track to remote devices. You’ll find all controls in `Settings → Broadcast`.

![Broadcast](Showcase/broadcast.png)


### Quick start (Local / LAN)
1. Enable Broadcast.
2. Set `Broadcast Host`:
   - `127.0.0.1` → Local-only.
   - `0.0.0.0` → Accept connections from your LAN/Internet.
3. Pick a `Port` (default `4583`).
4. Keep `Require access token` ON and click `Generate` to create a strong token.
5. Optional: Set `Public Host` to your public IP/domain. This is used to build the Shareable URL.
6. Use the Shareable URL (includes the token) or click `Open Broadcast Page`.

### Access from the Internet (optional)
- Add a Windows Firewall inbound rule for your chosen TCP port.
- On your router, port-forward external TCP `PORT` → your PC’s LAN IP `PORT`.
- Some routers don’t support hairpin NAT; test from mobile data.
- If your ISP uses CGNAT or blocks inbound ports, use a tunnel (Cloudflare Tunnel or Ngrok) and put the tunnel hostname into `Public Host`.

### Security hardening options
The server enforces token authentication and ships with multiple protections (rate limiting, IP bans, path confinement). Advanced settings can be edited in `data/config/app.json` under the `broadcast` section:

```json
{
  "broadcast": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 4583,
    "publicHost": "YOUR_PUBLIC_IP",
    "requireToken": true,
    "token": "REPLACE_WITH_YOUR_TOKEN",
    "allowLocalNetworkOnly": false,
    "allowQueryToken": true,
    "allowedOrigins": [],
    "rateLimit": { "windowMs": 60000, "maxRequests": 200 },
    "banOnAuthFail": { "threshold": 8, "windowMs": 600000, "banMs": 3600000 },
    "sseMaxPerIp": 1,
    "streamMaxPerIp": 2
  }
}
```

- `allowLocalNetworkOnly`: when true, only localhost and RFC1918 ranges (10.x, 172.16–31.x, 192.168.x) can connect.
- `allowQueryToken`: when false, the token must be sent in headers (see below), not in the URL.
- `allowedOrigins`: optional CORS allowlist for exact origins. Empty = same-origin only. No wildcard is used.
- `rateLimit`: basic per-IP rate limiting. Exceeding returns HTTP `429`.
- `banOnAuthFail`: IP is banned after too many auth failures within a window.
- `sseMaxPerIp` / `streamMaxPerIp`: caps live update and stream concurrency per IP.

All protected endpoints require a token except `/favicon.ico` and `/app.js` (which loads the boot script for the page). Send the token either in the URL (`?token=...`) or via headers:

```bash
curl \
  -H "Authorization: Bearer YOUR_TOKEN" \
  http://HOST:PORT/now-playing
```

### Endpoints
- `/` Now Playing page (HTML)
- `/now-playing` Current track metadata (JSON)
- `/stream` Audio stream of the active track (Range requests supported)
- `/events` Server-Sent Events for live updates
- `/status` Basic server status (JSON)

### Troubleshooting
- 401 Unauthorized: The token is missing/incorrect. Ensure the Shareable URL includes `?token=` or send the token in headers.
- Can’t connect from the internet: Configure router port forwarding; check Windows Firewall; test from mobile data; if on CGNAT, use Cloudflare Tunnel or Ngrok.
- Some formats don’t play in some browsers (e.g., FLAC). MP3/M4A are broadly supported.

## Keyboard Shortcuts

- **Space**: Play/Pause
- **Ctrl + Right Arrow**: Next track
- **Ctrl + Left Arrow**: Previous track
- **Ctrl + R**: Toggle repeat

## Installation

### Simple Installation (Recommended)
1. **Download** the latest installer from the [Releases](https://github.com/Ultikynnys/MasterMusicPlayer/releases) page
2. **Install** the application by running the installer
3. **Optional**: Get cookies.txt from your browser for age restriction bypass and upload it through Settings → YouTube Cookies inside the app

## Build Requirements

- **Node.js**: Version 16.x or higher. You can download it from [nodejs.org](https://nodejs.org/).
- **npm**: Should be installed with Node.js.
- **Supported OS**: Windows, macOS, and Linux.

## Building the Application

You can build the application for your current platform or for a specific one.

- **Build for current OS**:
  ```bash
  npm run build
  ```

- **Build for a specific OS (e.g., Windows)**:
  ```bash
  npm run build -- --win
  ```
  Use `--mac` for macOS or `--linux` for Linux.

The packaged application will be available in the `dist` directory.

## Configuration

You can customize the application's theme by editing the `theme.json` file located in `data/config/`. This file allows you to change the color scheme and background image of the player. 

### Audio Formats Supported
- MP3 (MPEG Audio Layer 3)
- FLAC (Free Lossless Audio Codec)
- OGG (Ogg Vorbis)
- M4A (MPEG-4 Audio)
- WAV (Waveform Audio File Format)

### Download Sources
- YouTube (videos and playlists)
- SoundCloud (tracks and playlists)
- Bandcamp (albums and tracks)

### Data Storage
- Data is stored in the following path on Windows<br>
``` C:\Users\<user>\AppData\Roaming\master-music-player\data ```

- Playlists are stored as JSON files in `data/playlists/`
- Music files are stored in `data/songs/`
- Theme configuration in `data/config/theme.json`
- Backups are stored in `data/backups/`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues and feature requests, please create an issue in the repository.
