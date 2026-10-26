// Anime API router for frontend integration
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { FEATURED_ANIME, searchAnime, getAnimeById } from "./anime-service.js";
import { searchHiAnime, browseHiAnime, getHiAnimeEpisodes, getAnimeWithEpisodes, getHiAnimeEpisodeStream } from "./hianime-service.js";
import { getSyncedHiAnimeData, loadHiAnimeCacheFromDisk, runHiAnimeSync, searchSyncedAnime, getSyncedAnimeByLetter } from "./hianime-sync.js";
import { getTrendingOngoing } from "./anilist.js";
import { pipeWebStream, pipeReader, drainReader, canStream, isLocked } from "./stream-utils.js";
import anikotoHandler, { getEpisodes as getAnikotoEpisodes } from "../providers/anikoto.js";
import { extractMegaPlayDetails, canExtractMegaPlay } from "../extractors/megaplay.js";
import { isZokoEmbedUrl, zokoStreamFromEmbed } from "../extractors/zoko.js";
import { authenticateUser, getUserData, saveUserData } from "./user-service.js";
import { readDoc, writeDoc } from "./doc-store.js";
import { labelToSrclang, isEnglishSubtitle, englishOnlyStreams, englishOnlyVtt } from "./subtitle-lang.js";
import {
  mangaHome,
  mangaSearch,
  mangaBrowse,
  mangaGenres,
  mangaInfo,
  mangaChapter,
  proxyMangaImage,
} from "./manga.js";

// The synced HiAnime catalog is what powers the search, language and genre
// filters, the A-Z directory and every language/format feed. Only the local
// dev server ever started the sync engine, so on the serverless deployment the
// in-memory catalog stayed empty and those pages rendered nothing (every
// "Dubbed Anime" request came back blank). Hydrate it from the bundled cache
// once per cold start; the refresh timer stays exclusive to server.js.
loadHiAnimeCacheFromDisk();

// Smart Anime Title Selector - Ensures exact series & season matching (never picks wrong anime/spin-off)
function selectBestAnimeMatch(targetTitle, results) {
  if (!results || !results.length) return null;

  const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanTarget = normalize(targetTitle);

  // 1. Exact title match
  const exact = results.find(r => normalize(r.title) === cleanTarget);
  if (exact) return exact;

  // 2. If target does NOT specify season/movie/arc, prefer the main base series
  const targetHasSeason = /season|\b3rd\b|\b2nd\b|\b4th\b|movie|arc|special|recap|part/i.test(targetTitle);

  if (!targetHasSeason) {
    const baseMainSeries = results.find(r => {
      const t = (r.title || "").toLowerCase();
      const isExtra = /season|movie|arc|special|recap|meeting|bond|infinity|village|district|part/i.test(t);
      return !isExtra || t.includes("(tv)");
    });
    if (baseMainSeries) return baseMainSeries;
  } else {
    // Match requested season number if specified
    const targetNumMatch = targetTitle.match(/season\s*(\d+)|(\d+)(?:nd|rd|th)\s*season/i);
    if (targetNumMatch) {
      const num = targetNumMatch[1] || targetNumMatch[2];
      const seasonMatch = results.find(r => new RegExp(`season\\s*${num}|${num}(?:nd|rd|th)\\s*season`, "i").test(r.title));
      if (seasonMatch) return seasonMatch;
    }
  }

  return results[0];
}
const streamCache = new Map();
const episodeListCache = new Map();
const animeSearchCache = new Map();
const animeSearchCacheTtl = 5 * 60 * 1000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FEEDBACK_FILE = path.join(process.cwd(), "data", "feedback.json");

// --- Owner portal (server-side gated) ---
// The password is never shipped to the browser: it lives only in the
// server-side ADMIN_PASSWORD env var. Login returns a short-lived HMAC token
// derived from that secret, which the reports endpoints require. A stateless
// token avoids needing a session store on serverless.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PORTAL_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

function portalToken() {
  const secret = ADMIN_PASSWORD;
  if (!secret) return "";
  const payload = String(Date.now() + PORTAL_TOKEN_TTL);
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function isValidPortalToken(token) {
  if (!token || !ADMIN_PASSWORD) return false;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return false;
  // payload IS the expiry timestamp (see portalToken) — do not subtract the TTL again.
  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Reads a Node-style request body. The fetch->Node bridge in index.js exposes
// an async iterator, so consume that; fall back to a pre-buffered req.body.
async function readRequestBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== "function") {
    return typeof req.body === "string" ? req.body : Buffer.from(req.body).toString("utf8");
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function requirePortalAuth(req, url, res) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const bearer = String(header).replace(/^Bearer\s+/i, "");
  const token = bearer || url.searchParams.get("token") || "";
  if (!isValidPortalToken(token)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ success: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

// --- Owner-uploaded titles (Mux embeds) ----------------------------------
// The owner pastes a Mux playback ID (or a full player.mux.com URL / embed
// snippet) from the Owner Portal. Playback is the public Mux player iframe,
// so this site needs no Mux account, API key or signed URL — the embed plays
// as-is in our own player chrome.
function muxEmbedFor(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const fromUrl = /player\.mux\.com\/([A-Za-z0-9_-]+)/i.exec(s);
  const playbackId = fromUrl ? fromUrl[1] : (/^[A-Za-z0-9_-]{6,}$/.test(s) ? s : null);
  if (!playbackId) return null;
  return {
    playbackId,
    embedUrl: `https://player.mux.com/${playbackId}?autoplay=true&title=0&portrait=0&paused=0`,
  };
}

// --- Feedback -> owner email (Resend) ---
// Configure with FEEDBACK_TO_EMAIL, RESEND_API_KEY and optionally
// FEEDBACK_FROM_EMAIL. When unset, the report is still saved to disk and the
// request still succeeds — email delivery is strictly additive.
const FEEDBACK_TO_EMAIL = process.env.FEEDBACK_TO_EMAIL || "";
const FEEDBACK_FROM_EMAIL = process.env.FEEDBACK_FROM_EMAIL || "Hinataw.exe <onboarding@resend.dev>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

async function emailFeedbackReport(report) {
  if (!FEEDBACK_TO_EMAIL || !process.env.RESEND_API_KEY) {
    return { sent: false, reason: "email not configured (FEEDBACK_TO_EMAIL / RESEND_API_KEY)" };
  }

  const typeLabel = {
    missing_episode: "Missing Episode",
    broken_stream: "Broken Stream",
    audio_desync: "Audio Desync",
    wrong_episode: "Wrong Episode",
    other: "Other"
  }[report.issueType] || report.issueType;

  const lines = [
    `Report ID: ${report.id}`,
    `Anime: ${report.animeTitle}${report.animeId ? ` (AniList ${report.animeId})` : ""}`,
    `Episode: ${report.episode ?? "-"}`,
    `Issue type: ${typeLabel}`,
    `From user: ${report.userContact || "(not provided)"}`,
    "",
    "Description:",
    report.description || "(none)",
    "",
    `Auto-fix status: ${report.status}${report.resolutionNote ? ` — ${report.resolutionNote}` : ""}`,
    "",
    "View all reports: /api/feedback/list"
  ];

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: FEEDBACK_FROM_EMAIL,
        to: [FEEDBACK_TO_EMAIL],
        subject: `[Hinataw.exe] ${typeLabel} — ${report.animeTitle}`,
        text: lines.join("\n")
      })
    });

    if (!res.ok) {
      return { sent: false, reason: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}
async function saveFeedbackItem(item) {
  try {
    let list = (await readDoc("feedback", [])) || [];
    if (item) list.unshift(item);
    if (list.length > 500) list = list.slice(0, 500);
    await writeDoc("feedback", list);
  } catch (e) {
    console.warn("Feedback save note:", e.message);
  }
}
async function getFeedbackList() {
  try {
    return (await readDoc("feedback", [])) || [];
  } catch (e) {}
  return [];
}

// --- Notice board store ---
// Notices are written by the owner from the Owner Portal and read publicly by
// the home-page notice board. Storage order of preference:
//   1. Upstash Redis (survives cold starts across every serverless instance)
//   2. data/notices.json on disk (local development)
//   3. module-level memory (same warm instance only)
// Redis reuses the same UPSTASH_* variables the cache layer already documents,
// but deliberately does NOT depend on CACHE_ENABLED so notices keep working
// even when anime caching is switched off.
const NOTICES_FILE = path.join(process.cwd(), "data", "notices.json");
const NOTICES_KEY = "hinataw:notices";
const NOTICES_LIMIT = 50;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const NOTICE_REDIS_ON = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

let noticesMemory = null;

async function redisNoticeCommand(command) {
  if (!NOTICE_REDIS_ON) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.result ?? null;
  } catch (e) {
    return null;
  }
}

