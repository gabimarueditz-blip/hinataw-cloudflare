// MovieBox (moviebox.ph) provider — Node port of the attached Moviebox-API
// FastAPI service (Python isn't available in this environment, and the site
// deploys as a single Node app).
//
// Chain (all server-side, guest JWT from the x-user response header):
//   home     https://h5-api.aoneroom.com/wefeed-h5api-bff/home?host=moviebox.ph
//            -> operatingList curated sections (Top Anime, Best Asian Series,
//               Bollywood, ...)
//   detail   GET /detail?detailPath=<slug>
//            -> subject + resource.seasons (se/maxEp/resolutions)
//   player   GET https://netfilm.world/wefeed-h5api-bff/subject/play
//              ?subjectId=&se=&ep=&detailPath=  (Referer = player page URL)
//            -> streams[] MP4 360p-1080p
//   cdn      https://bcdnxw.hakunaymatata.com/...mp4
//            requires Referer: https://moviebox.ph/ (429 otherwise) —
//            so playback goes through /api/moviebox/video (relay with Range).
//
// Movies report se=0/maxEp=0 and only play with se=0,ep=0; series play with
// se=N,ep=M. subjectType 1 = movie, 2 = series, 7 = short-form (micro-drama)
// series whose episodes are genuinely 1-3 minutes long.
//
// The play endpoint is the source of truth for content, verified across a
// spread of sections: it never returns a trailer or a preview. Each stream
// entry's `duration` is in seconds and matches the subject's own `duration`
// (also seconds) for the feature, and every resolution of one episode shares
// that duration — so picking the highest resolution cannot pick a teaser.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pipeWebStream, canStream } from "./stream-utils.js";
import { mobileStream, mobileSearch } from "./moviebox-mobile.js";

// The same wefeed BFF is served on two hosts. This site runs on Cloudflare
// Workers, and h5-api.aoneroom.com rejects that egress (429/427) while
// netfilm.world — the player domain running the identical API — answers it
// normally (verified from production with /api/diag). netfilm is tried first;
// aoneroom stays as the fallback, and the r.jina.ai reader remains the last
// resort for GETs. When MOVIEBOX_RELAY is set, every base hops through the
// relay, exactly as before.
const API_BASES = [
  "https://netfilm.world/wefeed-h5api-bff",
  "https://h5-api.aoneroom.com/wefeed-h5api-bff",
];
const SITE = "https://moviebox.ph";
const PLAYER_DEFAULT = "https://netfilm.world";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  Referer: `${SITE}/`,
  Origin: SITE,
  "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
  "X-Request-Lang": "en",
  Accept: "application/json",
  "Content-Type": "application/json",
};

// ---- Vercel egress relay --------------------------------------------------
// The moviebox API and its video CDN reject Cloudflare Workers' HTTP
// fingerprint (429/427) while accepting ordinary Node clients — verified side
// by side on the same machine. When MOVIEBOX_RELAY is set (Freebuff
// production) every upstream call hops through our small Vercel function
// (freebuff/relay); on local Node the env is absent and calls go direct,
// exactly as before this existed.
function viaRelay(target) {
  const base = String(process.env.MOVIEBOX_RELAY || "").replace(/\/+$/, "");
  if (!base) return target;
  const key = String(process.env.MOVIEBOX_RELAY_KEY || "");
  return `${base}/api/relay?k=${encodeURIComponent(key)}&u=${encodeURIComponent(target)}`;
}

// Where the player pulls video bytes from. With the external relay configured
// the browser streams straight from it, so movie bytes never touch
// Cloudflare; without it (local dev, relay outage) the same-origin
// /api/moviebox/video proxy is used as before.
function streamUrlFor(cdnUrl) {
  const base = String(process.env.MOVIEBOX_RELAY || "").replace(/\/+$/, "");
  if (base) {
    const key = String(process.env.MOVIEBOX_RELAY_KEY || "");
    return `${base}/api/relay?k=${encodeURIComponent(key)}&u=${encodeURIComponent(cdnUrl)}`;
  }
  return `/api/moviebox/video?u=${encodeURIComponent(cdnUrl)}`;
}

