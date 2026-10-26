// CDN video relay helpers (imported so the relay is Range-aware and doesn't
// buffer the whole file in memory).
import { pipeWebStream, canStream } from "./stream-utils.js";

// Thin caching wrapper so repeated calls to the same India endpoint from the
// same request lifecycle do not fan out unnecessarily. The router already gates
// each endpoint with its own error handling, so this is purely a freshness layer
// scoped to the module instance (which, on serverless cold start, is also the
// process).
const cached = async (key, fn) => {
  let entry = globalThis[`__indiaCached__${key}`];
  // Cache hits are returned synchronously-ish: we only await the promise if it
  // is still in flight, never if it has already settled.
  if (entry) {
    // If the previous call set this to a settled value, return it directly.
    return entry;
  }
  const promise = fn().then((value) => {
    globalThis[`__indiaCached__${key}`] = value;
    return value;
  });
  globalThis[`__indiaCached__${key}`] = promise;
  return promise;
};

// Safety net: if anything inside the India helpers ever throws synchronously or
// leaves a pending promise behind (which can happen if the upstream hangs and the
// request is abandoned), clear that key so the next call is not stuck on the same
// in-flight promise.
const clearIndiaCache = (key) => {
  delete globalThis[`__indiaCached__${key}`];
};

// Periodic purge of stale in-flight promises. On the local dev server this is
// not strictly required because the router owns each request lifecycle, but it
// keeps the module safe if anything outside the router touches these helpers.
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const keys = Object.keys(globalThis).filter((k) => k.startsWith("__indiaCached__"));
    for (const k of keys) {
      const v = globalThis[k];
      // Drop any cache entry that is still a non-settled promise after 30s.
      if (v instanceof Promise) {
        // Only cancel if the underlying fetch is still alive.
        try {
          if (v.inspect ? v.inspect().state === "pending" : v.constructor.name === "Promise") {
            globalThis[k] = undefined;
          }
        } catch {}
      }
    }
  }, 30000).unref?.();
}

const INDIA_VIDEO_ORIGIN = process.env.INDIA_VIDEO_ORIGIN || "https://animahd.com";
const INDIA_VIDEO_UA =
  process.env.INDIA_VIDEO_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Only proxy hosts that are part of the animahd CDN cluster. This is not an
// open proxy: it will refuse anything outside the known domain set.
const INDIA_CDN_HOSTS =
  /(\.animahd\.com|\.animahd\d+\.workers\.dev|\.netfilm\.world|\.aoneroom\.com|\.hakunaymatata\.com|^video-downloads\.googleusercontent\.com)$/i;

// ============================================================================
// AnimeWorld-India (animeworld-india.me) catalog / search / stream helpers.
//
// The Hindi/India rows in this app are fed by the animeworld-india.me site:
//   home        https://animeworld-india.me/
//   series list https://animeworld-india.me/series?page=N
//   movie list  https://animeworld-india.me/movies?page=N
//   search      https://animeworld-india.me/search?q=...&page=N
//   seasons     https://animeworld-india.me/series/<seriesID>
//   episodes    (parsed from the seasons page HTML, plus prev/next links)
//   stream      https://animeworld-india.me/episode/<episodeId>  (iframe src)
//                https://animeworld-india.me/movie/<movieId>     (iframe src)
//
// Those pages ship the stream as a third-party embed iframe (video-embed
// > iframe[src]). The frontend hands that iframe src to the in-page
// <iframe id="videoIframe"> player, so we return the embed URL and let the
// browser run it inside the player modal. We never proxy the embed itself:
// the player modal is already unsandboxed (no sandbox attr) precisely so
// foreign embed players can run.
//
// The router already guards every endpoint with its own error handling, so
// each helper here simply surfaces the live site response. Failures become
// empty shapes or thrown errors that the router turns into 404/502 JSON.
// ============================================================================

const INDIA_SITE = "https://animeworld-india.me";
const INDIA_UA =
  process.env.INDIA_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ABORT = 20000;

