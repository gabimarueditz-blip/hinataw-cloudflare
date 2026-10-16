# Hinataw.exe - All Integrations

This document catalogs all integrated services, providers, and APIs in the Hinataw.exe project.

## Anime Streaming Providers (14)

All integrated into `core/anime-router.js` and `index.js`:

| Provider | Status | File | Notes |
|----------|--------|------|-------|
| **MKissa** | ✅ Active | `providers/mkissa.js` | Large library, may return 403/captcha errors |
| **Reanime** | ✅ Active | `providers/reanime.js` | Solid source, wide range |
| **AniKoto** | ✅ Active | `providers/anikoto.js` | Good library, consistent |
| **AnimeGG** | ✅ Active | `providers/animegg.js` | Fuzzy title matching |
| **AniNeko** | ✅ Active | `providers/anineko.js` | Reliable slug-based |
| **AniDB App** | ✅ Active | `providers/anidbapp.js` | Language-aware |
| **AniZone** | ✅ Active | `providers/anizone.js` | HLS + subtitles |
| **AniWaves** | ✅ Active | `providers/aniwaves.js` | Direct HLS + DATASV |
| **Anibd** | ✅ Active | `providers/anibd.js` | AniList ID backed |
| **Kickassanime** | ✅ Active | `providers/kickassanime.js` | Fuzzy search |
| **AnimeDunya** | ✅ Active | `providers/animedunya.js` | HLS + subtitles |
| **AnimeOnsen** | ✅ Active | `providers/animeonsen.js` | DASH + subtitles |
| **Senshi** | ✅ Active | `providers/senshi.js` | Signed streams |
| **Animenosub** | ✅ Active | `providers/animenosub.js` | Sub-only |

## Manga Sources

| Source | Status | File | Notes |
|--------|--------|------|-------|
| **MangaKakalot** | ✅ Active | `core/manga.js` | Primary manga source with reader fallback |
| **MangaDex** | ✅ Active | `core/mangadex.js` | Official API, used as primary |
| **MangaFire** | 🔄 Vendor | `vendor/mangafire/` | Available but needs integration |
| **MangaHook** | 🔄 Vendor | `vendor/mangahook/` | Available but needs integration |

## External Vendor Libraries (Available but not fully integrated)

### 1. MangaFire (`vendor/mangafire/`)
- **Location**: `scratch/vendor/mangafire/mangafire-main/`
- **Type**: TypeScript library
- **Purpose**: Manga scraping for mangafire.to
- **Status**: Code available, not integrated into main app
- **Integration notes**: See `core/MANGAFALLBACK.md`

### 2. MangaHook (`vendor/mangahook/`)
- **Location**: `scratch/vendor/mangahook/mangahook-api-main/`
- **Type**: Node.js Express server
- **Purpose**: Manga API server
- **Status**: Code available, not integrated
- **Integration notes**: Separate Express app, would need to be merged

### 3. Hindi Anime API (`vendor/hindi-anime-api/`)
- **Location**: `scratch/vendor/hindi-anime-api/hindi-anime-api-main/`
- **Type**: Node.js Express server
- **Purpose**: Hindi-dubbed anime streaming API
- **Status**: Code available, partially integrated via `core/hindi-dubbed.js`
- **Integration notes**: Has its own server.js, scrapers, routes

### 4. AnimeWorld India (`animeworld-india-api/`)
- **Location**: `scratch/animeworld-india-api/`
- **Type**: PHP API
- **Purpose**: Hindi/Indian anime streaming
- **Status**: Partially integrated via `core/anime-world-india.js`
- **Integration notes**: PHP-based, can't run in Workers

### 5. Moviebox API (`moviebox-src/`)
- **Location**: `scratch/moviebox-src/Moviebox-API-main/`
- **Type**: Python API
- **Purpose**: Movie streaming API
- **Status**: Integrated via `core/moviebox.js`
- **Integration notes**: Python-based, integrated as HTTP client

### 6. Hinataw Anime Stream (`hinata-anime-stream/`)
- **Location**: `scratch/hinata-anime-stream/`
- **Type**: Node.js web app
- **Purpose**: Frontend streaming player
- **Status**: Separate project, not integrated
- **Integration notes**: Has its own public/, server.js

## Built-in Integrations (Fully Integrated)

### Core Modules
- `core/anime-router.js` - Main API router (3388 lines)
- `core/anime-service.js` - Anime catalog & search
- `core/anilist.js` - AniList API integration
- `core/hianime-service.js` - HiAnime integration
- `core/hianime-sync.js` - HiAnime sync engine
- `core/moviebox.js` - MovieBox integration
- `core/manga.js` - Manga source (MangaKakalot + MangaDex)
- `core/mangadex.js` - MangaDex API
- `core/doc-store.js` - Persistent storage
- `core/user-service.js` - User authentication
- `core/smartcache.js` - Caching layer
- `core/episode-cache.js` - Episode caching
- `core/episode-strategy.js` - Provider resolution
- `core/mapper.js` - ID mapping
- `core/stream-utils.js` - Stream utilities
- `core/subtitle-lang.js` - Subtitle language handling
- `core/wreq.js` - HTTP client wrapper