// ---- GET fallback through the r.jina.ai reader ---------------------------
// The aoneroom BFF rejects Cloudflare Workers' HTTP fingerprint (429/427),
// but the r.jina.ai reader fetches the very same JSON successfully and hands
// it back wrapped in an HTML <pre>. GETs only — search/filter are POST and
// need the external relay hop. Verified: /home returns 34 sections this way.
const READER = "https://r.jina.ai/";

// Same pacing problem as the manga reader: rate limits are per caller IP and
// egress is shared, so calls are spaced out and a 429 triggers a cooldown.
const READER_MIN_GAP_MS = 6000;
const READER_429_COOLDOWN_MS = 16000;
let readerNextSlot = 0;

async function readerJson(target, timeout = 45000) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, [6000, 9000, 12000][attempt - 1] ?? 12000));
    try {
      const wait = readerNextSlot - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const res = await fetch(`${READER}${target}`, {
        headers: { "User-Agent": UA, "x-respond-with": "html", Accept: "text/plain" },
        signal: AbortSignal.timeout(Math.min(timeout, 25000)),
      });
      readerNextSlot = Date.now() + READER_MIN_GAP_MS;
      if (!res.ok) {
        lastErr = new Error(`moviebox reader -> ${res.status}`);
        if (res.status === 429) readerNextSlot = Date.now() + READER_429_COOLDOWN_MS;
        if (res.status !== 429 && res.status < 500) break;
        continue;
      }
      const text = await res.text();
      const m = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(text);
      const body = (m ? m[1] : text)
        .trim()
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
      return JSON.parse(body);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`moviebox reader unreachable: ${target}`);
}

// Guest JWT, acquired from the x-user response header of the home call and
// refreshed whenever the server rotates it.
let token = "";
let tokenPromise = null;

// GET responses are memoized briefly: when egress is rejected the only path
// left is the paced reader (~30-60s with its 429 cooldowns), and the frontend
// re-requests home on every page load. POSTs (search/filter) are never
// memoized — they are user queries and must stay live.
const GET_CACHE = new Map();
const GET_TTL_MS = 5 * 60 * 1000;
function getCached(key) {
  const hit = GET_CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.exp) {
    GET_CACHE.delete(key);
    return undefined;
  }
  return hit.value;
}
function setCached(key, value) {
  if (GET_CACHE.size > 60) {
    const oldest = GET_CACHE.keys().next().value;
    if (oldest !== undefined) GET_CACHE.delete(oldest);
  }
  GET_CACHE.set(key, { value, exp: Date.now() + GET_TTL_MS });
}

async function api(path, { method = "GET", payload = null, timeout = 25000 } = {}) {
  if (method === "GET") {
    const hit = getCached(path);
    if (hit !== undefined) return hit;
    const value = await apiFetch(path, { method, payload, timeout });
    setCached(path, value);
    return value;
  }
  return apiFetch(path, { method, payload, timeout });
}