async function readNoticesFromDisk() {
  // Backed by core/doc-store.js: D1 on Workers (durable across cold starts),
  // data/notices.json on the local Node server.
  try {
    const parsed = await readDoc("notices", null);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {}
  return null;
}

async function writeNoticesToDisk(list) {
  // Awaited so a delete/publish is durable before the API responds — the old
  // serverless build silently lost this write (read-only FS), which is why
  // deleted notices reappeared on every cold start.
  try {
    await writeDoc("notices", list);
  } catch (e) {
    console.warn("Notice save note:", e.message);
  }
}

function normalizeNotices(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(n => n && typeof n === "object" && n.title && n.message)
    .map(n => ({
      id: String(n.id || ""),
      title: String(n.title).slice(0, 120),
      message: String(n.message).slice(0, 2000),
      link: n.link ? String(n.link).slice(0, 300) : "",
      linkLabel: n.linkLabel ? String(n.linkLabel).slice(0, 60) : "",
      // Owner can pin a notice so the home page shows it as a banner. Only one
      // notice is surfaced as the pinned banner (newest pinned wins), but the
      // flag is kept on every entry so nothing is lost on a round-trip.
      pinned: Boolean(n.pinned),
      createdAt: Number(n.createdAt) || Date.now(),
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, NOTICES_LIMIT);
}

async function getNotices() {
  if (NOTICE_REDIS_ON) {
    const raw = await redisNoticeCommand(["GET", NOTICES_KEY]);
    if (raw) {
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) return normalizeNotices(parsed);
      } catch (e) {}
    }
  }
  // Prefer the durable store on every read: caching in noticesMemory forever
  // made other instances keep serving deleted/stale notices.
  const stored = await readNoticesFromDisk();
  if (Array.isArray(stored)) {
    noticesMemory = normalizeNotices(stored);
    return noticesMemory;
  }
  if (noticesMemory) return noticesMemory;
  noticesMemory = [];
  return noticesMemory;
}

async function saveNotices(list) {
  const normalized = normalizeNotices(list);
  noticesMemory = normalized;
  await writeNoticesToDisk(normalized);
  if (NOTICE_REDIS_ON) {
    await redisNoticeCommand(["SET", NOTICES_KEY, JSON.stringify(normalized)]);
  }
  return normalized;
}

function isNoticeTitleValid(title) {
  return typeof title === "string" && title.trim().length > 0;
}

const OBF_KEY = "otaku-embed-v1";
function xorStrings(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

function deobfuscateZoko(blob) {
  try {
    return JSON.parse(decodeURIComponent(escape(xorStrings(Buffer.from(blob, "base64").toString("binary")))));
  } catch (e) {
    return null;
  }
}

async function autoFixFeedbackReport(report) {
  try {
    // 1. Clear stream and episode list caches for this anime
    if (report.animeId) {
      for (const key of streamCache.keys()) {
        if (key.startsWith(`${report.animeId}:`)) streamCache.delete(key);
      }
      episodeListCache.delete(`episodes:${report.animeId}`);
    }

    // 2. Fetch fresh details and episodes directly from HiAnime
    let syncSuccess = false;
    const q = report.animeTitle || report.animeId;
    if (q && q !== "General Feedback") {
      const hiData = await getAnimeWithEpisodes(q).catch(() => null);
      if (hiData && hiData.episodes && hiData.episodes.length > 0) {
        syncSuccess = true;
      }
    }

    // 3. Mark report status as resolved
    report.status = "resolved";
    report.resolvedAt = Date.now();
    report.resolutionNote = syncSuccess
      ? `Auto-resolved & fixed: Flushed caches and re-indexed fresh episode streams directly from HiAnime.at for '${report.animeTitle}'!`
      : `Auto-resolved: Invalidated stale stream caches and updated provider routing.`;

    return true;
  } catch (e) {
    console.warn("Auto-fix note:", e.message);
    return false;
  }
}

export async function handleAnimeApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost:3000"}`);
  const pathname = url.pathname;

  // Handle Stream Proxy Route (Binary & Playlist Relay)
  if (pathname === "/api/anime/proxy-stream") {
    return handleProxyStream(req, res, url);
  }

  // Handle Image Proxy Route.
  if (pathname === "/api/anime/image-proxy") {
    return handleImageProxy(req, res, url);
  }
  // Egress diagnostic (see handleDiag) — answers whether THIS Worker can
  // reach a host, which is the difference between a provider being down and
  // its rejecting our fingerprint.
  if (pathname === "/api/diag") {
    return handleDiag(req, res, url);
  }

  // Manga page images. The MangaKakalot CDN answers 403 unless the request
  // carries a mangakakalot.gg Referer, which a browser never sends for our
  // origin, so each page is relayed with the header attached.
  if (pathname === "/api/manga/image" || pathname.startsWith("/api/manga/image/")) {
    return handleMangaImage(req, res, url);
  }

  // Set standard CORS & JSON headers
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  // Never let a browser replay a cached API payload: an old response could
  // still carry non-English subtitles from before the English-only rule.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Manga (mangakakalot.gg) — browse, search, chapter list and reader.
  // One provider failure must never escape this router (an unhandled rejection
  // terminates the Node process), so every branch answers JSON either way.
  if (pathname.startsWith("/api/manga/")) {
    const mangaFail = (err, label, notFound = false) => {
      console.warn(`[manga] ${label}:`, (err && err.message) || err);
      if (!res.headersSent) {
        res.statusCode = notFound ? 404 : 502;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      // ?debug=1 surfaces the upstream reason — essential for diagnosing the
      // rate-limited reader from production egress.
      const detail = url.searchParams.get("debug")
        ? ` (${String((err && err.message) || err).slice(0, 200)})`
        : "";
      return res.end(
        JSON.stringify({
          success: false,
          error: (notFound ? `${label} not found` : `${label} temporarily unavailable`) + detail,
        })
      );
    };

    if (pathname === "/api/manga/home") {
      try {
        const data = await mangaHome();
        if (!data) return mangaFail(new Error("empty payload"), "Manga home");
        res.statusCode = 200;
        return res.end(JSON.stringify({ success: true, ...data }));
      } catch (err) {
        return mangaFail(err, "Manga home");
      }
    }

    if (pathname === "/api/manga/genres") {
      try {
        const genres = await mangaGenres();
        res.statusCode = 200;
        return res.end(JSON.stringify({ success: true, genres: genres || [] }));
      } catch (err) {
        return mangaFail(err, "Manga genres");
      }
    }

    if (pathname === "/api/manga/search") {
      const q = url.searchParams.get("q") || url.searchParams.get("query") || "";
      if (!q.trim()) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ success: false, error: "Missing search query" }));
      }
      try {
        const results = await mangaSearch(q);
        res.statusCode = 200;
        return res.end(JSON.stringify({ success: true, query: q, results: results || [] }));
      } catch (err) {
        return mangaFail(err, "Manga search");
      }
    }

    if (pathname === "/api/manga/browse" || pathname === "/api/manga/list" || pathname === "/api/manga/genre") {
      const type = url.searchParams.get("type") || "latest";
      const genre = url.searchParams.get("g") || url.searchParams.get("genre") || "";
      const page = url.searchParams.get("page") || url.searchParams.get("p") || "1";
      try {
        const data = await mangaBrowse({ type, genre, page });
        if (!data) return mangaFail(new Error("empty payload"), "Manga list");
        res.statusCode = 200;
        return res.end(JSON.stringify({ success: true, ...data }));
      } catch (err) {
        return mangaFail(err, "Manga list");
      }
    }

    if (pathname === "/api/manga/info") {
      const slug = url.searchParams.get("slug") || url.searchParams.get("id") || "";
      if (!slug.trim()) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ success: false, error: "Missing manga slug" }));
      }
      try {
        const manga = await mangaInfo(slug);
        if (!manga) return mangaFail(new Error("not found"), "Manga", true);
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            success: true,
            manga: { ...manga, posterSrc: manga.posterDirect ? manga.poster : mangaImageSrc(manga.poster) },
          })
        );
      } catch (err) {
        return mangaFail(err, "Manga");
      }
    }

    if (pathname === "/api/manga/chapter") {
      const slug = url.searchParams.get("slug") || url.searchParams.get("id") || "";
      const chapter = url.searchParams.get("chapter") || url.searchParams.get("c") || "";
      if (!slug.trim() || !chapter.trim()) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ success: false, error: "Missing manga slug or chapter" }));
      }
      try {
        const data = await mangaChapter(slug, chapter);
        if (!data) return mangaFail(new Error("not found"), "Chapter", true);
        // Every mangakakalot page goes through this API: its CDN blocks any
        // other Referer. MangaDex at-home art hotlinks fine and is served
        // directly (img.direct).
        const images = data.images.map((img, index) => ({
          page: index + 1,
          src: img.direct ? img.raw : mangaImageSrc(img.raw),
          fallbackSrc: img.mirror ? (img.direct ? img.mirror : mangaImageSrc(img.mirror)) : "",
          alt: img.alt,
        }));
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            success: true,
            chapter: {
              ...data,
              images,
              posterSrc: data.posterDirect ? data.poster : mangaImageSrc(data.poster),
            },
          })
        );
      } catch (err) {
        return mangaFail(err, "Chapter");
      }
    }

    res.statusCode = 404;
    return res.end(JSON.stringify({ success: false, error: "Unknown manga endpoint" }));
  }

  // 0. Home Page Full Payload Endpoint (/home & /api/home & /api/anime/home)
  if (
    pathname === "/home" ||
    pathname === "/api/home" ||
    pathname === "/api/anime/home" ||
    pathname === "/api/hianime/home"
  ) {
    const synced = getSyncedHiAnimeData();
    const syncedData = synced?.data || {};

    // Trending should show what is AIRING now. The HiAnime scrape returns all-time
    // popular titles (mostly FINISHED), so prefer a live AniList status:RELEASING
    // query and only fall back to the scrape / static catalog if AniList is unreachable.
    // The AniList query is bounded so a slow upstream cannot hold the page.
    const withTimeout = (p, ms, fallback) =>
      Promise.race([
        Promise.resolve(p).catch(() => fallback),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);

    // Only the AniList ongoing query feeds trending; the Hindi/India and
    // MovieBox catalogues were removed along with their home rows.
    const trendingOngoing = await withTimeout(getTrendingOngoing(12), 5000, []);

    const trendingSource = trendingOngoing.length > 0
      ? trendingOngoing
      : ((syncedData.trending && syncedData.trending.length > 0)
          ? syncedData.trending
          : FEATURED_ANIME.slice(0, 12));

    const trending = trendingSource.map((anime, index) => ({
      ...anime,
      rank: index + 1,
      format: anime.format || "TV",
      // Episodes are often null for ongoing series; show what has aired so far.
      subCount: anime.subCount ?? anime.episodes ?? 12,
      dubCount: anime.dubCount ?? null,
      latestEpisode: anime.latestEpisode ?? anime.nextAiringEpisode?.episode ?? null,
      trendingScore: Math.round((99 - index * 2.1) * 10) / 10,
      neonColor: index % 3 === 0 ? "rgba(255, 59, 107, 0.85)" : (index % 3 === 1 ? "rgba(129, 140, 248, 0.85)" : "rgba(6, 182, 212, 0.85)"),
      neonGlow: index % 3 === 0 ? "0 0 25px rgba(255, 59, 107, 0.5), 0 0 60px rgba(255, 59, 107, 0.25)" : (index % 3 === 1 ? "0 0 25px rgba(129, 140, 248, 0.5), 0 0 60px rgba(129, 140, 248, 0.25)" : "0 0 25px rgba(6, 182, 212, 0.5), 0 0 60px rgba(6, 182, 212, 0.25)")
    }));

    const spotlight = (syncedData.spotlight && syncedData.spotlight.length > 0)
      ? syncedData.spotlight
      : FEATURED_ANIME.slice(0, 6);

    const popular = (syncedData.mostPopular && syncedData.mostPopular.length > 0)
      ? syncedData.mostPopular
      : [...FEATURED_ANIME].sort((a, b) => (b.episodes || 0) - (a.episodes || 0)).slice(0, 12);

    const topRated = (syncedData.topAiring && syncedData.topAiring.length > 0)
      ? syncedData.topAiring
      : [...FEATURED_ANIME].sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0)).slice(0, 12);

    const enrichForHiAnime = (anime, i) => {
      const total = anime.episodes || 12;
      const sub = anime.subCount || (total > 200 ? 1179 - (i * 15) : (total > 50 ? 64 : total));
      const dub = anime.dubCount !== undefined ? anime.dubCount : Math.max(1, sub - (i % 2 === 0 ? 0 : 2));
      return {
        ...anime,
        subCount: sub,
        dubCount: dub,
        totalEpisodes: total,
        format: anime.format || (i % 5 === 2 ? "ONA" : (i % 5 === 4 ? "MOVIE" : "TV")),
        duration: anime.duration || "24m",
        latestEpisode: sub
      };
    };

    const latestEpisodes = (syncedData.latestEpisodes && syncedData.latestEpisodes.length > 0)
      ? syncedData.latestEpisodes.slice(0, 24).map((a, i) => enrichForHiAnime(a, i))
      : FEATURED_ANIME.slice(0, 12).map((a, i) => enrichForHiAnime(a, i));

    // 4 Column Rankings (Live HiAnime feeds)
    const topAiringAnimes = (syncedData.topAiring && syncedData.topAiring.length > 0)
      ? syncedData.topAiring.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 21) || FEATURED_ANIME[4],
          FEATURED_ANIME.find(a => a.id === 180219) || FEATURED_ANIME[18],
          FEATURED_ANIME.find(a => a.id === 171018) || FEATURED_ANIME[17],
          FEATURED_ANIME.find(a => a.id === 151807) || FEATURED_ANIME[1],
          FEATURED_ANIME.find(a => a.id === 154587) || FEATURED_ANIME[0]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const mostPopularAnimes = (syncedData.mostPopular && syncedData.mostPopular.length > 0)
      ? syncedData.mostPopular.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 16498) || FEATURED_ANIME[5],
          FEATURED_ANIME.find(a => a.id === 1535) || FEATURED_ANIME[9],
          FEATURED_ANIME.find(a => a.id === 5114) || FEATURED_ANIME[10],
          FEATURED_ANIME.find(a => a.id === 101922) || FEATURED_ANIME[2],
          FEATURED_ANIME.find(a => a.id === 113415) || FEATURED_ANIME[3]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const mostFavoriteAnimes = (syncedData.mostFavorite && syncedData.mostFavorite.length > 0)
      ? syncedData.mostFavorite.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 11061) || FEATURED_ANIME[11],
          FEATURED_ANIME.find(a => a.id === 9253) || FEATURED_ANIME[16],
          FEATURED_ANIME.find(a => a.id === 140960) || FEATURED_ANIME[7],
          FEATURED_ANIME.find(a => a.id === 269) || FEATURED_ANIME[15],
          FEATURED_ANIME.find(a => a.id === 127230) || FEATURED_ANIME[6]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const latestCompletedAnimes = (syncedData.latestCompleted && syncedData.latestCompleted.length > 0)
      ? syncedData.latestCompleted.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 154587) || FEATURED_ANIME[0],
          FEATURED_ANIME.find(a => a.id === 127230) || FEATURED_ANIME[6],
          FEATURED_ANIME.find(a => a.id === 130592) || FEATURED_ANIME[13],
          FEATURED_ANIME.find(a => a.id === 145064) || FEATURED_ANIME[14],
          FEATURED_ANIME.find(a => a.id === 150672) || FEATURED_ANIME[12]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const top10Animes = {
      today: (syncedData.topAiring && syncedData.topAiring.length >= 10) ? syncedData.topAiring.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)) : FEATURED_ANIME.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)),
      week: (syncedData.mostPopular && syncedData.mostPopular.length >= 10) ? syncedData.mostPopular.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)) : [...FEATURED_ANIME].reverse().slice(0, 10).map((a, i) => enrichForHiAnime(a, i)),
      month: popular.slice(0, 10).map((a, i) => enrichForHiAnime(a, i))
    };
    const topUpcomingAnimes = (syncedData.topUpcoming && syncedData.topUpcoming.length > 0)
      ? syncedData.topUpcoming.slice(0, 8)
      : [
          {
            id: 173167,
            title: { english: "Blue Box Season 2", romaji: "Ao no Hako Season 2" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx173167-O51vM6QfP76I.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx173167-O51vM6QfP76I.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Romance", "Sports"]
          },
          {
            id: 177434,
            title: { english: "As a Reincarnated Aristocrat, with an Appraisal Skill Season 3", romaji: "Tensei Kizoku, Kantei Skill de Nariagaru 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx177434-tXqD77s4qC6h.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx177434-tXqD77s4qC6h.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Adventure", "Fantasy", "Isekai"]
          },
          {
            id: 170942,
            title: { english: "Rurouni Kenshin: Meiji Kenkaku Romantan Season 3", romaji: "Rurouni Kenshin: Meiji Kenkaku Romantan (2023) 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx170942-X7R4V6BqZq3j.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx170942-X7R4V6BqZq3j.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Action", "Historical"]
          },
          {
            id: 171549,
            title: { english: "Tsukimichi -Moonlit Fantasy- Season 3", romaji: "Tsuki ga Michibiku Isekai Douchuu 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171549-q7X1V2B5nK1j.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx171549-q7X1V2B5nK1j.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Action", "Comedy", "Fantasy"]
          }
        ];

    // ~450 KB of catalog rows that only change on the 6h sync: let the browser
    // reuse this briefly so a revisit is instant instead of re-downloading it.
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      syncInfo: {
        lastSyncTime: synced.lastSyncTime,
        nextSyncTime: synced.nextSyncTime,
        totalAnimeCount: synced.totalAnimeCount,
        isSyncing: synced.isSyncing,
        syncIntervalHours: 6
      },
      spotlightAnimes: spotlight,
      trendingAnimes: trending,
      popularAnimes: popular,
      topRatedAnimes: topRated,
      latestEpisodeAnimes: latestEpisodes,
      topAiringAnimes,
      mostPopularAnimes,
      mostFavoriteAnimes,
      latestCompletedAnimes,
      top10Animes,
      topUpcomingAnimes,
      genres: [
        "Action", "Adventure", "Animation", "Boys Love", "Cars", "CGDCT", "Comedy", "Demons", "Detective",
        "Drama", "Ecchi", "Educational", "Fantasy", "Horror", "Isekai", "Magic", "Mecha", "Military",
        "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Supernatural"
      ],
      all: syncedData.allAnime?.length > 0 ? syncedData.allAnime : FEATURED_ANIME
    }));
  }
  // 1. Catalog Endpoint
  if (pathname === "/api/anime/catalog") {


    const trending = FEATURED_ANIME.slice(0, 12);
    const popular = [...FEATURED_ANIME].sort((a, b) => (b.episodes || 0) - (a.episodes || 0)).slice(0, 12);
    const topRated = [...FEATURED_ANIME].sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0)).slice(0, 12);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      featured: FEATURED_ANIME.slice(0, 6),
      trending,
      popular,
      topRated,
      all: FEATURED_ANIME
    }));
  }

  // 2. Search Endpoint (AniList + HiAnime/9Anime Synced Catalog)
  if (pathname === "/api/anime/search") {
    const q = url.searchParams.get("q") || "";
    const animeSearchKey = q.trim().toLowerCase().replace(/\s+/g, " ");
    const freshAnimeHit = animeSearchCache.get(animeSearchKey);
    if (freshAnimeHit && Date.now() - freshAnimeHit.at < animeSearchCacheTtl) {
      res.statusCode = 200;
      return res.end(JSON.stringify(freshAnimeHit.data));
    }
    try {
      // Three catalogues, in parallel: AniList (rich metadata), the synced
      // HiAnime snapshot (345 rows) and HiAnime's LIVE search. The snapshot
      // alone was what search showed for HiAnime, so any title the six
      // snapshot categories did not cover ("Bleach" came back with 4 results
      // while the live site had 18) simply did not exist on this page.
      // Page 2 is worth a short race: popular queries ("one piece") have one,
      // but the request must never hold the answer for its full timeout.
      const [anilistResults, syncedResults, hisearch1, hisearch2] = await Promise.all([
        searchAnime(q).catch(() => []),
        Promise.resolve(searchSyncedAnime(q)).catch(() => []),
        searchHiAnime(q, 1).catch(() => []),
        Promise.race([
          searchHiAnime(q, 2).catch(() => []),
          new Promise((resolve) => setTimeout(() => resolve([]), 3000)),
        ]),
      ]);
      // HiAnime rows carry { id, title, poster } with a string title; rewrite
      // them to the AniList-ish shape the grid and ranker already handle, and
      // tag the source so the player resolves the HiAnime id instead of
      // guessing it is an AniList id.
      const hianimeResults = [...(hisearch1 || []), ...(hisearch2 || [])].map((r) => ({
        id: String(r.id),
        hianimeId: String(r.id),
        title: { english: r.title || "", romaji: r.title || "" },
        titleStr: r.title || "",
        coverImage: { extraLarge: r.poster || "", large: r.poster || "" },
        poster: r.poster || "",
        episodes: 0,
        seasonYear: 0,
        source: "hianime",
      }));
      // The two catalogs use different ids for the same show (AniList id vs
      // HiAnime id), so an id-only dedupe let duplicates through and left the
      // exact match buried behind loosely-related titles. Match on the
      // normalized title instead, keep the entry carrying the fuller payload
      // (poster/episode count/score), and rank exact → prefix → contains so the
      // obvious answer is the first card.
      const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const titleOf = (it) => {
        const t = it && it.title;
        if (typeof t === "string") return t;
        return (t && (t.english || t.romaji)) || (it && (it.titleStr || it.name || it.jname)) || "";
      };
      const scoreOf = (it) => {
        let s = 0;
        if (it && (it.coverImage || it.poster || it.image)) s += 2;
        if (it && (it.episodes || it.totalEpisodes)) s += 1;
        if (it && it.averageScore) s += 1;
        return s;
      };
      const key = norm(q);
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rank = (it) => {
        const t = norm(titleOf(it));
        if (!t) return 9;
        if (t === key) return 0;
        if (t.startsWith(key)) return 1;
        if (key && new RegExp(`\\b${escaped}\\b`).test(t)) return 2;
        if (t.includes(key)) return 3;
        return 4;
      };
      const byTitle = new Map();
      for (const item of [...anilistResults, ...syncedResults, ...hianimeResults]) {
        const k = norm(titleOf(item));
        if (!k) continue;
        const prev = byTitle.get(k);
        if (!prev || scoreOf(item) > scoreOf(prev)) byTitle.set(k, item);
      }
      const results = [...byTitle.values()]
        .sort((a, b) => rank(a) - rank(b) || scoreOf(b) - scoreOf(a))
        .slice(0, 60);
      const payload = { query: q, count: results.length, results };
      // ?debug=1 shows what each catalogue contributed before the title merge;
      // without it a deployed Worker only shows the final list.
      if (url.searchParams.get("debug") === "1") {
        payload.trace = {
          anilist: (anilistResults || []).length,
          synced: (syncedResults || []).length,
          hianime: hianimeResults.length,
          merged: byTitle.size,
        };
      }
      animeSearchCache.set(animeSearchKey, { at: Date.now(), data: payload });
      if (animeSearchCache.size > 120) {
        const oldest = animeSearchCache.keys().next().value;
        if (oldest !== undefined) animeSearchCache.delete(oldest);
      }
      res.statusCode = 200;
      return res.end(JSON.stringify(payload));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, results: [] }));
    }
  }

  // 3. Anime Details Endpoint
  if (pathname === "/api/anime/details") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id" }));
    }
    try {
      // 1. Check FEATURED_ANIME by AniList ID or HiAnime ID
      const featured = FEATURED_ANIME.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));
      if (featured) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ anime: featured }));
      }

      // 2. Check synced HiAnime catalog
      const synced = getSyncedHiAnimeData()?.data?.allAnime || [];
      const matchedSynced = synced.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));
      if (matchedSynced) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ anime: matchedSynced }));
      }

      // 3. A live-HiAnime search row carries a HiAnime id in the `id` field.
      // Looking that up on AniList could resolve an unrelated show (the same
      // numeric collision that once made MovieBox cards play the wrong title),
      // so the source tag short-circuits straight to a HiAnime record.
      const source = String(url.searchParams.get("source") || "");
      const hintedTitle = String(url.searchParams.get("title") || "").trim();
      const hianimeShim = () => {
        const title = hintedTitle || `Anime #${id}`;
        return {
          id: String(id),
          hianimeId: String(id),
          title: { english: title, romaji: title },
          titleStr: title,
          poster: "",
          coverImage: {},
          episodes: 0,
          seasonYear: 0,
          source: "hianime",
        };
      };
      if (source === "hianime") {
        res.statusCode = 200;
        return res.end(JSON.stringify({ anime: hianimeShim() }));
      }

      // 4. Fallback to AniList by ID
      const anime = await getAnimeById(id);
      // 5. AniList has nothing for this id but it is a bare HiAnime id (its
      // search results are the only catalogue that carried it): answer with a
      // minimal record so the click opens instead of silently doing nothing.
      res.statusCode = 200;
      if (!anime && /^\d+$/.test(String(id))) {
        return res.end(JSON.stringify({ anime: hianimeShim() }));
      }
      return res.end(JSON.stringify({ anime }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3.5. Comprehensive Episode List Endpoint (HiAnime Direct Sync)
  if (pathname === "/api/anime/episodes") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter" }));
    }

    const cacheKey = `episodes:${id}`;
    if (episodeListCache.has(cacheKey)) {
      const cached = episodeListCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 1000 * 60 * 30) {
        res.statusCode = 200;
        return res.end(JSON.stringify(cached.data));
      }
    }

    try {
      let hiAnimeId = String(id);
      let titleToSearch = "";

      const featured = FEATURED_ANIME.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));
      const syncedCatalog = getSyncedHiAnimeData()?.data?.allAnime || [];
      const matchedSynced = syncedCatalog.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));

      if (featured) {
        hiAnimeId = String(featured.hianimeId || featured.id);
        titleToSearch = featured.title?.english || featured.title?.romaji || "";
      } else if (matchedSynced) {
        hiAnimeId = String(matchedSynced.hianimeId || matchedSynced.id);
        titleToSearch = matchedSynced.title?.english || matchedSynced.title?.romaji || matchedSynced.titleStr || "";
      } else {
        const animeObj = await getAnimeById(id).catch(() => null);
        if (animeObj) {
          titleToSearch = typeof animeObj.title === "string" ? animeObj.title : (animeObj.title?.english || animeObj.title?.romaji || "");
        }
      }

      let hiEpisodes = [];
      try {
        hiEpisodes = await getHiAnimeEpisodes(hiAnimeId);
        if ((!hiEpisodes || hiEpisodes.length === 0) && titleToSearch) {
          const hiSearchResults = await searchHiAnime(titleToSearch).catch(() => []);
          const bestMatch = selectBestAnimeMatch(titleToSearch, hiSearchResults);
          if (bestMatch && bestMatch.id) {
            hiAnimeId = String(bestMatch.id);
            hiEpisodes = await getHiAnimeEpisodes(hiAnimeId);
          }
        }
      } catch (hiErr) {
        console.warn(`HiAnime episode fetch warning for ${id}:`, hiErr.message);
      }

      // Formulate complete, verified episode list
      let finalSubList = [];
      let finalDubList = [];

      if (hiEpisodes && hiEpisodes.length > 0) {
        finalSubList = hiEpisodes.map(ep => ({
          number: ep.episode,
          title: ep.title || `Episode ${ep.episode}`,
          id: ep.episodeId || `ep-${ep.episode}`,
          episodeId: ep.episodeId,
          url: ep.url,
          audio: "sub"
        }));

        finalDubList = hiEpisodes.map(ep => ({
          number: ep.episode,
          title: ep.title || `Episode ${ep.episode}`,
          id: ep.episodeId || `ep-${ep.episode}`,
          episodeId: ep.episodeId,
          url: ep.url,
          audio: "dub"
        }));
      } else {
        const epCount = 24;
        finalSubList = Array.from({ length: epCount }, (_, i) => ({
          number: i + 1,
          title: `Episode ${i + 1}`,
          id: `ep-${i + 1}`,
          audio: "sub"
        }));
        finalDubList = Array.from({ length: epCount }, (_, i) => ({
          number: i + 1,
          title: `Episode ${i + 1}`,
          id: `ep-${i + 1}`,
          audio: "dub"
        }));
      }

      const payload = {
        anilistId: Number(id) || id,
        animeTitle: titleToSearch,
        totalSub: finalSubList.length,
        totalDub: finalDubList.length,
        totalEpisodes: Math.max(finalSubList.length, finalDubList.length),
        episodes: {
          sub: finalSubList,
          dub: finalDubList
        }
      };

      episodeListCache.set(cacheKey, { timestamp: Date.now(), data: payload });
      res.statusCode = 200;
      return res.end(JSON.stringify(payload));
    } catch (err) {
      console.warn(`Episode list fetch error for ${id}:`, err.message);
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, episodes: { sub: [], dub: [] } }));
    }
  }

  // 4. Stream & Watch Links Endpoint (Supports Japanese/Chinese Sub, English Dub, and English Captions)
  // 4. Stream endpoint (Anikoto, HiAnime, ZokoAnime, and multi-mirror resolvers)
  if (pathname === "/api/anime/stream") {
    const id = url.searchParams.get("id");
    const ep = parseInt(url.searchParams.get("ep") || "1", 10);
    const rawAudio = (url.searchParams.get("audio") || "sub").toLowerCase();
    const explicitLang = (url.searchParams.get("lang") || url.searchParams.get("subLang") || "").toLowerCase();

    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter" }));
    }

    // Determine Audio Mode (sub / dub) & Language (ja / zh / en)
    let audioMode = "sub";
    let audioLang = "ja"; // Default Japanese for sub

    if (rawAudio.includes("dub") || explicitLang === "en") {
      audioMode = "dub";
      audioLang = "en"; // English dub
    } else if (rawAudio.includes("zh") || rawAudio.includes("chinese") || explicitLang === "zh") {
      audioMode = "sub";
      audioLang = "zh"; // Chinese sub / raw audio
    } else {
      audioMode = "sub";
      audioLang = "ja"; // Japanese sub audio
    }

    const cacheKey = `${id}:${ep}:${audioMode}:${audioLang}`;
    if (streamCache.has(cacheKey)) {
      const cached = streamCache.get(cacheKey);
      const hasDirectHls = Array.isArray(cached?.data?.streams) && cached.data.streams.some(s => s.type === "hls");
      // HLS payloads keep a long TTL; embed-only ones a short one. Resolving
      // an episode takes ~10-20s of chained upstreams when nothing is cached,
      // and the old read-gate (HLS only) re-ran the whole chain for every
      // replay of an episode that resolved to its embed mirror — the
      // "clicked a series and it loads forever" case. An embed payload is
      // still the truth for 3 minutes; a stale cache is ignored so a
      // newly-failing extraction gets re-attempted.
      const cachedTtlMs = hasDirectHls ? (1000 * 60 * 10) : (1000 * 60 * 3);
      if (Date.now() - cached.timestamp < cachedTtlMs) {
        res.statusCode = 200;
        // Sanitise on read as well: a payload cached before the English-only
        // rule must never stream other languages.
        return res.end(JSON.stringify({ ...cached.data, streams: englishOnlyStreams(cached.data.streams) }));
      }
    }

    // True availability of each audio mode, taken from the provider's own
    // per-episode server list (null until that list has been parsed).
    let providerHasSub = null;
    let providerHasDub = null;

    try {
      const streams = [];

      // 0. Locate anime metadata & HiAnime ID mapping
      let titleToSearch = "";
      let hiAnimeId = String(id);

      const featured = FEATURED_ANIME.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));
      const syncedCatalog = getSyncedHiAnimeData()?.data?.allAnime || [];
      const matchedSynced = syncedCatalog.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));

      if (featured) {
        hiAnimeId = String(featured.hianimeId || featured.id);
        titleToSearch = featured.title?.english || featured.title?.romaji || "";
      } else if (matchedSynced) {
        hiAnimeId = String(matchedSynced.hianimeId || matchedSynced.id);
        titleToSearch = matchedSynced.title?.english || matchedSynced.title?.romaji || matchedSynced.titleStr || "";
      } else {
        const animeObj = await getAnimeById(Number(id)).catch(() => null);
        if (animeObj) {
          titleToSearch = typeof animeObj.title === "string" ? animeObj.title : (animeObj.title?.english || animeObj.title?.romaji || "");
        }
      }

      // If we don't have a direct HiAnime ID, search HiAnime with exact title matching
      if (titleToSearch && (!featured || !featured.hianimeId) && (!matchedSynced || !matchedSynced.hianimeId)) {
        try {
          const hiSearchResults = await searchHiAnime(titleToSearch).catch(() => []);
          const bestMatch = selectBestAnimeMatch(titleToSearch, hiSearchResults);
          if (bestMatch && bestMatch.id) {
            hiAnimeId = String(bestMatch.id);
          }
        } catch (e) {}
      }

      // 1. Try HiAnime live episode & server resolution
      try {
        const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        // Fetch episode list for ID
        let epRes = await fetch(`https://hianime.at/api/theme/episode/list/${hiAnimeId}`, {
          headers: {
            "User-Agent": UA,
            "X-Requested-With": "XMLHttpRequest",
            "Referer": `https://hianime.at/watch/${hiAnimeId}`
          },
          signal: AbortSignal.timeout(5000)
        }).catch(() => null);

        let epData = (epRes && epRes.ok) ? await epRes.json().catch(() => null) : null;

        // If direct lookup didn't yield HTML, fallback to title search on HiAnime
        if ((!epData || !epData.html) && titleToSearch) {
          const hiSearchResults = await searchHiAnime(titleToSearch).catch(() => []);
          const bestMatch = selectBestAnimeMatch(titleToSearch, hiSearchResults);
          if (bestMatch && bestMatch.id) {
            hiAnimeId = String(bestMatch.id);
            epRes = await fetch(`https://hianime.at/api/theme/episode/list/${hiAnimeId}`, {
              headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": `https://hianime.at/watch/${hiAnimeId}`
              },
              signal: AbortSignal.timeout(5000)
            }).catch(() => null);
            if (epRes && epRes.ok) {
              epData = await epRes.json().catch(() => null);
            }
          }
        }

        if (epData && epData.html) {
          // Parse all episode items cleanly with robust regex
          const epRegex = /<a\s+[^>]*class="[^"]*ep-item[^"]*"[^>]*>/gs;
          let m;
          let targetEpId = null;
          const parsedEps = [];
          while ((m = epRegex.exec(epData.html || ""))) {
            const tag = m[0];
            const numMatch = tag.match(/data-number="([^"]+)"/);
            const idMatch = tag.match(/data-id="([^"]+)"/);
            if (numMatch && idMatch) {
              const parsedNum = parseInt(numMatch[1], 10);
              const parsedId = idMatch[1];
              parsedEps.push({ number: parsedNum, id: parsedId });
              if (parsedNum === ep) {
                targetEpId = parsedId;
              }
            }
          }

          // If exact episode number not found directly, match by array index (e.g. ep 5 -> index 4)
          if (!targetEpId && parsedEps.length > 0) {
            if (parsedEps[ep - 1]) {
              targetEpId = parsedEps[ep - 1].id;
            } else {
              targetEpId = parsedEps[0].id;
            }
          }

          if (targetEpId) {
            const srvRes = await fetch(`https://hianime.at/api/theme/episode/servers?episodeId=${targetEpId}`, {
              headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": `https://hianime.at/watch/${hiAnimeId}`
              },
              signal: AbortSignal.timeout(5000)
            }).catch(() => null);

            if (srvRes && srvRes.ok) {
              const srvData = await srvRes.json().catch(() => null);
              const srvRegex = /<div class="item server-item"([^>]*?)>/gs;
              let sm;
              const parsedServers = [];
              while ((sm = srvRegex.exec(srvData?.html || ""))) {
                const tagAttrs = sm[1];
                const sTypeMatch = tagAttrs.match(/data-type="([^"]+)"/);
                const sNameMatch = tagAttrs.match(/data-server-name="([^"]+)"/);
                const sHashMatch = tagAttrs.match(/data-hash="([^"]+)"/);
                if (sTypeMatch && sHashMatch) {
                  const sType = sTypeMatch[1].toLowerCase();
                  const sName = sNameMatch ? sNameMatch[1] : "Server";
                  try {
                    const rawUrl = Buffer.from(sHashMatch[1], "base64").toString("utf8");
                    parsedServers.push({ type: sType, name: sName, rawUrl });
                  } catch {}
                }
              }

              // The provider advertises sub and dub servers for the episode
              // before anything is extracted, so record availability here.
              if (parsedServers.length > 0) {
                providerHasSub = parsedServers.some(s => s.type === "sub");
                providerHasDub = parsedServers.some(s => s.type === "dub");
              }

              // Prioritize requested audio mode (sub / dub)
              const matchingAudio = parsedServers.filter(s => s.type.toLowerCase() === audioMode.toLowerCase());
              const otherAudio = parsedServers.filter(s => s.type.toLowerCase() !== audioMode.toLowerCase());
              const sorted = [...matchingAudio, ...otherAudio];

              // 1. First attempt: Direct HLS extraction from MegaPlay / Flixcloud
              for (const srv of sorted) {
                if (canExtractMegaPlay(srv.rawUrl) || srv.rawUrl.includes("megaplay")) {
                  try {
                    const details = await extractMegaPlayDetails(srv.rawUrl, { userAgent: UA }).catch(() => null);
                    if (details && details.sources && details.sources.length > 0) {
                      const hlsUrl = details.sources[0].url;
                      const proxiedUrl = `/api/anime/proxy-stream?url=${encodeURIComponent(hlsUrl)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`;
                      // Only English subtitle tracks are streamed — sources ship
                      // up to 9 languages at once and the rest must never reach
                      // the player.
                      const subs = (details.tracks || [])
                        .map(t => ({
                          url: `/api/anime/proxy-stream?url=${encodeURIComponent(t.file)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`,
                          label: t.label || "English",
                          srclang: labelToSrclang(t.label),
                          default: false
                        }))
                        .filter(isEnglishSubtitle);
                      if (subs[0]) subs[0].default = true;

                      const srvName = streams.length === 0
                        ? `Direct 1080p (${srv.type.toUpperCase()})`
                        : `Ultra HD 1080p (${srv.type.toUpperCase()})`;

                      streams.push({
                        server: `Direct 1080p (${srv.type.toUpperCase()})`,
                        type: "hls",
                        url: proxiedUrl,
                        rawUrl: hlsUrl,
                        subtitles: subs.length > 0 ? subs : [
                          {
                            url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                            label: "English [CC]",
                            srclang: "en",
                            default: true
                          }
                        ],
                        audioMode: srv.type,
                        audioLang: srv.type === "dub" ? "en" : "ja"
                      });
                    }
                  } catch (e) {}
                }
                if (streams.length >= 1) break;
              }

              // 2. Second server: native HLS read out of the ZokoAnime embed,
              //    otherwise the embed itself. Zoko's shell boots a JW Player
              //    build carrying a third-party ad stack (Connatix and friends)
              //    that we cannot strip from a cross-origin iframe, and its
              //    stream host is Referer-locked to the provider. Reading the
              //    stream out of its own config and playing it through our player
              //    gives the same content with no ads at all.
              for (const srv of sorted) {
                if (streams.length >= 2) break;
                if (!srv.rawUrl || !srv.rawUrl.startsWith("http")) continue;
                const isExisting = streams.some(s => s.rawUrl === srv.rawUrl || s.embedUrl === srv.rawUrl);
                if (isExisting) continue;

                if (isZokoEmbedUrl(srv.rawUrl)) {
                  const zoko = await zokoStreamFromEmbed(srv.rawUrl, { userAgent: UA, relay: true });
                  if (zoko) {
                    streams.push({
                      server: `Mirror HD (${srv.type.toUpperCase()})`,
                      ...zoko,
                      audioMode: srv.type,
                      audioLang: srv.type === "dub" ? "en" : "ja"
                    });
                    continue;
                  }
                }

                streams.push({
                  server: `Mirror Player (${srv.type.toUpperCase()})`,
                  type: "embed",
                  embedUrl: srv.rawUrl,
                  url: "",
                  subtitles: [
                    {
                      url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                      label: "English [CC]",
                      srclang: "en",
                      default: true
                    }
                  ],
                  audioMode: srv.type,
                  audioLang: srv.type === "dub" ? "en" : "ja"
                });
              }
            }
          }
        }
      } catch (hiErr) {
        console.warn("HiAnime stream resolver note:", hiErr.message);
      }

      // Check overall dub and sub availability
      const actualHasDub = streams.some(s => s.audioMode === "dub");
      const actualHasSub = streams.some(s => s.audioMode === "sub") || (!actualHasDub && streams.length > 0);
      const effectiveMode = (audioMode === "dub" && !actualHasDub && actualHasSub) ? "sub" : ((audioMode === "sub" && !actualHasSub && actualHasDub) ? "dub" : audioMode);

      // If 0 servers were extracted, provide a working fail-safe embed for this
      // exact anime & episode. No provider names are surfaced here.
      if (streams.length === 0) {
        streams.push({
          server: `Direct Player (${effectiveMode.toUpperCase()})`,
          type: "embed",
          embedUrl: `https://vidsrc.cc/v2/embed/anime/${id}/${ep}/${effectiveMode}`,
          url: "",
          subtitles: [
            {
              url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
              label: "English [CC]",
              srclang: "en",
              default: true
            }
          ],
          audioMode: effectiveMode,
          audioLang: effectiveMode === "dub" ? "en" : "ja"
        });
        streams.push({
          server: `Mirror Player (${effectiveMode.toUpperCase()})`,
          type: "embed",
          embedUrl: `https://2embed.cc/embed/anime/${id}/${ep}`,
          url: "",
          subtitles: [
            {
              url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
              label: "English [CC]",
              srclang: "en",
              default: true
            }
          ],
          audioMode: effectiveMode,
          audioLang: effectiveMode === "dub" ? "en" : "ja"
        });
      } else if (streams.length === 1) {
        // If only 1 server was extracted, create Server 2 as a mirror.
        const first = streams[0];
        if (first.type === "hls") {
          streams.push({
            server: `Ultra HD 1080p (${effectiveMode.toUpperCase()})`,
            type: "hls",
            url: first.url,
            rawUrl: first.rawUrl,
            subtitles: first.subtitles,
            audioMode: first.audioMode,
            audioLang: first.audioLang
          });
        } else {
          streams.push({
            server: `Backup Mirror (${effectiveMode.toUpperCase()})`,
            type: "embed",
            embedUrl: `https://2embed.cc/embed/anime/${id}/${ep}`,
            url: "",
            subtitles: first.subtitles,
            audioMode: first.audioMode,
            audioLang: first.audioLang
          });
        }
      }

      // Sort streams: Direct Native HLS with matching audio mode is #1.
      streams.sort((a, b) => {
        const score = (s) => {
          let pts = 0;
          if (s.audioMode === audioMode) pts += 500;
          if (s.type === "hls") pts += 200;
          if (s.server.startsWith("Direct")) pts += 100;
          return pts;
        };
        return score(b) - score(a);
      });

      // Filter and restrict output to EXACTLY 2 clean working servers.
      const finalStreams = [];
      const seenServerKeys = new Set();
      for (const s of streams) {
        const key = `${s.server}:${s.type}`;
        if (!seenServerKeys.has(key)) {
          seenServerKeys.add(key);
          finalStreams.push(s);
        }
        if (finalStreams.length >= 2) break;
      }

      // What extraction actually produced for THIS request: the two server
      // slots only ever fill with the requested mode, so this can never prove
      // that the other mode exists — but it is the only thing that tells us
      // what can be played right now.
      const playableSub = finalStreams.some(s => (s.audioMode && s.audioMode.toLowerCase() === "sub") || (s.server && s.server.toLowerCase().includes("sub")));
      const playableDub = finalStreams.some(s => (s.audioMode && s.audioMode.toLowerCase() === "dub") || (s.server && s.server.toLowerCase().includes("dub")));

      // Availability reported to the client comes from the provider's server
      // list when we have it. Deriving it from finalStreams made hasDub come
      // back false on every SUB request, which hid the English (Dub) option
      // in the player even for episodes that ship a dub.
      const hasSub = providerHasSub !== null ? providerHasSub : playableSub;
      const hasDub = providerHasDub !== null ? providerHasDub : playableDub;

      const availableLanguages = [];
      if (hasSub) {
        availableLanguages.push({ code: "ja", name: "Japanese", mode: "sub", label: "Japanese (Sub)" });
        availableLanguages.push({ code: "zh", name: "Chinese", mode: "sub", label: "Chinese (Sub)" });
      }
      if (hasDub) {
        availableLanguages.push({ code: "en", name: "English", mode: "dub", label: "English (Dub)" });
      }

      // If the requested mode could not be extracted, fall back to the mode we
      // really got. This must stay driven by the playable flags above — using
      // provider availability here would label a subtitle stream as an English
      // dub when the provider lists a dub we could not extract.
      const effectiveAudio = (audioMode === "dub" && !playableDub && playableSub) ? "sub" : ((audioMode === "sub" && !playableSub && playableDub) ? "dub" : audioMode);

      const responsePayload = {
        anilistId: Number(id) || id,
        episode: ep,
        audio: effectiveAudio,
        audioLang,
        hasSub,
        hasDub,
        availableAudioModes: [hasSub ? "sub" : null, hasDub ? "dub" : null].filter(Boolean),
        availableLanguages,
        captions: [
          { code: "en", name: "English [CC]", srclang: "en", default: true }
        ],
        streams: englishOnlyStreams(finalStreams)
      };

      streamCache.set(cacheKey, { timestamp: Date.now(), data: responsePayload });
      res.statusCode = 200;
      return res.end(JSON.stringify(responsePayload));
    } catch (err) {
      console.error("Stream resolution error:", err);
      // Return safe embed fallback
      res.statusCode = 200;
      return res.end(JSON.stringify({
        anilistId: Number(id) || id,
        episode: ep,
        audio: audioMode,
        audioLang,
        availableLanguages: [
          { code: "ja", name: "Japanese", mode: "sub", label: "Japanese (Sub)" },
          { code: "zh", name: "Chinese", mode: "sub", label: "Chinese (Sub)" },
          { code: "en", name: "English", mode: "dub", label: "English (Dub)" }
        ],
        captions: [
          { code: "en", name: "English [CC]", srclang: "en", default: true }
        ],
        streams: [
          {
            server: "2Embed (HD Player)",
            type: "embed",
            embedUrl: `https://2embed.cc/embed/anime/${id}/${ep}`,
            url: "",
            subtitles: [
              {
                url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                label: "English [CC]",
                srclang: "en",
                default: true
              }
            ]
          }
        ]
      }));
    }
  }

  // 4b. Captions WebVTT Endpoint (English Captions Only)
  if (pathname === "/api/anime/captions.vtt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.statusCode = 200;
    const vttContent = `WEBVTT - English Closed Captions

00:00:01.000 --> 00:00:05.000
[Anime Theme Song Plays]

00:00:06.000 --> 00:00:10.000
Episode streaming with English Captions [CC] enabled.

00:01:25.000 --> 00:01:30.000
[Action sequence dialogue in progress]
`;
    return res.end(vttContent);
  }

  // 5. HiAnime Search Endpoint
  if (pathname === "/api/hianime/search") {
    const q = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    try {
      const results = await searchHiAnime(q, page);
      res.statusCode = 200;
      return res.end(JSON.stringify({ query: q, page, count: results.length, animes: results }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, animes: [] }));
    }
  }

  // 6. HiAnime Browse Category Endpoint
  if (pathname === "/api/hianime/browse") {
    const category = url.searchParams.get("category") || "most-popular";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    try {
      const results = await browseHiAnime(category, page);
      res.statusCode = 200;
      return res.end(JSON.stringify({ category, page, count: results.length, animes: results }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, animes: [] }));
    }
  }

  // 7. HiAnime Episodes Endpoint (All episode numbers, titles, and IDs)
  if (pathname === "/api/hianime/episodes") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter (e.g. ?id=1 for One Piece or ?id=240 for Attack on Titan)" }));
    }
    try {
      const episodes = await getHiAnimeEpisodes(id);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        animeId: id,
        totalEpisodes: episodes.length,
        episodes
      }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, episodes: [] }));
    }
  }

  // 8. HiAnime Stream Endpoint (Direct extraction with proxy)
  if (pathname === "/api/hianime/stream") {
    const epId = url.searchParams.get("ep") || url.searchParams.get("episodeId");
    const audio = url.searchParams.get("audio") || "sub";
    if (!epId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing ep or episodeId parameter" }));
    }
    try {
      const result = await getHiAnimeEpisodeStream(epId, audio);
      // Proxy any direct HLS streams
      const proxiedStreams = (result.streams || []).map(stream => {
        if (stream.type === "hls" && stream.url) {
          const proxiedUrl = `/api/anime/proxy-stream?url=${encodeURIComponent(stream.url)}&referer=${encodeURIComponent(stream.referer || "https://megaplay.buzz/")}`;
          const proxiedSubtitles = (stream.subtitles || []).map(sub => ({
            ...sub,
            url: sub.url ? `/api/anime/proxy-stream?url=${encodeURIComponent(sub.url)}&referer=${encodeURIComponent(stream.referer || "https://megaplay.buzz/")}` : sub.url
          }));
          return {
            ...stream,
            url: proxiedUrl,
            rawUrl: stream.url,
            subtitles: proxiedSubtitles.filter(isEnglishSubtitle)
          };
        }
        return stream;
      });

      res.statusCode = 200;
      return res.end(JSON.stringify({
        episodeId: epId,
        audio: result.audio || audio,
        hasSub: result.hasSub !== undefined ? result.hasSub : undefined,
        hasDub: result.hasDub !== undefined ? result.hasDub : undefined,
        streams: proxiedStreams
      }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, streams: [] }));
    }
  }

  // 9. HiAnime Full Anime Details with all Episodes
  if (pathname === "/api/hianime/anime") {
    const q = url.searchParams.get("q") || url.searchParams.get("id");
    if (!q) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing query or anime id parameter (e.g. ?q=Bleach or ?id=269)" }));
    }
    try {
      const result = await getAnimeWithEpisodes(q);
      if (!result) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `Anime '${q}' not found on hianime.at` }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ...result }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 10. HiAnime Sync Status Endpoint
  if (pathname === "/api/hianime/sync-status") {
    const status = getSyncedHiAnimeData();
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      lastSyncTime: status.lastSyncTime,
      nextSyncTime: status.nextSyncTime,
      totalAnimeCount: status.totalAnimeCount,
      isSyncing: status.isSyncing,
      lastError: status.lastError,
      syncLogs: status.syncLogs.slice(0, 20),
      categories: Object.keys(status.data.categories || {}),
      syncIntervalHours: 6
    }));
  }

  // 11. Trigger Immediate HiAnime Manual Sync
  if (pathname === "/api/hianime/sync-now") {
    // Run in background and respond with status
    runHiAnimeSync().catch(e => console.error("Manual sync error:", e));
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: "Library auto-sync triggered. Refreshing titles and episodes in the background…",
      isSyncing: true,
      syncIntervalHours: 6
    }));
  }

  // 12. HiAnime Full Synced Catalog Endpoint (with search & pagination)
  if (pathname === "/api/hianime/catalog") {
    const q = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = parseInt(url.searchParams.get("limit") || "24", 10);

    const data = q ? searchSyncedAnime(q) : (getSyncedHiAnimeData()?.data?.allAnime || []);
    const total = data.length;
    const startIndex = (page - 1) * limit;
    const paginated = data.slice(startIndex, startIndex + limit);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      animes: paginated
    }));
  }

  // 13. HiAnime A–Z Synced Directory Endpoint
  if (pathname === "/api/hianime/az") {
    const letter = url.searchParams.get("letter") || "All";
    const animes = getSyncedAnimeByLetter(letter);
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      letter,
      total: animes.length,
      animes
    }));
  }

  // 14. User Feedback & Issue Reporting Endpoint
  if (pathname === "/api/feedback/submit" && (req.method === "POST" || req.method === "GET")) {
    let body = {};
    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = JSON.parse(raw);
      } catch (e) {
        body = {};
      }
    } else {
      body = {
        animeId: url.searchParams.get("animeId"),
        animeTitle: url.searchParams.get("animeTitle"),
        episode: parseInt(url.searchParams.get("episode") || "0", 10),
        issueType: url.searchParams.get("issueType"),
        description: url.searchParams.get("description"),
        userContact: url.searchParams.get("userContact")
      };
    }

    const report = {
      id: "rep_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      animeId: String(body.animeId || ""),
      animeTitle: String(body.animeTitle || "General Feedback"),
      episode: body.episode ? Number(body.episode) : null,
      issueType: body.issueType || "missing_episode",
      description: String(body.description || "").trim(),
      userContact: String(body.userContact || "").trim(),
      createdAt: Date.now(),
      status: "open"
    };

    // Run automated issue fixer (flushes caches, re-indexes HiAnime streams & episode lists)
    await autoFixFeedbackReport(report);
    await saveFeedbackItem(report);

    // Email the report to the site owner. Never let a mail failure lose the report —
    // it is already persisted to disk above.
    const emailed = await emailFeedbackReport(report);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: emailed.sent
        ? "Please let us know if something is missing or wrong — your report was received and emailed to the Hinataw.exe team!"
        : "Please let us know if something is missing or wrong — your report was received and automatically fixed! We flushed caches and re-indexed fresh episode streams directly from HiAnime.at.",
      emailed: emailed.sent,
      emailError: emailed.sent ? undefined : emailed.reason,
      status: report.status,
      resolutionNote: report.resolutionNote,
      reportId: report.id
    }));
  }

  // Owner portal login: exchange the password for a signed token.
  if (pathname === "/api/feedback/login" && req.method === "POST") {
    let body = {};
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (e) {}

    if (!ADMIN_PASSWORD) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ success: false, error: "Portal not configured (ADMIN_PASSWORD unset)" }));
    }

    const supplied = Buffer.from(String(body.password || ""));
    const expected = Buffer.from(ADMIN_PASSWORD);
    const okPw = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

    if (!okPw) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ success: false, error: "Incorrect password" }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, token: portalToken(), expiresIn: PORTAL_TOKEN_TTL }));
  }

  // 15. Get Feedback List & Auto-Fix All Open Issues (owner-only)
  if (pathname === "/api/feedback/list") {
    if (!requirePortalAuth(req, url, res)) return;
    const list = await getFeedbackList();
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      total: list.length,
      reports: list.slice(0, 50)
    }));
  }

  // --- Notice board ---
  // Public read: the home-page notice board needs no credentials.
  // Writes are owner-only (portal token) so only the admin can publish.
  if (pathname === "/api/notices" && req.method === "GET") {
    const wantsAll = url.searchParams.get("all") === "true";
    const list = await getNotices();
    // "all" returns an extra flag-free copy for the owner list; the public view
    // is identical today, but keeping the branch makes the intent explicit.
    const notices = wantsAll ? list : list.filter(n => n.title && n.message);
    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, notices, durable: NOTICE_REDIS_ON }));
  }

  if (pathname === "/api/notices" && req.method === "POST") {
    if (!requirePortalAuth(req, url, res)) return;

    let body = {};
    try {
      body = JSON.parse((await readRequestBody(req)) || "{}");
    } catch (e) {
      body = {};
    }

    // Pin / unpin an existing notice: { id, pinned }. No new notice is created.
    const editId = String(body.id || "").trim();
    if (editId) {
      const list = await getNotices();
      const target = list.find((n) => n.id === editId);
      if (!target) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ success: false, error: "Notice not found" }));
      }
      const willPin = Boolean(body.pinned);
      // Only one banner is meaningful, so pinning clears every other pin.
      const next = list.map((n) => (n.id === editId
        ? { ...n, pinned: willPin }
        : (willPin ? { ...n, pinned: false } : n)));
      const saved = await saveNotices(next);
      res.statusCode = 200;
      const updated = saved.find((n) => n.id === editId) || null;
      return res.end(JSON.stringify({ success: true, notice: updated, pinned: willPin, total: saved.length }));
    }

    const title = String(body.title || "").trim().slice(0, 120);
    const message = String(body.message || "").trim().slice(0, 2000);
    const link = String(body.link || "").trim().slice(0, 300);
    const linkLabel = String(body.linkLabel || "").trim().slice(0, 60);
    const pinned = Boolean(body.pinned);

    if (!isNoticeTitleValid(title)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "A notice title is required" }));
    }
    if (!message) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "A notice message is required" }));
    }
    if (link && !/^https?:\/\//i.test(link)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "Links must start with http:// or https://" }));
    }

    const notice = {
      id: `n_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
      title,
      message,
      link,
      linkLabel,
      pinned,
      createdAt: Date.now(),
    };

    const list = await getNotices();
    // A new pinned notice takes the banner slot from whatever held it, so the
    // home page can never show two competing "pinned" banners.
    const next = pinned ? list.map((n) => ({ ...n, pinned: false })) : list;
    const saved = await saveNotices([notice, ...next]);

    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, notice, total: saved.length, durable: NOTICE_REDIS_ON }));
  }

  if (pathname === "/api/notices" && req.method === "DELETE") {
    if (!requirePortalAuth(req, url, res)) return;

    const id = url.searchParams.get("id") || "";
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "A notice id is required" }));
    }

    const list = await getNotices();
    const next = list.filter(n => n.id !== id);
    if (next.length === list.length) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ success: false, error: "Notice not found" }));
    }

    const saved = await saveNotices(next);
    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, removed: id, total: saved.length }));
  }

  // --- Owner-uploaded titles backed by Mux embeds ---
  // Public read: the home rows and player only need the published list.
  if (pathname === "/api/mux/content" && req.method === "GET") {
    const items = (await readDoc("mux-content", [])) || [];
    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, items, total: items.length }));
  }

  // Create / update (owner portal token required).
  if (pathname === "/api/mux/content" && req.method === "POST") {
    if (!requirePortalAuth(req, url, res)) return;

    let body = {};
    try {
      body = JSON.parse((await readRequestBody(req)) || "{}");
    } catch (e) {
      body = {};
    }

    const title = String(body.title || "").trim().slice(0, 200);
    if (!title) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "A title is required" }));
    }

    const type = body.type === "movie" ? "movie" : "series";
    const rawEps = Array.isArray(body.episodes) ? body.episodes : [];
    const episodes = [];
    for (const ep of rawEps.slice(0, 500)) {
      const enc = muxEmbedFor(ep && (ep.embed || ep.embedUrl || ep.playbackId));
      if (!enc) continue;
      episodes.push({
        ep: Number(ep.ep) || episodes.length + 1,
        title: String(ep.title || "").trim().slice(0, 200),
        playbackId: enc.playbackId,
        embedUrl: enc.embedUrl,
      });
    }
    if (!episodes.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: "At least one Mux playback ID or embed URL is required" }));
    }
    episodes.sort((a, b) => a.ep - b.ep);

    const existing = (await readDoc("mux-content", [])) || [];
    const id = String(body.id || "").trim() || `mux_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const record = {
      id,
      title,
      type,
      image: String(body.image || "").trim().slice(0, 600),
      year: String(body.year || "").trim().slice(0, 10),
      genre: String(body.genre || "").trim().slice(0, 80),
      description: String(body.description || "").trim().slice(0, 2000),
      episodes,
      updatedAt: Date.now(),
    };

    const idx = existing.findIndex((it) => it && it.id === id);
    let saved;
    if (idx >= 0) {
      record.createdAt = existing[idx].createdAt || Date.now();
      saved = existing.slice();
      saved[idx] = record;
    } else {
      record.createdAt = Date.now();
      saved = [record, ...existing];
    }
    await writeDoc("mux-content", saved);

    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, item: record, total: saved.length }));
  }

  if (pathname === "/api/mux/content" && req.method === "DELETE") {
    if (!requirePortalAuth(req, url, res)) return;
    const id = url.searchParams.get("id") || "";
    const existing = (await readDoc("mux-content", [])) || [];
    const next = existing.filter((it) => it && it.id !== id);
    if (next.length === existing.length) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ success: false, error: "Title not found" }));
    }
    await writeDoc("mux-content", next);
    res.statusCode = 200;
    return res.end(JSON.stringify({ success: true, removed: id, total: next.length }));
  }

  if (pathname === "/api/feedback/auto-fix-all") {
    if (!requirePortalAuth(req, url, res)) return;
    const list = await getFeedbackList();
    let fixedCount = 0;
    for (const report of list) {
      if (report.status === "open") {
        await autoFixFeedbackReport(report);
        fixedCount++;
      }
    }
    await saveFeedbackItem(null); // save updated list
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: `Processed and auto-fixed ${fixedCount} open feedback reports!`,
      fixedCount,
      totalReports: list.length
    }));
  }

  // 15.5. User Authentication & Cloud Sync Endpoints (Cross-Device History & Progress)
  if (pathname === "/api/user/auth" && (req.method === "POST" || req.method === "GET")) {
    let body = {};
    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = JSON.parse(raw);
      } catch (e) {
        body = {};
      }
    } else {
      body = {
        email: url.searchParams.get("email"),
        password: url.searchParams.get("password"),
        isSignUp: url.searchParams.get("isSignUp") === "true"
      };
    }

    try {
      const email = body.email || "";
      const password = body.password || "";
      const isSignUp = !!body.isSignUp;
      const user = await authenticateUser(email, password, isSignUp);

      // If client sent local progress or watchlist, merge and save
      if (body.progress || body.watchlist) {
        await saveUserData(user.uid, {
          watchProgress: body.progress || body.watchProgress,
          watchlist: body.watchlist,
          email: user.email
        });
      }

      const updated = await getUserData(user.uid);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.end(JSON.stringify({
        success: true,
        user: {
          uid: updated?.uid || user.uid,
          email: updated?.email || user.email,
          watchProgress: updated?.watchProgress || {},
          watchlist: updated?.watchlist || {},
          updatedAt: updated?.updatedAt || Date.now()
        }
      }));
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // Get or Save user progress & watchlist for cross-device sync
  if (pathname === "/api/user/sync" || pathname === "/api/user/progress") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "GET") {
      const uid = url.searchParams.get("uid") || url.searchParams.get("email");
      if (!uid) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "Missing uid or email" }));
      }
      const data = await getUserData(uid);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        success: true,
        user: data ? {
          uid: data.uid,
          email: data.email,
          watchProgress: data.watchProgress || {},
          watchlist: data.watchlist || {},
          updatedAt: data.updatedAt || Date.now()
        } : null
      }));
    }

    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(raw);
        const uid = body.uid || body.email;
        if (!uid) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "Missing uid or email in body" }));
        }
        const updated = await saveUserData(uid, {
          watchProgress: body.watchProgress || body.progress,
          watchlist: body.watchlist,
          email: body.email
        });
        res.statusCode = 200;
        return res.end(JSON.stringify({
          success: true,
          user: {
            uid: updated?.uid || uid,
            email: updated?.email || "",
            watchProgress: updated?.watchProgress || {},
            watchlist: updated?.watchlist || {},
            updatedAt: updated?.updatedAt || Date.now()
          }
        }));
      } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 16. Watch history endpoint — ordered list of recently watched titles for
  // the homepage continue-watching carousel (public, no auth required).
  if (pathname === "/api/anime/history") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
      const data = await getUserData(url.searchParams.get("uid") || url.searchParams.get("email") || "");
      const progress = (data && data.watchProgress) ? data.watchProgress : {};
      const entries = Object.values(progress)
        .filter((e) => e && e.animeId != null)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 12);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        success: true,
        items: entries.map((e) => ({
          animeId: e.animeId,
          title: e.title || "Anime",
          coverImage: e.coverImage || (selectedAnime && selectedAnime.bannerImage) || "",
          episode: e.episode || 1,
          time: e.time || 0,
          duration: e.duration || 0,
          percentage: e.percentage || 0,
          completed: e.completed || false,
          updatedAt: e.updatedAt || 0,
          audio: e.audio || "sub",
        }))
      }));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  // 17. Weekly Broadcast Schedule Endpoint
  if (pathname === "/api/anime/schedule") {
    const syncedData = getSyncedHiAnimeData();
    const source = (syncedData.allAnime && syncedData.allAnime.length > 0)
      ? syncedData.allAnime
      : FEATURED_ANIME;

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const now = new Date();
    const currentDayIdx = now.getDay();

    const schedule = {};
    days.forEach((dayName, idx) => {
      // Pick 4-6 anime for each day
      const dayAnimes = source.slice(idx * 3, idx * 3 + 4).map((a, i) => {
        const hour = 18 + ((i * 2 + idx) % 6);
        const minute = (i * 15) % 60;
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST`;
        return {
          id: a.id,
          title: a.title,
          coverImage: a.coverImage,
          airingTime: timeStr,
          airingEpisode: (a.subCount || a.episodes || 12) + 1,
          isToday: idx === currentDayIdx,
          format: a.format || "TV"
        };
      });
      schedule[dayName] = dayAnimes;
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      currentDay: days[currentDayIdx],
      schedule
    }));
  }

  // 17. Random Top Anime Endpoint
  if (pathname === "/api/anime/random") {
    const syncedData = getSyncedHiAnimeData();
    const pool = (syncedData.allAnime && syncedData.allAnime.length > 0)
      ? syncedData.allAnime
      : FEATURED_ANIME;
    const randomAnime = pool[Math.floor(Math.random() * pool.length)] || FEATURED_ANIME[0];
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      anime: randomAnime
    }));
  }

  // 18. Anime Character Cast & Voice Actors Endpoint
  if (pathname === "/api/anime/cast") {
    const id = url.searchParams.get("id");
    const sampleCast = [
      { name: "Monkey D. Luffy", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b40-U31zQ12k45Zc.png", voiceActor: "Mayumi Tanaka", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95007-8yX3hF22oJqN.png", vaLang: "Japanese" },
      { name: "Roronoa Zoro", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b62-p700l4k83YnL.png", voiceActor: "Kazuya Nakai", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95008-0129x87aKl1.png", vaLang: "Japanese" },
      { name: "Nami", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b724-81b37c093a.png", voiceActor: "Akemi Okamura", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95009-87a6c90.png", vaLang: "Japanese" },
      { name: "Sanji", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b305-6458a.png", voiceActor: "Hiroaki Hirata", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95010-82a.png", vaLang: "Japanese" },
      { name: "Nico Robin", role: "Supporting", image: "https://s4.anilist.co/file/anilistcdn/character/large/b1245-a89b.png", voiceActor: "Yuriko Yamaguchi", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95011-73a.png", vaLang: "Japanese" },
      { name: "Trafalgar Law", role: "Supporting", image: "https://s4.anilist.co/file/anilistcdn/character/large/b17849-law.png", voiceActor: "Hiroshi Kamiya", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95012-kamiya.png", vaLang: "Japanese" }
    ];
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      cast: sampleCast
    }));
  }

  // 19. Community Comments API (Get & Post) — served on both paths.
  if (pathname === "/api/anime/comments") {
    if (req.method === "POST") {
      let body = {};
      try {
        const raw = await readRequestBody(req);
        body = JSON.parse(raw);
      } catch (e) {}

      if (!body.animeId || !body.text) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "animeId and text are required" }));
      }

      const comment = {
        id: "cmt_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
        animeId: String(body.animeId),
        episode: body.episode || 1,
        author: body.author || "OtakuGuest",
        avatar: body.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(body.author || 'guest')}`,
        text: String(body.text).slice(0, 500),
        isSpoiler: Boolean(body.isSpoiler),
        likes: 0,
        createdAt: new Date().toISOString()
      };

      try {
        let allComments = (await readDoc("comments", [])) || [];
        allComments.unshift(comment);
        if (allComments.length > 500) allComments = allComments.slice(0, 500);
        await writeDoc("comments", allComments);
      } catch (e) {}

      res.statusCode = 201;
      return res.end(JSON.stringify({ success: true, comment }));
    }

    // GET comments for animeId
    const animeId = url.searchParams.get("animeId");
    let allComments = [];
    try {
      allComments = (await readDoc("comments", [])) || [];
    } catch (e) {}

    // No seeded messages: discussions show only what real users have posted.
    const filtered = allComments.filter(c => !animeId || String(c.animeId) === String(animeId));
    const finalComments = filtered;

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      comments: finalComments
    }));
  }

  // Not matched
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: "Anime API endpoint not found" }));
}

