# Hinataw.exe Deployment Guide

## Overview

This project has three deployment paths:

1. **Cloudflare Workers** - Full app with API + frontend, but MovieBox is unreachable from that egress
2. **Node host** (required for MovieBox playback) - Full app, MovieBox works natively
3. **Static Hosting** - Frontend only, APIs won't work

## MovieBox needs a Node host

MovieBox refuses Cloudflare egress outright — measured from the deployed Worker:
`api.inmoviebox.com` answers `403 Service not available in current region`, the h5
BFF (`netfilm.world` / `h5-api.aoneroom.com`) answers `429 RESOURCE_EXHAUSTED`, and
every video host (`bcdn`, `bcdnxw`, `sbcdnw`) answers `427/429` for any User-Agent
profile. A browser cannot fetch those files either (the CDN gates on the client, so
`<video>` gets a format error). An ordinary Node/undici client is accepted: the same
machine resolves streams in 1–4 s and the CDN returns `206 video/mp4`.

So MovieBox titles only play where the app runs on Node. Two free options:

### Render free (fastest to set up, 5 GB/month bandwidth)

`render.yaml` mirrors the app as a Render Blueprint. In the Render dashboard:
**New → Blueprint → pick this repository → Apply**. The service builds with
`npm install` and starts with `node server.js`; the health check is `/api/home`.
Free services sleep after 15 minutes idle, so the first request after a quiet spell
takes 30–60 s. 5 GB/month of egress is roughly 4–8 films, so this is a way to get
playback working, not to run the site on.

### Oracle Cloud Always Free (10 TB/month egress, always on)

The only free host with enough bandwidth to stream video:

1. Create an Always Free **VM.Standard.A1.Flex** (Ubuntu 22.04) and open ports 80/443
   in the subnet's security list.
2. Install Node 22, clone this repository, then `npm install`.
3. Run it under systemd: `ExecStart=/usr/bin/node /opt/hinataw/server.js`, with
   `PORT=3000`, `NODE_ENV=production`.
4. Put Caddy or nginx in front for TLS, and point the domain at the VM.

## Option 1: Cloudflare Workers (full app, no MovieBox playback)

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