async function apiFetch(path, { method = "GET", payload = null, timeout = 25000 } = {}) {
  const headers = { ...BASE_HEADERS };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = payload ? JSON.stringify(payload) : undefined;
  let lastStatus = 0;
  let lastErr = null;

  for (const base of API_BASES) {
    let res;
    try {
      res = await fetch(viaRelay(`${base}${path}`), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }

    const xUser = res.headers.get("x-user");
    if (xUser) {
      try {
        const t = JSON.parse(xUser).token;
        if (t) token = t;
      } catch {}
    }

    if (res.ok) return res.json();
    lastStatus = res.status;
    // 429/427/5xx mean our egress was rejected or the upstream blipped — the
    // other base (and then the reader) is worth trying. Any other 4xx is a
    // real answer to the request itself; retrying another host would repeat it.
    if (res.status !== 429 && res.status !== 427 && res.status < 500) {
      throw new Error(`moviebox ${path} -> ${res.status}`);
    }
  }

  // Last resort for GETs: the reader fetches the same JSON from a different
  // egress. POSTs (search/filter) have no reader path and report the last
  // upstream status so the UI shows the honest reason.
  if (method === "GET") {
    return readerJson(`${API_BASES[API_BASES.length - 1]}${path}`, Math.max(timeout, 45000));
  }
  if (lastErr) throw lastErr;
  throw new Error(`moviebox ${path} -> ${lastStatus || "unreachable"}`);
}

// Ensure we hold a guest token before authenticated calls.
async function ensureToken() {
  if (token) return;
  if (!tokenPromise) {
    tokenPromise = api("/home?host=moviebox.ph")
      .then(() => {})
      .catch(() => {})
      .finally(() => { tokenPromise = null; });
  }
  await tokenPromise;
}

// ---------------------------------------------------------------------------
// subjectId -> { slug, title, image, type } registry.
//
// Playing a title needs its detail slug, but only the id travels to the
// browser and back. The home payload alone does not cover the whole catalog
// (search- and filter-sourced titles like "Motu Patlu" never appear in it), so
// every subject normalised anywhere in the app is remembered here and merged
// into the player's id index.
// ---------------------------------------------------------------------------
const SEEN_SUBJECTS = new Map();
const SEEN_MAX = 6000;
// Lives under core/.cache (already gitignored) so the index stays a local
// artifact, exactly like the other caches this project keeps on disk.
const SEEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".cache", "moviebox-subjects.json");

// The index is persisted: without it a restart leaves every id the client still
// holds (an episode in the open player, a row rendered before the restart)
// unplayable until the same catalog happens to be browsed again.
let seenLoadDone = false;
let seenSaveTimer = null;

function loadSeenSubjects() {
  if (seenLoadDone) return;
  seenLoadDone = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    for (const [id, meta] of Object.entries(raw || {})) {
      if (id && meta?.slug) SEEN_SUBJECTS.set(id, meta);
    }
  } catch {
    // No cache yet (first run) — nothing to restore.
  }
}

function scheduleSeenSave() {
  if (seenSaveTimer) return;
  seenSaveTimer = setTimeout(() => {
    seenSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
      fs.writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(SEEN_SUBJECTS)), "utf8");
    } catch {
      // A read-only filesystem (serverless) simply keeps the in-memory index.
    }
  }, 5000);
  seenSaveTimer.unref?.();
}

function rememberSubject(item) {
  loadSeenSubjects();
  if (!item?.id || !item?.slug) return;
  if (SEEN_SUBJECTS.size >= SEEN_MAX && !SEEN_SUBJECTS.has(item.id)) {
    const oldest = SEEN_SUBJECTS.keys().next().value;
    if (oldest !== undefined) SEEN_SUBJECTS.delete(oldest);
  }
  // Refresh insertion order so frequently-seen titles are evicted last.
  SEEN_SUBJECTS.delete(item.id);
  SEEN_SUBJECTS.set(item.id, {
    slug: item.slug,
    title: item.title || "",
    image: item.image || "",
    type: item.type,
  });
  scheduleSeenSave();
}

/** Snapshot of every subject id seen so far (id -> { slug, title, image }). */
export function getSeenMovieboxSubjects() {
  loadSeenSubjects();
  return SEEN_SUBJECTS;
}