### Extractors
- `extractors/megaplay.js` - MegaPlay stream extraction
- `extractors/vidplay.js` - VidPlay extraction
- `extractors/flixcloud.js` - FlixCloud manifest handling
- `extractors/datasv.js` - DATASV extraction
- `extractors/byse.js` - Byse extraction
- `extractors/nova.js` - Nova extraction
- `extractors/vidmoly.js` - VidMoly extraction
- `extractors/zoko.js` - Zoko extraction

## API Endpoints

### Anime API (`/api/anime/*`, `/home`, etc.)
- `GET /home` - Home page data
- `GET /api/home` - Alternative home endpoint
- `GET /api/anime/*` - Anime catalog
- `GET /api/hianime/*` - HiAnime specific
- `GET /api/india/*` - India catalog

### MovieBox API (`/api/moviebox/*`)
- `GET /api/moviebox/home` - MovieBox home
- `GET /api/moviebox/list` - MovieBox library
- `GET /api/moviebox/search` - MovieBox search
- `GET /api/moviebox/detail` - MovieBox detail
- `GET /api/moviebox/stream` - MovieBox stream
- `GET /api/moviebox/video` - Video proxy

### Manga API (`/api/manga/*`)
- `GET /api/manga/*` - Manga routes

### Streaming (`/watch/*`, `/stream/*`, `/episodes/*`)
- `GET /watch/:provider/:id/sub|dub/:provider-:ep` - Watch stream
- `GET /stream/reanime/:id/sub|dub/:ep` - ReAnime direct stream
- `GET /episodes/:anilistId` - Episode list
- `GET /episodes/:provider/:anilistId` - Filtered episodes

### User & Feedback
- `POST /api/feedback/*` - Feedback submission
- `GET /api/notices` - Site notices
- `GET /api/user/*` - User endpoints
- `GET /api/diag` - Diagnostics

### Utility
- `GET /map/:anilistId` - ID mappings
- `GET /api` - API info
- `GET /logo.svg` - Logo
- `GET /sw.js` - Service worker

## Deployment Targets

### Cloudflare Workers (Recommended)
- **Bundle**: `freebuff/dist/worker.js`
- **Config**: `freebuff/wrangler.toml`
- **Includes**: All core modules, providers, extractors
- **Excludes**: Node-only modules (fs, path shims provided)

### Node.js Server
- **Entry**: `server.js`
- **Port**: 3000 (default)
- **Includes**: Everything + local file system access

### Static Hosting (Limited)
- **Assets**: `public/`
- **Limitations**: No API, no streaming, only hardcoded UI

## Environment Variables

| Variable | Default | Used By |
|----------|---------|---------|
| `PORT` | 3000 | server.js |
| `CACHE_ENABLED` | false | smartcache.js |
| `ADMIN_PASSWORD` | - | user-service.js |
| `MANGA_PROXY` | on | manga.js |
| `MKISSA_WREQ_BROWSER` | chrome_149 | mkissa.js |
| `MKISSA_WREQ_OS` | windows | mkissa.js |

## Integration Status Summary

| Integration | Fully Integrated | Available but Separate |
|-------------|-----------------|------------------------|
| Anime Providers (14) | ✅ All in providers/ | - |
| MangaKakalot | ✅ core/manga.js | - |
| MangaDex | ✅ core/mangadex.js | - |
| MovieBox | ✅ core/moviebox.js | - |
| HiAnime | ✅ core/hianime-* | - |
| AnimeWorld India | ⚠️ Partial via core/ | PHP version in animeworld-india-api/ |
| MangaFire | ❌ Not integrated | TypeScript lib in vendor/mangafire/ |
| MangaHook | ❌ Not integrated | Express server in vendor/mangahook/ |
| Hindi Anime API | ❌ Not integrated | Express server in vendor/hindi-anime-api/ |
| Moviebox Python API | ❌ Not integrated | Python in moviebox-src/ |
| Hinataw Stream | ❌ Not integrated | Separate app in hinata-anime-stream/ |

## Next Steps for Full Integration

1. **MangaFire**: Convert TypeScript to JavaScript, integrate into `core/manga.js` as fallback
2. **MangaHook**: Merge Express routes into main API router
3. **Hindi Anime API**: Merge scrapers into `providers/` directory
4. **Moviebox Python API**: Already using HTTP client approach, no Python needed
5. **Hinataw Stream**: Frontend is already in `public/`, backend is in `index.js`

See `DEPLOYMENT.md` for deployment instructions.
