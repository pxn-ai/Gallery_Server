# Gallery Server

A self-hosted photo & video gallery for Raspberry Pi. Serves your media collection as a beautiful, mobile-friendly web gallery accessible from any device on your local network.

## Features

- 📸 **Photo gallery** with HEIC/JPEG/PNG support (auto-converts HEIC for browsers)
- 🎬 **Video streaming** with range-request support for scrubbing
- 📱 **Mobile-first design** — dark-mode UI optimized for phones
- 🔍 **Lazy thumbnails** — generated on-demand and cached to disk
- ♾️ **Infinite scroll** — smooth browsing through thousands of items
- 🖼️ **Lightbox viewer** — full-screen preview with swipe navigation
- 🏷️ **Filters** — switch between All / Photos / Videos
- ⚡ **Fast** — SQLite metadata cache, pre-compiled prepared statements

## Requirements

- Node.js 18+
- FFmpeg (for video thumbnails)
- libheif (for HEIC support — typically included with Sharp)

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server starts on port **3000** and auto-scans your media directory.

Open `http://<your-pi-ip>:3000` on any device connected to the same network.

## Configuration

Set environment variables or edit `.env.example`:

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIA_PATH` | `/media/pasan/PHOTOS/` | Path to your media directory |
| `PORT` | `3000` | Server port |

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Gallery statistics |
| `GET /api/media?page=1&limit=60&type=all` | Paginated media list |
| `GET /api/thumb/:id` | Thumbnail image (400px) |
| `GET /api/preview/:id` | Preview image (1400px) |
| `GET /api/full/:id` | Full resolution image |
| `GET /api/video/:id` | Stream video (supports range requests) |
| `POST /api/scan` | Trigger media rescan |

## Architecture

```
Gallery_Server/
├── server.js              # Express entry point
├── src/
│   ├── db.js              # SQLite database layer
│   ├── scanner.js         # Media file discovery + metadata extraction
│   ├── thumbnailer.js     # Thumbnail/preview generation (Sharp + FFmpeg)
│   └── routes/
│       └── api.js         # REST API endpoints
├── public/
│   ├── index.html         # SPA shell
│   ├── css/style.css      # Dark-mode design system
│   └── js/app.js          # Client-side app logic
└── .gallery_cache/        # Generated thumbnails + SQLite DB (gitignored)
```

## License

MIT