function normalizeItem(sub) {
  if (!sub || !sub.detailPath || !sub.title) return null;
  const item = {
    id: String(sub.subjectId || ""),
    slug: sub.detailPath,
    title: String(sub.title),
    image: sub.cover?.url || "",
    year: sub.releaseDate ? String(sub.releaseDate).slice(0, 4) : "",
    rating: sub.imdbRatingValue != null && sub.imdbRatingValue !== "" ? String(sub.imdbRatingValue) : "",
    genre: typeof sub.genre === "string" ? sub.genre : "",
    badge: sub.corner || "",
    type: Number(sub.subjectType) === 1 ? "movie" : "series",
    // subjectType 7 is the "Hot Short TV" micro-drama feed: real series, but
    // their episodes run 1-3 minutes, so they must not be mixed into the
    // movie/series rows where a 90-second episode reads as a trailer.
    short: Number(sub.subjectType) === 7,
  };
  rememberSubject(item);
  return item;
}

// Curated homepage sections, grouped into the buckets the UI renders.
// Falls back to a shallow scan of any subject-bearing operatingList entry.
export async function fetchMovieboxHome() {
  await ensureToken();
  const home = await api("/home?host=moviebox.ph");
  const ops = home?.data?.operatingList || [];

  const byTitle = new Map();
  for (const op of ops) {
    const items = (op.subjects || []).map(normalizeItem).filter(Boolean);
    if (items.length) byTitle.set(String(op.title || "").trim(), items);
  }

  const pick = (...titles) => {
    for (const t of titles) {
      const list = byTitle.get(t);
      if (list && list.length) return list;
    }
    return [];
  };

  // Upstream renames its curated sections over time (the historical
  // "Bollywood" / "Western TV" / "🔥Trending Now" buckets became "Popular
  // Series" / "Popular Movie" / ... in Oct 2026), which silently emptied
  // every top-level list while sections stayed full. When none of the
  // historical titles match, fill the pools by item type from whatever
  // sections exist so the home rows are never empty.
  const allItems = ops.flatMap((op) => (op.subjects || []).map(normalizeItem).filter(Boolean));

  const seriesPool = [
    ...pick("Top Anime"),
    ...pick("Best Asian Series"),
    ...pick("Western TV"),
  ];
  if (!seriesPool.length) seriesPool.push(...allItems.filter((i) => i.type === "series"));
  const moviePool = [
    ...pick("Bollywood"),
    ...pick("South Indian"),
    ...pick("Hollywood"),
  ];
  if (!moviePool.length) moviePool.push(...allItems.filter((i) => i.type === "movie" && !i.short));
  let trending = pick("🔥Trending Now");
  if (!trending.length && ops.length) {
    trending = (ops[0].subjects || []).map(normalizeItem).filter(Boolean);
  }
  const animePool = pick("Top Anime");

  // De-dup by slug across pools.
  const dedupe = (list, cap) => {
    const seen = new Set();
    const out = [];
    for (const it of list) {
      if (seen.has(it.slug)) continue;
      seen.add(it.slug);
      out.push(it);
      if (out.length >= cap) break;
    }
    return out;
  };

  // Every curated operatingList section, in upstream order. The frontend maps
  // these onto the stacked home carousels and the full-library grid, so the
  // whole (curated) MovieBox catalog is reachable from the UI.
  const sections = [];
  const seenSection = new Set();
  for (const op of ops) {
    const title = String(op.title || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const items = (op.subjects || []).map(normalizeItem).filter(Boolean);
    if (!title || !items.length) continue;
    if (seenSection.has(title)) continue;
    seenSection.add(title);
    sections.push({ title, items });
  }

  return {
    series: dedupe(seriesPool, 18),
    movies: dedupe(moviePool, 18),
    trending: dedupe(trending, 18),
    anime: dedupe(animePool.length ? animePool : seriesPool, 18),
    // Raw curated sections (e.g. "Trending Now", "Cinema", "Bollywood",
    // "South Indian", "Hollywood", "Indian Drama", "Top Anime",
    // "Best Asian Series", "Western TV", "Free Now!", "Hot Short TV").
    sections,
    // De-duped union of every curated section: the "entire library" feed used
    // by the library grid. Capped to keep payloads sane.
    library: dedupe(
      sections.flatMap((s) => s.items),
      400,
    ),
  };
}

// Category tab browse (tabId: 2 movies, 5 tv, 8 animation) — kept for the
// browse pages; home sections come from the curated operatingList instead
// because the raw tabs interleave non-video uploads.
export async function fetchMovieboxList(tabId, page = 1, perPage = 24) {
  await ensureToken();
  const data = await api("/subject/filter", {
    method: "POST",
    payload: {
      tabId: Number(tabId) || 2,
      filter: { sort: "RECOMMEND", genre: "ALL", country: "ALL", year: "ALL", language: "ALL" },
      page: Math.max(1, Number(page) || 1),
      perPage: Math.max(1, Math.min(50, Number(perPage) || 24)),
    },
  });
  const inner = data?.data || {};
  const raw = inner.items || inner.subjects || [];
  return raw.map(normalizeItem).filter(Boolean);
}

export async function searchMoviebox(query, page = 1) {
  const q = String(query || "").trim();
  if (!q) return [];

  // The signed mobile API leads: the h5 POST search is rejected outright on
  // some egresses (Render answers 429 and POSTs have no reader path), while
  // the mobile endpoint answers everywhere. The h5 search stays as the
  // fallback when mobile is down.
  let raw = [];
  try {
    raw = await mobileSearch(q, page);
  } catch {
    raw = [];
  }
  if (!raw.length) {
    try {
      await ensureToken();
      const data = await api("/subject/search", {
        method: "POST",
        payload: { keyword: q, page: Math.max(1, Number(page) || 1), perPage: 20 },
      });
      const inner = data?.data || {};
      raw = inner.items || inner.list || [];
    } catch {
      raw = [];
    }
  }
  return raw.map(normalizeItem).filter(Boolean);
}

// Detail: subject info + season/episode availability from resource.seasons.
export async function fetchMovieboxDetail(slug) {
  const s = String(slug || "").trim();
  if (!s) return null;
  await ensureToken();
  const data = await api(`/detail?detailPath=${encodeURIComponent(s)}`);
  const dd = data?.data || data;
  const sub = dd?.subject;
  if (!sub) return null;

  const seasons = (dd.resource?.seasons || []).map((se) => ({
    se: Number(se.se) || 0,
    maxEp: Number(se.maxEp) || 0,
    // `allEp` is a comma-separated list of the episodes that actually exist,
    // which is usually far shorter than maxEp (Bigg Boss: maxEp 133, 63 real
    // episodes). Enumerating 1..maxEp invents episodes that only ever answer
    // "no resource"; the frontend uses this list to build the episode grid.
    allEp: String(se.allEp ?? "")
      .split(",")
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n > 0),
    resolutions: (se.resolutions || []).map((r) => ({
      resolution: Number(r.resolution) || 0,
      epNum: Number(r.epNum) || 0,
    })),
  }));

  return {
    ...normalizeItem(sub),
    slug: sub.detailPath || s,
    description: String(sub.description || dd.metadata?.description || ""),
    image: sub.cover?.url || dd.metadata?.image || "",
    // Runtime in seconds (0 when the provider does not know it) and the length
    // of the title's own trailer. For entries that exist only as a teaser —
    // e.g. an unreleased "[Full movie]" — the play endpoint answers with the
    // trailer file itself, so the frontend needs the trailer's length to spot
    // that instead of presenting the teaser as the feature.
    runtime: Number(sub.duration) || 0,
    trailerDuration: Number(sub.trailer?.videoAddress?.duration) || 0,
    seasons,
    isMovie: Number(sub.subjectType) === 1 || (seasons.length === 1 && seasons[0].maxEp <= 1 && Number(sub.subjectType) !== 2),
  };
}