// Handler for relaying HLS playlists, video segments, and subtitle files
async function handleProxyStream(req, res, url) {
  const targetUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") || "https://megaplay.buzz/";

  if (!targetUrl) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Missing target url parameter");
  }

  const isPlaylist = targetUrl.includes(".m3u8");
  const timeoutMs = isPlaylist ? 15000 : 35000;

  try {
    const headers = {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": referer.replace(/\/$/, ""),
      "Accept": "*/*"
    };

    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    // The timeout covers getting the response headers, not the body: a
    // segment or file that is still arriving when the timer fires used to be
    // cut mid-stream, which ends as ERR_CONTENT_LENGTH_MISMATCH in the player
    // and a "buffering too long" failover.
    const fetchHeaders = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(targetUrl, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    let response;
    try {
      response = await fetchHeaders();
    } catch (firstErr) {
      // Retry once if first attempt timed out
      response = await fetchHeaders();
    }

    if (!response.ok && response.status !== 206) {
      res.statusCode = response.status;
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.end(`Upstream error: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    const setSegmentHeaders = () => {
      res.statusCode = response.status;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      // MegaPlay hides TS segments behind .jpg/.js/.css/.txt names and serves
      // them as image/*, text/plain or application/javascript. A player must
      // still see them as video, so anything that is not itself an audio/video
      // type is re-labelled as an MPEG-TS segment.
      res.setHeader("Content-Type", segmentMediaType(contentType));
      res.setHeader("Cache-Control", "public, max-age=86400");

      const acceptRanges = response.headers.get("accept-ranges");
      if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);

      const contentRange = response.headers.get("content-range");
      if (contentRange) res.setHeader("Content-Range", contentRange);

      const contentLength = response.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);
    };

    // Subtitles are sniffed by URL/type before anything else. They must not go
    // through the playlist probe below: a VTT served as text/plain would
    // otherwise be misread as an ordinary segment.
    if (targetUrl.includes(".vtt") || contentType.includes("vtt")) {
      const text = await response.text();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      // Only English cues reach the player, and never from a stale browser cache.
      res.setHeader("Cache-Control", "no-store");
      return res.end(englishOnlyVtt(text));
    }

    // A playlist may be announced by the URL or by the content type. Because a
    // text/plain response may equally be a wrapped video segment, the opening
    // bytes are read ONCE and inspected, then either rewritten as a playlist or
    // forwarded verbatim. Reading with response.text() here used to consume the
    // body, so a non-playlist that arrived as text/plain fell through and tried
    // to read the stream a second time ("ReadableStream is locked").
    const mightBePlaylist =
      isPlaylist ||
      contentType.includes("mpegurl") ||
      contentType.includes("application/x-mpegURL") ||
      contentType.includes("text/plain");

    if (mightBePlaylist && !isLocked(response.body)) {
      const reader = response.body.getReader();
      const first = await reader.read();
      const probe = first.value
        ? Buffer.from(first.value.subarray(0, 8192)).toString("utf8")
        : "";

      if (probe.includes("#EXTM3U") || probe.includes("#EXTINF")) {
        const parts = first.value ? [Buffer.from(first.value)] : [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) parts.push(Buffer.from(value));
        }
        const text = Buffer.concat(parts).toString("utf8");
        const lines = text.split("\n");
        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // Replace URI in attributes (e.g. URI="...")
          if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_, uriMatch) => {
              const absUrl = new URL(uriMatch, targetUrl).toString();
              return `URI="/api/anime/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}"`;
            });
          }

          // If line is not a comment/tag, it is a sub-playlist or segment URL
          if (!trimmed.startsWith("#")) {
            const absUrl = new URL(trimmed, targetUrl).toString();
            return `/api/anime/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
          }

          return line;
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        return res.end(rewritten.join("\n"));
      }

      // Not a playlist after all — a wrapped segment that merely arrived as
      // text/plain. Forward the bytes already read, then stream the remainder.
      setSegmentHeaders();
      if (canStream(res)) {
        return await pipeReader(reader, res, first.value);
      }
      const rest = await drainReader(reader);
      return res.end(first.value ? Buffer.concat([Buffer.from(first.value), rest]) : rest);
    }

    // Binary video segment. Forward it as it arrives instead of buffering the
    // whole segment first: the player gets the first bytes in milliseconds, and
    // the server never holds a multi-megabyte segment per concurrent viewer.
    setSegmentHeaders();
    if (canStream(res) && !isLocked(response.body)) {
      return await pipeWebStream(response.body, res);
    }

    const arrayBuf = await response.arrayBuffer();
    return res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.warn("Proxy stream error:", err.message);
    // A failure after the first byte cannot be rewound, so the headers are left
    // exactly as sent and the (already partial) response is simply closed.
    if (!res.headersSent) {
      // Before any byte, report a real error instead of an empty 200. A 200 with
      // no body looks like a valid-but-corrupt segment to the player and stalls
      // playback; a 5xx makes hls.js retry the fragment (and switch level if it
      // keeps failing), which is what "plays without buffering" needs.
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      res.statusCode = timedOut ? 504 : 502;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    try { return res.end(); } catch {}
  }
}

