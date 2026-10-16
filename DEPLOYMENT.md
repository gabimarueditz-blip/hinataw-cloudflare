# Hinataw.exe Deployment Guide

## Overview

This project has two deployment paths:

1. **Cloudflare Workers** (Recommended) - Full app with API + frontend
2. **Static Hosting** - Frontend only, APIs won't work

## Option 1: Cloudflare Workers (Full Functionality)

The Workers bundle at `freebuff/dist/` contains the complete application:

### Files Included
- `freebuff/dist/worker.js` - Complete bundled application (frontend + API)
- `freebuff/dist/manifest.json` - Deployment manifest
- `freebuff/wrangler.toml` - Workers configuration

### Deployment Steps

1. Install wrangler:
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Deploy from the freebuff directory:
   ```bash
   cd freebuff
   wrangler publish
   ```

### What Works
- ✅ Frontend UI (HTML/CSS/JS)
- ✅ API endpoints (/api/anime/, /api/home, /api/moviebox/, etc.)
- ✅ Anime catalog loading
- ✅ Streaming endpoints
- ✅ Search functionality
- ✅ User features (watchlist, feedback, etc.)

## Option 2: Static Hosting (Limited)

If deploying to static hosting (Vercel Pages, Cloudflare Pages with static only):

### What's Included
- `public/` - Static frontend assets
- `index.html` - Main entry point

### What DOESN'T Work
- ❌ `/api/*` endpoints (require server)
- ❌ `/home` endpoint (requires server)
- ❌ `/api/moviebox/*` endpoints (require server)
- ❌ Anime catalog loading
- ❌ Search functionality
- ❌ Streaming

### Why APIs Don't Work
The frontend JavaScript in `public/index.html` calls:
- `fetch('/home')` - needs server
- `fetch('/api/home')` - needs server
- `fetch('/api/moviebox/home')` - needs server

These endpoints exist in `index.js` and `core/anime-router.js` but require a runtime that can execute server-side code.

## Repository Structure for GitHub

When pushing to GitHub for Cloudflare deployment:

```
9Anime-main/
├── freebuff/              # Workers deployment bundle (DEPLOY THIS)
│   ├── dist/
│   │   ├── worker.js      # Complete app bundle
│   │   └── manifest.json  # Deployment manifest
│   └── wrangler.toml      # Workers config
├── public/                # Static assets (also included in worker)
├── core/                  # API logic (bundled into worker.js)
├── api/                   # API routes (bundled into worker.js)
├── index.js               # Main entry point (bundled into worker.js)
├── server.js              # Node dev server (NOT for production)
├── package.json
├── .gitignore
└── DEPLOYMENT.md          # This file
```

## What to Push to GitHub

For Cloudflare Workers deployment, push the ENTIRE project but deploy using the Workers bundle:

```bash
# In scratch/9Anime-main/
git add .
git commit -m "Add Hinataw.exe with full API support"
git push origin main
```

Then deploy using:
```bash
cd freebuff
wrangler publish
```

Or use the Freebuff sites_deploy tool with the manifest at `freebuff/dist/manifest.json`.

## Environment Variables

For production, set these as Workers secrets (not in code):

- `ADMIN_PASSWORD` - Admin portal password
- Any API keys for providers

Do NOT commit `.env`, `.env.local`, or `.vercel-token` files.