// Resolve an MP4 source for subjectId/se/ep through the player domain.
// Returns { sources: [{resolution, format, url}], hasResource, limited }.
// The URL is wrapped in our own /api/moviebox/video relay because the CDN
// requires a moviebox.ph Referer that a browser cannot send.
export async function fetchMovieboxStream({ subjectId, detailPath, se = 1, ep = 1 }) {
  const id = String(subjectId || "").trim();
  const path = String(detailPath || "").trim();
  if (!id || !path) return null;
  await ensureToken();

  let domain = PLAYER_DEFAULT;
  try {
    const dom = await api("/media-player/get-domain");
    if (typeof dom?.data === "string" && dom.data) domain = dom.data.replace(/\/$/, "");
  } catch {}

  const numSe = Number(se);
  const numEp = Number(ep);

  // The advertised player domain is preferred, but this Worker's egress is
  // only verified against netfilm.world — when the rotated host rejects it,
  // the same play call is retried on the default player domain before giving
  // up, so one dead mirror cannot take playback down with it.
  const domains = domain && domain !== PLAYER_DEFAULT ? [domain, PLAYER_DEFAULT] : [domain];
  let data = null;
  let lastStatus = 0;
  let lastErr = null;
  for (const d of domains) {
    const playerReferer =
      `${d}/spa/videoPlayPage/movies/${path}` +
      `?id=${id}&type=/movie/detail&detailSe=${numSe}&detailEp=${numEp}&lang=en`;
    const playUrl =
      `${d}/wefeed-h5api-bff/subject/play?subjectId=${encodeURIComponent(id)}` +
      `&se=${numSe}&ep=${numEp}&detailPath=${encodeURIComponent(path)}`;
    try {
      const res = await fetch(viaRelay(playUrl), {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
          Referer: playerReferer,
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        data = (await res.json())?.data || {};
        break;
      }
      lastStatus = res.status;
    } catch (e) {
      lastErr = e;
    }
  }
  // The signed app API (Genga-World protocol) answers the same play question
  // with files on the bcdn host, which serves this host's egress, while the h5
  // player's h264 files sit on bcdnxw and are refused there (426/429 — Render
  // included). It also covers limited/VIP episodes whose h5 answer carries no
  // streams at all, which is what used to open the "Please log in before
  // payment" modal. Started here so both lookups run in parallel.
  const mobileSourcesPromise = Promise.race([
    mobileStream({ subjectId: id, se: numSe, ep: numEp }),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("mobile play timeout")), 25000);
      t.unref?.();
    }),
  ]).catch((e) => {
    lastErr = lastErr || e;
    return [];
  });

  let sources = data
    ? (data.streams || [])
        .filter((s) => s && s.url)
        .map((s) => ({
          resolution: Number(s.resolutions) || 0,
          format: String(s.format || "MP4"),
          size: s.size || 0,
          url: streamUrlFor(s.url),
          direct: s.url,
        }))
        .sort((a, b) => b.resolution - a.resolution)
    : [];

  // App files lead: they are the ones this host can actually relay. The h5
  // list stays behind them as failover (and for titles the app API misses),
  // which keeps the direct-first ordering the player already relies on.
  const mobileSources = await mobileSourcesPromise;
  if (mobileSources && mobileSources.length) {
    const seen = new Set(sources.map((s) => s.direct));
    const fromApp = mobileSources
      .filter((s) => s && s.direct && !seen.has(s.direct))
      .map((s) => ({
        resolution: s.resolution || 0,
        format: s.format || "MP4",
        size: s.size || 0,
        url: streamUrlFor(s.direct),
        direct: s.direct,
      }));
    sources = [...fromApp, ...sources];
  }

  if (!data && !sources.length) {
    throw new Error(`moviebox play -> ${lastStatus || (lastErr && lastErr.message) || "unreachable"}`);
  }

  const embedUrl = `${domains[0] || PLAYER_DEFAULT}/spa/videoPlayPage/movies/${path}?id=${id}&type=/movie/detail&detailSe=${numSe}&detailEp=${numEp}&lang=en`;

  return {
    hasResource: Boolean(data?.hasResource) || Boolean(sources.length),
    limited: Boolean(data?.limited),
    freeEpisodes: data?.freeNum,
    sources,
    // The embed stays in the response as a *last-resort* failover only — the
    // frontend must never auto-select it while a direct source exists.
    embedUrl,
  };
}