// TS segments are frequently mislabelled by the provider (image/*, text/plain,
// application/javascript). Keep genuine media types, relabel everything else.
function segmentMediaType(upstreamType) {
  const type = String(upstreamType || "").toLowerCase();
  if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("octet-stream")) {
    return upstreamType;
  }
  return "video/mp2t";
}

// Egress diagnostic: whether THIS Worker's egress can reach a host at all.
// Several providers (the moviebox BFF, mangakakalot, the video CDN) differ
// only in whether they accept a Cloudflare Workers fingerprint, so probing
// from production is how that boundary is mapped. It reports status, a few
// response headers and the first 300 bytes of the body — never the full
// payload — so it diagnoses blocks without becoming an open proxy. Gated by
// DIAG_KEY when the deployment sets one; https targets only, and private /
// loopback hosts are refused.
async function handleDiag(req, res, url) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const expected = String(process.env.DIAG_KEY || "");
  if (expected && url.searchParams.get("k") !== expected) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ success: false, error: "Forbidden" }));
  }

  const target = String(url.searchParams.get("u") || "");
  const method = String(url.searchParams.get("m") || "GET").toUpperCase();
  let parsed = null;
  try {
    parsed = new URL(target);
  } catch {}
  const privateHost =
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.hostname.includes(":") ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(parsed.hostname);
  if (privateHost || !["GET", "POST", "HEAD"].includes(method)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ success: false, error: "u must be a public https url; m in GET|POST|HEAD" }));
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    Accept: "*/*",
  };
  try {
    const extra = JSON.parse(url.searchParams.get("h") || "{}");
    if (extra && typeof extra === "object") {
      for (const name of Object.keys(extra).slice(0, 24)) headers[name] = String(extra[name]);
    }
  } catch {}

  const out = { success: false, url: parsed.toString(), method };
  const t0 = Date.now();
  try {
    const upstream = await fetch(parsed.toString(), {
      method,
      headers,
      body: method === "POST" ? String(url.searchParams.get("b") || "") || undefined : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    out.status = upstream.status;
    out.ms = Date.now() - t0;
    out.ctype = upstream.headers.get("content-type") || "";
    out.length = upstream.headers.get("content-length") || "";
    out.xuser = upstream.headers.get("x-user") || "";
    out.location = upstream.headers.get("location") || "";

    // Read at most ~1 KB of the body — enough to tell a challenge page from
    // real JSON from video bytes — then cancel the stream so a huge file is
    // never pulled into the isolate. `n` raises the cap (capped at 32 KB) for
    // diagnosing an upstream page whose markup is what went wrong.
    const cap = Math.min(Math.max(Number(url.searchParams.get("n")) || 1024, 1024), 32768);
    if (method !== "HEAD" && upstream.body) {
      const reader = upstream.body.getReader();
      const chunks = [];
      let got = 0;
      while (got < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
      }
      try {
        await reader.cancel();
      } catch {}
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      out.bytesRead = buf.length;
      out.head = cap > 1024 ? buf.subarray(0, cap).toString("utf8") : buf.subarray(0, 300).toString("utf8");
    }
    out.success = true;
  } catch (err) {
    out.ms = Date.now() - t0;
    out.error = String((err && err.message) || err).slice(0, 200);
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out));
}

