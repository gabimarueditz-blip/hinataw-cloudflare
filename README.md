<div align="center">

<img src="docs/logo.svg" width="80" height="80"/>

# Hinataw.exe 2.2.1

**Complete anime streaming platform — web app + API + 14 providers**

[![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/MARQ9z9QSX)

</div>

---

## What is this?

A complete anime streaming platform with:

- **Web App**: Beautiful dark-themed UI with featured anime, trending carousel, genre filters, search
- **API**: Aggregates anime episode lists and streaming links from 14+ providers
- **Providers**: MKissa, Reanime, AniKoto, AnimeGG, AniNeko, AniDB App, AniZone, AniWaves, Anibd, Kickassanime, AnimeDunya, AnimeOnsen, Senshi, Animenosub
- **Manga**: MangaKakalot + MangaDex integration
- **MovieBox**: Movie streaming integration
- **HiAnime**: Catalog sync engine

## Quick Start

### Development (Node.js)

```bash
cd scratch/9Anime-main
npm install
node server.js
```

Open http://localhost:3000

### Production (Cloudflare Workers) - Recommended

```bash
cd freebuff
wrangler login
wrangler publish
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment options.

## All Integrations

### Anime Streaming Providers (14)

| Provider | File | Status | Notes |
|----------|------|--------|-------|
| MKissa | `providers/mkissa.js` | ✅ Active | Large library, may have captcha |
| Reanime | `providers/reanime.js` | ✅ Active | Solid source, wide range |
| AniKoto | `providers/anikoto.js` | ✅ Active | Good library |
| AnimeGG | `providers/animegg.js` | ✅ Active | Fuzzy title matching |
| AniNeko | `providers/anineko.js` | ✅ Active | Slug-based matching |
| AniDB App | `providers/anidbapp.js` | ✅ Active | Language-aware |
| AniZone | `providers/anizone.js` | ✅ Active | HLS + subtitles |
| AniWaves | `providers/aniwaves.js` | ✅ Active | Direct HLS sources |
| Anibd | `providers/anibd.js` | ✅ Active | AniList ID backed |
| Kickassanime | `providers/kickassanime.js` | ✅ Active | Fuzzy search |
| AnimeDunya | `providers/animedunya.js` | ✅ Active | HLS + subtitles |
| AnimeOnsen | `providers/animeonsen.js` | ✅ Active | DASH + subtitles |
| Senshi | `providers/senshi.js` | ✅ Active | Signed streams |
| Animenosub | `providers/animenosub.js` | ✅ Active | Sub-only |

### Manga Sources

| Source | File | Status | Notes |
|--------|------|--------|-------|
| MangaKakalot | `core/manga.js` | ✅ Active | Primary with reader fallback |
| MangaDex | `core/mangadex.js` | ✅ Active | Official API |
| MangaFire | `core/mangafire/` | ⚠️ Placeholder | Vendor code available |
| MangaHook | `core/mangahook/` | ⚠️ Placeholder | Vendor code available |

### External Integrations (Available)

| Integration | Location | Type | Status |
|-------------|----------|------|--------|
| Hindi Anime API | `vendor/hindi-anime-api/` | Node.js | Available, not integrated |
| AnimeWorld India | `animeworld-india-api/` | PHP | Partially integrated |
| Moviebox API | `moviebox-src/` | Python | Integrated via HTTP |
| Hinataw Stream | `hinata-anime-stream/` | Node.js | Separate project |

### Extractors

| Extractor | File | Purpose |
|-----------|------|---------|
| MegaPlay | `extractors/megaplay.js` | MegaPlay stream extraction |
| VidPlay | `extractors/vidplay.js` | VidPlay extraction |
| FlixCloud | `extractors/flixcloud.js` | FlixCloud manifest handling |
| DATASV | `extractors/datasv.js` | DATASV extraction |
| Byse | `extractors/byse.js` | Byse extraction |
| Nova | `extractors/nova.js` | Nova extraction |
| VidMoly | `extractors/vidmoly.js` | VidMoly extraction |
| Zoko | `extractors/zoko.js` | Zoko extraction |

## API Endpoints

### Home & Catalog
- `GET /` - Web app home
- `GET /home` - Home data (trending, new, updated)
- `GET /api/home` - Alternative home endpoint

### Anime API
- `GET /api/anime/*` - Anime catalog routes
- `GET /api/hianime/*` - HiAnime specific routes
- `GET /api/india/*` - India catalog routes
- `GET /api/anime/image-proxy?url=...` - Image proxy

### MovieBox API
- `GET /api/moviebox/home` - MovieBox home
- `GET /api/moviebox/list` - MovieBox library
- `GET /api/moviebox/search` - MovieBox search
- `GET /api/moviebox/detail` - MovieBox detail
- `GET /api/moviebox/stream` - MovieBox stream
- `GET /api/moviebox/video?u=...` - Video proxy

### Manga API
- `GET /api/manga/*` - Manga routes
- `GET /manga` - Manga portal page

### Streaming
- `GET /watch/:provider/:id/sub|dub/:provider-:ep` - Watch stream
- `GET /stream/reanime/:id/sub|dub/:ep` - ReAnime direct
- `GET /episodes/:anilistId` - Episode list
- `GET /episodes/:provider/:anilistId` - Filtered episodes
- `GET /map/:anilistId` - ID mappings

### User Features
- `POST /api/feedback/*` - Feedback
- `GET /api/notices` - Site notices
- `GET /api/diag` - Diagnostics

### Static Assets
- `GET /logo.svg` - Logo
- `GET /sw.js` - Service worker
- `GET /favicon.ico` - Favicon

## Project Structure

```
9Anime-main/
├── api/                    # API route handlers
│   ├── index.js           # API entry point
│   └── handler.js         # Handler utilities
├── core/                   # Core modules
│   ├── anime-router.js    # Main API router (3388 lines)
│   ├── anime-service.js   # Anime catalog & search
│   ├── anilist.js         # AniList API
│   ├── hianime-service.js # HiAnime integration
│   ├── hianime-sync.js    # HiAnime sync engine
│   ├── moviebox.js        # MovieBox integration
│   ├── manga.js           # Manga source (MangaKakalot)
│   ├── mangadex.js        # MangaDex API
│   ├── doc-store.js       # Persistent storage
│   ├── user-service.js    # User auth
│   ├── smartcache.js      # Caching layer
│   ├── episode-cache.js   # Episode caching
│   ├── episode-strategy.js# Provider resolution
│   ├── mapper.js          # ID mapping
│   ├── stream-utils.js    # Stream utilities
│   ├── wreq.js            # HTTP client
│   ├── index-html.js      # Frontend HTML bundle
│   ├── anime-world-india.js # India catalog
│   ├── hindi-dubbed.js    # Hindi anime support
│   ├── toonstream.js      # ToonStream support
│   ├── mangafire/         # MangaFire placeholder
│   ├── mangahook/         # MangaHook placeholder
│   ├── hindi-anime-api/   # Hindi Anime API placeholder
│   └── animeworld-india/  # AnimeWorld full integration
├── providers/              # 14 anime providers
│   ├── mkissa.js          # MKissa provider
│   ├── reanime.js         # ReAnime provider
│   ├── anikoto.js         # AniKoto provider
│   ├── animegg.js         # AnimeGG provider
│   ├── anineko.js         # AniNeko provider
│   ├── anidbapp.js        # AniDB App provider
│   ├── anizone.js         # AniZone provider
│   ├── aniwaves.js        # AniWaves provider
│   ├── anibd.js           # Anibd provider
│   ├── kickassanime.js    # KickAssAnime provider
│   ├── animedunya.js      # AnimeDunya provider
│   ├── animeonsen.js      # AnimeOnsen provider
│   ├── senshi.js          # Senshi provider
│   └── animenosub.js      # AniMenosub provider
├── extractors/             # Stream extractors
│   ├── megaplay.js        # MegaPlay extractor
│   ├── vidplay.js         # VidPlay extractor
│   ├── flixcloud.js       # FlixCloud handler
│   ├── datasv.js          # DATASV extractor
│   ├── byse.js            # Byse extractor
│   ├── nova.js            # Nova extractor
│   ├── vidmoly.js         # VidMoly extractor
│   └── zoko.js            # Zoko extractor
├── public/                 # Static assets
│   ├── index.html         # Frontend (auto-generated)
│   ├── favicon.png        # Favicon
│   └── sw.js              # Service worker
├── freebuff/               # Cloudflare Workers deployment
│   ├── dist/
│   │   ├── worker.js      # Complete bundle
│   │   └── manifest.json  # Deploy manifest
│   ├── wrangler.toml      # Workers config
│   └── relay/             # Auth relay
├── workers/                # Worker shims & entry
│   ├── entry.js           # Worker entry point
│   └── shims/             # Node compatibility shims
├── scripts/                # Build scripts
│   ├── build-freebuff.mjs # Build Workers bundle
│   └── bundle-frontend.js # Bundle frontend
├── data/                   # Data files
│   ├── hianime-cache.json # HiAnime cache
│   ├── users.json         # User data
│   └── feedback.json      # Feedback data
├── docs/                   # Documentation
│   ├── logo.svg           # Logo
│   ├── index.html         # Docs home
│   └── landing.html       # Landing page
├── server.js               # Node.js dev server
├── index.js                # Main Workers entry
├── package.json            # Dependencies
├── DEPLOYMENT.md           # Deployment guide
├── GITHUB_DEPLOY.md       # GitHub deployment
├── INTEGRATIONS.md        # All integrations documented
└── README.md              # This file
```

## Environment Variables

| Variable | Default | Used By | Description |
|----------|---------|---------|-------------|
| `PORT` | 3000 | server.js | Dev server port |
| `CACHE_ENABLED` | false | smartcache.js | Enable caching |
| `ADMIN_PASSWORD` | - | user-service.js | Admin password |
| `MANGA_PROXY` | on | manga.js | Manga proxy toggle |
| `MKISSA_WREQ_BROWSER` | chrome_149 | mkissa.js | MKissa browser profile |
| `MKISSA_WREQ_OS` | windows | mkissa.js | MKissa OS profile |
| `MKISSA_WREQ_REQUIRED` | false | mkissa.js | MKissa required flag |

For Cloudflare Workers, set secrets using:
```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put YOUR_SECRET
```

## Deployment Options

### Option 1: Cloudflare Workers (Recommended)
Full functionality including all APIs and streaming.

```bash
cd freebuff
wrangler login
wrangler publish
```

### Option 2: Node.js Server
Full functionality on your own server.

```bash
npm install
node server.js
```

### Option 3: Static Hosting (Limited)
Frontend only, no APIs or streaming.

See [DEPLOYMENT.md](DEPLOYMENT.md) for details.

## Vendor Libraries (Not Integrated)

These are available but not yet integrated into the main app:

### MangaFire (`vendor/mangafire/`)
- TypeScript library for mangafire.to
- Convert to JS and add to `core/manga.js` as fallback

### MangaHook (`vendor/mangahook/`)
- Express server for manga API
- Merge routes into main API handler

### Hindi Anime API (`vendor/hindi-anime-api/`)
- Express server for Hindi-dubbed anime
- Merge scrapers into `providers/`

### Moviebox Python API (`moviebox-src/`)
- Python API for movie streaming
- Already integrated via HTTP client in `core/moviebox.js`

### Hinataw Stream (`hinata-anime-stream/`)
- Separate frontend streaming app
- Frontend already in `public/`, backend in `index.js`

## Contributing

This project is community-kept-alive. If it helps you:
- ⭐ Star the repo
- 💬 Join the [Discord](https://discord.gg/MARQ9z9QSX)
- 🛠️ Open a PR for improvements

## License

See LICENSE file for details.