// Relay a CDN range request through this same-origin proxy.
// Only hosts we resolved ourselves are allowed (no open proxy).
const ALLOWED_CDN_HOSTS = /(\.hakunaymatata\.com|\.aoneroom\.com|\.moviebox\.ph)$/i;

// The video CDN gates on the client, never on us: a browser UA is answered
// 428/426 (the paywall the web player trips) on every host, so the relay has
// to look like the mobile app. What each host then wants differs — bcdn serves
// an app UA with no Referer and rejects a Referer, bcdnxw needs the site
// Referer — so profiles are tried in order instead of guessing per host.
// Verified from Render's own egress through /api/diag: okhttp gets 206
// video/mp4 with a valid Content-Range on bcdn, okhttp+Referer on bcdnxw.
const CDN_HEADER_PROFILES = [
  // The bcdn host the app API hands back serves an app UA with no Referer and
  // rejects a Referer outright (nginx 429).
  { "User-Agent": "okhttp/4.12.0", Accept: "*/*" },
  // bcdnxw (the h5 h264 host) is the other way round: it wants the site
  // Referer, and only then answers a datacenter egress at all.
  {
    "User-Agent": "okhttp/4.12.0",
    Referer: `${SITE}/`,
    Origin: SITE,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  },
  { "User-Agent": "node", Accept: "*/*" },
];
const CDN_RETRY_STATUS = new Set([403, 426, 428, 429, 451]);