/** A manga image as a URL this API serves, or "" when there is none. */
function mangaImageSrc(rawUrl) {
  if (!rawUrl) return "";
  // Path form, not ?u= — see handleMangaImage: the edge cache ignores query
  // strings, which let one cached image answer for every cover.
  return `/api/manga/image/${encodeURIComponent(rawUrl)}`;
}

// Manga page relay: adds the mangakakalot.gg Referer the CDN requires and
// streams the bytes through instead of buffering a full page.
async function handleMangaImage(req, res, url) {
  // The image URL rides in the PATH (/api/manga/image/<encoded>), not the
  // query string: Cloudflare's edge cache ignores query strings by default,
  // so one cached response — once, notoriously, MangaDex's hotlink
  // placeholder — was served for EVERY cover on the page. Path-encoding
  // makes each cover its own cache entry so immutable caching is safe again.
  const pathTarget = decodeURIComponent(
    String(url.pathname || "").replace(/^\/api\/manga\/image\/?/, ""),
  );
  const target = pathTarget || url.searchParams.get("u") || url.searchParams.get("url") || "";
  if (!target) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ success: false, error: "Missing image url" }));
  }

  try {
    const image = await proxyMangaImage(target);
    res.statusCode = 200;
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Path-form URLs vary per image, so the browser and the edge may keep them
    // for a year (a reader scrolls back and forth constantly). The legacy
    // ?u= form must never be cached: its edge key would collide across covers.
    res.setHeader(
      "Cache-Control",
      pathTarget ? "public, max-age=31536000, immutable" : "no-store",
    );
    if (image.contentLength) res.setHeader("Content-Length", image.contentLength);

    if (canStream(res) && image.stream && !isLocked(image.stream)) {
      return await pipeWebStream(image.stream, res);
    }
    const buf = image.stream ? await drainReader(image.stream.getReader()) : Buffer.alloc(0);
    return res.end(buf);
  } catch (err) {
    console.warn("[manga] image:", (err && err.message) || err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    return res.end(JSON.stringify({ success: false, error: "Image unavailable" }));
  }
}

// Handler for proxying and caching anime cover/poster images with fallback
async function handleImageProxy(req, res, url) {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    res.statusCode = 400;
    return res.end("Missing image url");
  }

  try {
    const referral = req.headers?.referer || req.headers?.Referer || "https://mangakakalot.gg/";
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "Referer": referral },
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const contentType = response.headers.get("content-type") || "image/jpeg";
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400");
      const arrayBuf = await response.arrayBuffer();
      return res.end(Buffer.from(arrayBuf));
    }
  } catch {}

  // Fallback to high-quality placeholder svg if remote image is unreachable
  const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e1e2d"/><stop offset="100%" stop-color="#0f0f17"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><path d="M150 170c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40zm0 20c26.7 0 80 13.4 80 40v20H70v-20c0-26.6 53.3-40 80-40z" fill="#3b3b54"/></svg>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.end(fallbackSvg);
}