async function fetchHtml(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": INDIA_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(ABORT),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/** Very small HTML-to-JSON parser reused by the catalog helpers. */
function parseCatalogList(html, isMovie) {
  const out = [];
  let m;
  // Each post item lives in <li class="status-publish"> inside the post-lst ul.
  const itemRe = /<li[^>]*class="[^"]*status-publish[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const title = (block.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
    const img = (block.match(/<img[^>]*src=["']([^"']+)["']/i) || [])[1];
    const year = (block.match(/<span[^>]*class="[^"]*year[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const rating = (block.match(/<span[^>]*class="[^"]*vote[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const link = (block.match(/<a[^>]*class="[^"]*lnk-blk[^"]*"[^>]*href=["']([^"']+)["']/i) || [])[1];
    if (!title) continue;

    const clean = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

    let id = null;
    let type = isMovie ? "movie" : "series";
    if (link) {
      if (isMovie && link.includes("/movie/")) id = link.split("/movie/")[1].split("/")[0];
      else if (!isMovie && link.includes("/series/")) id = link.split("/series/")[1].split("/")[0];
      else type = "unknown";
    }

    out.push({
      title: clean(title),
      image: img || "",
      year: clean(year) || "",
      rating: clean(rating) || "",
      id,
      type,
      url: link ? new URL(link, INDIA_SITE).href : "",
    });
  }
  return out;
}

/** Parse pagination page numbers from a catalog page. */
function parsePaginationPages(html) {
  const pages = new Set();
  let max = 1;
  const re = /<nav[^>]*class="[^"]*pagination[^"]*"[^>]*>([\s\S]*?)<\/nav>/i;
  const nav = (html.match(re) || [])[1];
  if (nav) {
    const linkRe = /<a[^>]*class="[^"]*page-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(nav)) !== null) {
      const text = lm[1].replace(/<[^>]+>/g, "").trim();
      if (/^\d+$/.test(text)) {
        const n = parseInt(text, 10);
        if (Number.isFinite(n) && n > 0) {
          pages.add(n);
          if (n > max) max = n;
        }
      }
    }
  }
  return { pages: [...pages].sort((a, b) => a - b), totalPages: max };
}

// ---------------------------------------------------------------------------
// Home page: latest series + movies from the home widgets.
// ---------------------------------------------------------------------------
export async function fetchIndiaHome() {
  return cached("home", async () => {
    const html = await fetchHtml(INDIA_SITE + "/").catch(() => "");
    if (!html) return { series: [], movies: [], indianManga: [], indianMangaTotal: 0 };

    const series = parseCatalogList(html, false)
      .filter((it) => it.type === "series" || it.type === "unknown")
      .slice(0, 24);
    const movies = parseCatalogList(html, true)
      .filter((it) => it.type === "movie" || it.type === "unknown")
      .slice(0, 24);

    return { series, movies, indianManga: [], indianMangaTotal: 0 };
  });
}

// ---------------------------------------------------------------------------
// Paginated series list.
// ---------------------------------------------------------------------------
export async function fetchIndiaSeries(ctx, opts) {
  const page = Math.max(1, Number(opts?.page) || 1);
  const url = INDIA_SITE + "/series?page=" + page;
  const html = await fetchHtml(url).catch(() => "");
  if (!html) return [];
  const series = parseCatalogList(html, false).filter((it) => it.type === "series" || it.type === "unknown");
  return series;
}

// ---------------------------------------------------------------------------
// Paginated movie list.
// ---------------------------------------------------------------------------
export async function fetchIndiaMovies(ctx, opts) {
  const page = Math.max(1, Number(opts?.page) || 1);
  const url = INDIA_SITE + "/movies?page=" + page;
  const html = await fetchHtml(url).catch(() => "");
  if (!html) return [];
  const movies = parseCatalogList(html, true).filter((it) => it.type === "movie" || it.type === "unknown");
  return movies;
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------
export async function searchIndia(ctx, opts) {
  const q = String(opts?.query || "").trim();
  const page = Math.max(1, Number(opts?.page) || 1);
  if (!q) return [];
  const url = INDIA_SITE + "/search?q=" + encodeURIComponent(q) + "&page=" + page;
  const html = await fetchHtml(url).catch(() => "");
  if (!html) return [];
  const items = parseCatalogList(html, false)
    .filter((it) => it.type === "series" || it.type === "movie" || it.type === "unknown");
  return items;
}

// ---------------------------------------------------------------------------
// Seasons + metadata for a series (also parsed from the series page HTML).
// ---------------------------------------------------------------------------
export async function fetchIndiaSeasons(ctx, opts) {
  const seriesID = String(opts?.seriesID || "").trim();
  if (!seriesID) return null;
  const url = INDIA_SITE + "/series/" + encodeURIComponent(seriesID);
  const html = await fetchHtml(url).catch(() => "");
  if (!html) return null;

  const title = (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const poster = (html.match(/<div[^>]*class="[^"]*post-thumbnail[^"]*"[^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["']/i) || [])[1];
  const year = (html.match(/<span[^>]*class="[^"]*year[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  const duration = (html.match(/<span[^>]*class="[^"]*duration[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  const desc = (html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
  const rating = (html.match(/<span[^>]*class="[^"]*vote[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*num[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
  const totalSeasons = (html.match(/<span[^>]*class="[^"]*seasons[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1];

  const seasons = [];
  const cardRe = /<div[^>]*class="[^"]*season-card[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let cm;
  while ((cm = cardRe.exec(html)) !== null) {
    const block = cm[1];
    const number = (block.match(/<div[^>]*class="[^"]*season-number[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1];
    const name = (block.match(/<div[^>]*class="[^"]*season-name[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1];
    const count = (block.match(/<span[^>]*class="[^"]*episode-count[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const link = (block.match(/<a[^>]*class="[^"]*season-link[^"]*"[^>]*href=["']([^"']+)["']/i) || [])[1];
    let seasonId = null;
    if (link && link.includes("/season/")) seasonId = link.split("/season/")[1].split("/")[0];
    seasons.push({
      seasonNumber: (number || "").replace(/<[^>]+>/g, "").trim(),
      seasonName: (name || "").replace(/<[^>]+>/g, "").trim(),
      episodes: (count || "").replace(/<[^>]+>/g, "").trim(),
      seasonId,
      url: link ? new URL(link, INDIA_SITE).href : "",
    });
  }
  if (!seasons.length) {
    // The series page may list episodes directly when there is only one season.
    // In that case fall back to the episode list shape the router already
    // expects from /api/india/episodes.
    return {
      series: [{
        seriesId: seriesID,
        title: (title || "").replace(/<[^>]+>/g, "").trim() || seriesID,
        poster: poster || "",
        year: (year || "").replace(/<[^>]+>/g, "").trim(),
        duration: (duration || "").replace(/<[^>]+>/g, "").trim(),
        rating: (rating || "").replace(/<[^>]+>/g, "").trim(),
        totalSeasons: (totalSeasons || "").replace(/<[^>]+>/g, "").trim(),
        description: (desc || "").replace(/<[^>]+>/g, "").trim(),
      }],
      seasons: [{
        seasonNumber: "1",
        seasonName: "Season 1",
        episodes: "",
        seasonId: seriesID,
        url: url,
      }],
    };
  }

  return {
    series: [{
      seriesId: seriesID,
      title: (title || "").replace(/<[^>]+>/g, "").trim() || seriesID,
      poster: poster || "",
      year: (year || "").replace(/<[^>]+>/g, "").trim(),
      duration: (duration || "").replace(/<[^>]+>/g, "").trim(),
      rating: (rating || "").replace(/<[^>]+>/g, "").trim(),
      totalSeasons: (totalSeasons || "").replace(/<[^>]+>/g, "").trim(),
      description: (desc || "").replace(/<[^>]+>/g, "").trim(),
    }],
    seasons,
  };
}

// ---------------------------------------------------------------------------
// Episodes for a season. animeworld-india.me embeds episodes as links into
// the season/episode page HTML. We parse them from the same series page when
// possible, and, when a dedicated season id is passed, from that season page.
// ---------------------------------------------------------------------------
export async function fetchIndiaEpisodes(ctx, opts) {
  const seasonId = String(opts?.seasonId || "").trim();
  if (!seasonId) return null;

  // If seasonId looks like a series slug, fetch the series page and parse
  // episode links from it. Otherwise try a season page directly.
  let url = INDIA_SITE + "/series/" + encodeURIComponent(seasonId);
  let html = await fetchHtml(url).catch(() => "");

  // If the series page did not yield episodes, try the season page shape.
  if (!html || !html.includes("/episode/")) {
    const seasonUrl = INDIA_SITE + "/season/" + encodeURIComponent(seasonId);
    html = await fetchHtml(seasonUrl).catch(() => "");
    url = seasonUrl;
  }

  if (!html) return null;

  const episodes = [];
  const epRe = /<a[^>]*href=["']([^"']*\/episode\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let em;
  while ((em = epRe.exec(html)) !== null) {
    const href = em[1];
    const block = em[2];
    const id = href.split("/episode/")[1].split("/")[0];
    if (!id) continue;
    const title = (block.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1];
    const img = (block.match(/<img[^>]*src=["']([^"']+)["']/i) || [])[1];
    const num = (block.match(/<span[^>]*class="[^"]*year[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    const date = (block.match(/<span[^>]*class="[^"]*number[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1];
    episodes.push({
      episodeId: id,
      title: (title || "").replace(/<[^>]+>/g, "").trim() || `Episode ${episodes.length + 1}`,
      episodeNumber: (num || "").replace(/<[^>]+>/g, "").trim(),
      airDate: (date || "").replace(/<[^>]+>/g, "").trim(),
      image: img || "",
      url: new URL(href, INDIA_SITE).href,
    });
  }

  if (!episodes.length) return null;
  return { episodes, seasonId, seasonUrl: url };
}

// ---------------------------------------------------------------------------
// Stream link for an episode or movie. Returns the embed URL from the
// animeworld-india.me episode/movie page so the frontend can load it in the
// player iframe.
// ---------------------------------------------------------------------------
export async function fetchIndiaStream(ctx, opts) {
  const episodeId = String(opts?.episodeId || "").trim();
  const movieId = String(opts?.movieId || "").trim();
  if (!episodeId && !movieId) return null;

  let url;
  if (episodeId) {
    url = INDIA_SITE + "/episode/" + encodeURIComponent(episodeId);
  } else {
    url = INDIA_SITE + "/movie/" + encodeURIComponent(movieId);
  }

  const html = await fetchHtml(url).catch(() => "");
  if (!html) return null;

  // Primary: video-embed iframe src.
  const iframeSrc = (html.match(/<div[^>]*class="[^"]*video-embed[^"]*"[^>]*>[\s\S]*?<iframe[^>]*src=["']([^"']+)["']/i) || [])[1];

  // Fallback: any iframe on the page that points to a player/embed domain.
  const fallbackIframe = (html.match(/<iframe[^>]*src=["']([^"']+embed[^"']*|[^"']+player[^"']*|[^"']+video\.php[^"']*)["']/i) || [])[1];

  const streamLink = iframeSrc || fallbackIframe;
  if (!streamLink) return null;

  // Also grab the direct download link when present, so the UI has a fallback
  // download option even if the embed does not play in this browser.
  const downloadLink = (html.match(/<div[^>]*class="[^"]*archive-link-wrap[^"]*"[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i) || [])[1];

  return {
    success: true,
    stream: {
      streamLink,
      file: downloadLink || "",
    },
    type: episodeId ? "episode" : "movie",
  };
}

// ---------------------------------------------------------------------------
// Full catalogue (paged, with totals) used by the library grid.
// ---------------------------------------------------------------------------
export async function fetchIndiaCatalog(opts) {
  const page = Math.max(1, Number(opts?.page) || 1);
  const perPage = Math.max(1, Math.min(100, Number(opts?.perPage) || 48));
  const type = String(opts?.type || "all").toLowerCase();

  const [seriesHtml, movieHtml] = await Promise.all([
    fetchHtml(INDIA_SITE + "/series?page=" + page).catch(() => ""),
    fetchHtml(INDIA_SITE + "/movies?page=" + page).catch(() => ""),
  ]);

  if (!seriesHtml && !movieHtml) return { items: [], total: 0, totalPages: 0 };

  const series = parseCatalogList(seriesHtml, false).filter((it) => it.type === "series" || it.type === "unknown");
  const movies = parseCatalogList(movieHtml, true).filter((it) => it.type === "movie" || it.type === "unknown");

  const typePages = (html) => parsePaginationPages(html).totalPages;

  const seriesPages = !seriesHtml ? 1 : typePages(seriesHtml);
  const moviePages = !movieHtml ? 1 : typePages(movieHtml);

  let items = [];
  let total = 0;
  let totalPages = 0;

  if (type === "movie") {
    items = movies;
    total = movies.length * moviePages;
    totalPages = moviePages;
  } else if (type === "series") {
    items = series;
    total = series.length * seriesPages;
    totalPages = seriesPages;
  } else {
    items = [...series, ...movies];
    total = series.length * seriesPages + movies.length * moviePages;
    totalPages = Math.max(seriesPages, moviePages);
  }

  return {
    items: items.slice(0, perPage),
    total,
    totalPages: Math.max(1, totalPages),
    page,
  };
}

// ---------------------------------------------------------------------------
// Totals used by the paginated list endpoints.
// ---------------------------------------------------------------------------
export async function fetchIndiaTotals() {
  const [seriesHtml, movieHtml] = await Promise.all([
    fetchHtml(INDIA_SITE + "/series?page=1").catch(() => ""),
    fetchHtml(INDIA_SITE + "/movies?page=1").catch(() => ""),
  ]);

  const seriesCount = seriesHtml ? parseCatalogList(seriesHtml, false).filter((it) => it.type === "series" || it.type === "unknown").length : 0;
  const movieCount = movieHtml ? parseCatalogList(movieHtml, true).filter((it) => it.type === "movie" || it.type === "unknown").length : 0;

  // Rough page count from pagination (used for total estimates).
  const seriesPages = seriesHtml ? parsePaginationPages(seriesHtml).totalPages : 1;
  const moviePages = movieHtml ? parsePaginationPages(movieHtml).totalPages : 1;

  return {
    series: seriesCount * seriesPages,
    movies: movieCount * moviePages,
  };
}

// ---------------------------------------------------------------------------
// Pick a stream URL for an item. Mostly a convenience hook for any UI code
// that wants a single string; the real caller is the stream endpoint above.
// ---------------------------------------------------------------------------
export function pickStreamURL(item) {
  if (!item) return null;
  if (item.stream?.streamLink) return item.stream.streamLink;
  if (item.url) return item.url;
  return null;
}

// ---------------------------------------------------------------------------
// Relay a raw India CDN video URL through the server. This is the handler the
// router invokes for /api/india/video. The CDN worker rejects any foreign
// Referer, so the browser cannot fetch these bytes directly and the server
// must fetch + stream them on its behalf.
// ---------------------------------------------------------------------------
export async function relayIndiaVideo(req, res, url) {
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

  if (parsed.protocol !== "https:" || !INDIA_CDN_HOSTS.test(parsed.hostname)) {
    res.statusCode = 403;
    return res.end("Host not allowed");
  }

  const headers = {
    "User-Agent": INDIA_VIDEO_UA,
    Referer: INDIA_VIDEO_ORIGIN + "/",
    Origin: INDIA_VIDEO_ORIGIN,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    // Connect timeout only. AbortSignal.timeout would also cut the body after a
    // minute, truncating any file still downloading — the browser then reports
    // ERR_CONTENT_LENGTH_MISMATCH and the player fails over mid-episode.
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 20000);
    let upstream;
    try {
      upstream = await fetch(parsed.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!upstream.ok && upstream.status !== 403 && upstream.status !== 401) {
      throw new Error(`remote returned ${upstream.status}`);
    }

    // Some CDN workers return a JSON/WWW-Auth challenge instead of the file;
    // forward whatever content-type they gave us so the browser can show the
    // real error instead of a broken player.
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Never edge-cache this: a cached *partial* body (the first bytes the
    // viewer happened to read) then answered every later request, so seeking
    // and even the first frame broke. Range requests must reach the origin and
    // stop there.
    res.setHeader("Cache-Control", "no-store");

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