export async function relayMovieboxVideo(req, res, url) {
  const target = url.searchParams.get("u");
  if (!target) {
    res.statusCode = 400;
    return res.end("Missing url");
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.statusCode = 400;
    return res.end("Bad url");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_CDN_HOSTS.test(parsed.hostname)) {
    res.statusCode = 403;
    return res.end("Host not allowed");
  }

  let upstream = null;
  let lastStatus = 0;
  let lastErr = null;
  for (const profile of CDN_HEADER_PROFILES) {
    const headers = { ...profile };
    if (req.headers.range) headers.Range = req.headers.range;
    try {
      const r = await fetch(viaRelay(parsed.toString()), {
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (r.status === 200 || r.status === 206 || r.status === 416) {
        upstream = r;
        break;
      }
      lastStatus = r.status;
      // A real answer about the file (404/410/…) is passed through: retrying
      // another UA would only repeat it. Gate/lockout statuses are retried.
      if (!CDN_RETRY_STATUS.has(r.status)) {
        upstream = r;
        break;
      }
      try { await r.body?.cancel(); } catch {}
    } catch (err) {
      lastErr = err;
    }
  }

  if (!upstream) {
    if (!res.headersSent) {
      res.statusCode = lastStatus || 502;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end(
        lastErr && !lastStatus
          ? `Upstream error: ${lastErr.message}`
          : `CDN declined the request (${lastStatus || "unreachable"})`
      );
    }
    try { res.end(); } catch {}
    return;
  }

  const ok = upstream.status === 200 || upstream.status === 206;
  try {
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || (ok ? "video/mp4" : "text/plain; charset=utf-8"));
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Never let a browser or proxy cache a gate answer: a cached 428 would
    // outlive the episode link and keep "failing" after the CDN recovers.
    res.setHeader("Cache-Control", ok ? "public, max-age=3600" : "no-store");
    const cr = upstream.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    const cl = upstream.headers.get("content-length");
    if (cl) res.setHeader("Content-Length", cl);

    // Stream through so long videos never buffer in memory: the player can
    // start on the first bytes and seek straight into the file.
    if (canStream(res) && upstream.body) {
      return pipeWebStream(upstream.body, res);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      return res.end(`Upstream error: ${err.message}`);
    }
    try { res.end(); } catch {}
  }
}
