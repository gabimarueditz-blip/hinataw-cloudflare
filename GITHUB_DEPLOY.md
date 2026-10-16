# GitHub Deployment Guide for Hinataw.exe

## Quick Start

### 1. Create GitHub Repository

Go to [github.com/new](https://github.com/new) and create:

| Field | Value |
|-------|-------|
| **Owner** | `walterwhite-69` (your GitHub username) |
| **Repo name** | `hinataw-cloudflare` |
| **Visibility** | Public or Private |
| **Initialize** | **Do NOT** check any boxes (no README, .gitignore, license) |

### 2. Push Your Local Files

Open terminal in `C:\Users\Dell\.gemini\antigravity\scratch\9Anime-main\`:

```powershell
# Initialize git (if not already)
git init

# Add all files
git add .

# Commit
git commit -m "Hinataw.exe - Full anime streaming platform with Cloudflare Workers deployment"

# Add remote (replace with your actual username)
git remote add origin https://github.com/walterwhite-69/hinataw-cloudflare.git

# Push
git branch -M main
git push -u origin main
```

### 3. Deploy to Cloudflare Workers

#### Method A: Using wrangler CLI

```bash
# Install wrangler globally
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Navigate to freebuff directory
cd freebuff

# Deploy
wrangler publish
```

#### Method B: Using Freebuff Sites Dashboard

1. Go to your Freebuff dashboard
2. Navigate to your site (hinataw)
3. Use the deploy option to upload the Workers bundle

The deployment manifest is at `freebuff/dist/manifest.json`.

## What Gets Deployed

The `freebuff/dist/worker.js` bundle includes:

### Frontend (UI)
- ✅ Complete HTML/CSS/JS web interface
- ✅ Featured anime hero section
- ✅ Trending carousel with anime cards
- ✅ Genre filter buttons
- ✅ Search functionality
- ✅ Watchlist, feedback, user features

### Backend (API)
- ✅ `/home` - Home page data (trending, new releases, etc.)
- ✅ `/api/home` - Alternative home endpoint
- ✅ `/api/anime/*` - Anime catalog & episode endpoints
- ✅ `/api/moviebox/*` - MovieBox integration
- ✅ `/api/hianime/*` - HiAnime integration  
- ✅ `/api/manga/*` - Manga portal
- ✅ `/api/feedback/*` - User feedback
- ✅ `/watch/*` - Streaming endpoints for all providers
- ✅ `/map/:id` - AniList ID mapping
- ✅ `/episodes/:id` - Episode lists

### Providers (14 total)
- MKissa, Reanime, AniKoto, AnimeGG, AniNeko, AniDB App, AniZone, AniWaves, Anibd, Kickassanime, AnimeDunya, AnimeOnsen, and more

## Files Included in Repository

```
hinataw-cloudflare/
├── freebuff/                    # Workers deployment
│   ├── dist/
│   │   ├── worker.js           # Complete bundle (1.56 MiB)
│   │   └── manifest.json       # Deploy manifest
│   ├── relay/                  # Auth relay service
│   └── wrangler.toml           # Workers config
├── public/                      # Static assets (favicon, etc.)
├── core/                        # All API logic & providers
├── api/                         # API route handlers
├── index.js                     # Main Workers entry
├── server.js                    # Node.js dev server
├── package.json
├── DEPLOYMENT.md
├── GITHUB_DEPLOY.md             # This file
├── README.md
└── .gitignore
```

## Do NOT Commit

These files are in `.gitignore` and should NOT be pushed:

- `node_modules/`
- `.env`, `.env.local` (secrets)
- `.vercel/`, `.vercel-token`
- `.freebuff-secrets/`
- `core/.cache/`

## Environment Variables

For Cloudflare Workers production deployment, set secrets using:

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put YOUR_OTHER_SECRET
```

Do NOT hardcode secrets in your code.

## Troubleshooting

### "No anime displayed" after deployment
- Ensure you deployed the **Workers bundle** (`freebuff/dist/worker.js`), not just static files
- Check Cloudflare dashboard for deployment status
- Verify the worker is responding at your deployed URL

### API returns 404 or errors
- The Workers bundle must be deployed - static hosting won't work
- Check browser console for fetch errors
- Verify environment variables are set correctly

### Build exceeds 10 MiB limit
- The current bundle is ~1.56 MiB, well under the limit
- If it grows, run `npm run build` to regenerate
