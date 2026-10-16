// Manga source — MangaKakalot (mangakakalot.gg), the same site the MangaHook
// and MangaFire libraries scrape. Both of those fronts are unusable here:
// MangaKakalot's old domains (www6.mangakakalot.tv, mangakakalot.tv) are now a
// ParkLogic parking page, and mangafire.to answers every request with a
// Cloudflare "Just a moment..." interstitial that r.jina.ai cannot pass either.
// mangakakalot.gg answers normally and exposes two useful surfaces:
//
//   GET  /                                   -> popular + latest (HTML)
//   GET  /manga-list/<latest|hot|new|completed>-manga?page=N  (HTML)
//   GET  /genre/<genre>?page=N               (HTML)
//   GET  /search/story/<term>                (HTML)
//   GET  /manga/<slug>                       (HTML)
//   GET  /manga/<slug>/chapter-<n>           (HTML, the reader)
//   GET  /api/manga/<slug>/chapters          (JSON, direct — no proxy needed)
//
// Network note: Cloudflare lets the homepage and the /api/ JSON through
// unauthenticated, but challenges every content page (search, list, detail,
// chapter) with "Just a moment..." -> 403 for both curl and Node. The r.jina.ai
// reader, asked with `x-respond-with: html`, returns the real markup for those
// pages, so each page fetch falls back to it. Chapter lists come from the JSON
// endpoint directly, which keeps the reader budget to ~1 request per page.
//
// Three backends sit behind the 403:
//   1. translate.goog — Google fetches the page with its own egress, which
//      Cloudflare lets through, so this is the LIVE backend: it serves pages
//      the archive never captured (same-day chapters, searches) and answers
//      in seconds. tl=en on an auto-detected English source passes the text
//      through unchanged; only anchor hrefs are rewritten to *.translate.goog
//      with _x_tr_* params, which the href regexes tolerate.
//   2. the Wayback Machine (id_ = original bytes) — for the two stale-tolerant
//      pages only (detail/chapter): chapters are immutable once published and
//      details barely change. It rate-limits Workers egress to about every
//      other request, so it is the backup when Google 429s, not the front door.
//   3. r.jina.ai — last resort. It rate-limits per IP and Workers egress is
//      shared, so it answers 429 for long stretches; without backends 1-2 it
//      was the only path and detail/chapter requests failed outright (502).
// Only the two stale-tolerant fetches opt into the archive (archive:true) —
// search/browse/latest stay live via translate/jina.
// Set MANGA_PROXY=off to disable the fallbacks.
//
// Images: the CDN (img-r1.2xstorage.com, imgs-2.2xstorage.com) answers 403
// unless the request carries a mangakakalot.gg Referer, which a browser will
// never send for our origin — every page image therefore goes through
// /api/manga/image, which adds the header server-side. Verified: 200
// image/webp with the Referer, 403 without it.

import { mdxSearch, mdxInfo, mdxChapter, mdxHome, mdxBrowse, mdxTags } from "./mangadex.js";

const SITE = "https://www.mangakakalot.gg";
const SITE_HOST = "www.mangakakalot.gg";
const READER = "https://r.jina.ai/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const DIRECT_TIMEOUT = 12000;
const PROXY_TIMEOUT = 40000;

const TTL_PAGE = 30 * 60 * 1000;
const TTL_CHAPTERS = 20 * 60 * 1000;

const CACHE = new Map();
const CACHE_MAX = 400;

const CDN_HOSTS = /(?:img-r\d|imgs-\d|storage\.waitst)\./i;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) {
    CACHE.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, { value, exp: Date.now() + ttl });
  return value;
}

// Sentinel for a recently failed fetch: remembered for a minute so a dead
// upstream isn't hammered, but rethrown on read so callers surface an outage
// honestly instead of serving a fake empty result.
const CACHED_FAIL = Symbol("manga:cached-fail");

async function cached(key, ttl, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) {
    if (hit === CACHED_FAIL) throw new Error("manga source recently failed; retry shortly");
    return hit;
  }
  try {
    return cacheSet(key, await loader(), ttl);
  } catch (err) {
    cacheSet(key, CACHED_FAIL, 60 * 1000);
    throw err;
  }
}

const proxyEnabled = () => String(process.env.MANGA_PROXY || "on").toLowerCase() !== "off";

// r.jina.ai rate-limits by caller IP and Workers egress is shared, so beyond
// plain backoff the reader also paces its own calls (minimum gap) and sits
// out a cooldown after every 429 — otherwise every attempt burns the whole
// retry budget inside one rate-limit window and the request fails even
// though the page is fetchable seconds later.
const READER_ATTEMPTS = 4;
const READER_RETRY_DELAYS = [9000, 12000, 15000];
const READER_MIN_GAP_MS = 6000;
const READER_429_COOLDOWN_MS = 16000;
let readerNextSlot = 0;

async function readerPace() {
  const wait = readerNextSlot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
function readerGate() {
  readerNextSlot = Date.now() + READER_MIN_GAP_MS;
}
function readerThrottle() {
  readerNextSlot = Date.now() + READER_429_COOLDOWN_MS;
}

// The reader sometimes answers 200 with a Cloudflare interstitial or a soft
// error page; parsing that yields zero items, which reads as "no results
// found". Callers pass `expect` (the marker their parser needs) so bad
// payloads retry instead of passing as valid-but-empty pages.
const READER_CHALLENGE =
  /just a moment|performing security verification|attention required|enable javascript and cookies|cf-browser-verification|too many requests|rate limit exceeded/i;

async function fetchViaReader(url, minLength, expect = null) {
  let lastErr = null;
  for (let attempt = 0; attempt < READER_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, READER_RETRY_DELAYS[attempt - 1] ?? 12000));
    }
    try {
      await readerPace();
      const res = await fetch(`${READER}${url}`, {
        headers: { "User-Agent": UA, "x-respond-with": "html", Accept: "text/plain" },
        signal: AbortSignal.timeout(Math.min(PROXY_TIMEOUT, 20000)),
      });
      readerGate();
      if (!res.ok) {
        lastErr = new Error(`manga reader -> ${res.status}`);
        if (res.status === 429) readerThrottle();
        // 429 (rate limit) and 5xx are worth retrying; other 4xx are permanent.
        if (res.status !== 429 && res.status < 500) break;
        continue;
      }
      const html = await res.text();
      if (!html || html.length < minLength) {
        lastErr = new Error("manga reader returned no page");
        continue;
      }
      if (READER_CHALLENGE.test(html.slice(0, 1500))) {
        lastErr = new Error("manga reader hit a challenge page");
        continue;
      }
      if (expect && !expect.test(html)) {
        lastErr = new Error("manga reader returned unexpected markup");
        continue;
      }
      return html;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`manga source unreachable: ${url}`);
}

/**
 * Fetch a mangakakalot.gg page. Direct first (works from residential/local
 * egress); when Cloudflare 403s the subpath — which it always does from
 * Workers — or the request fails, the reader supplies the same markup with
 * rate-limit-aware retries.
 */
async function fetchPage(url, { minLength = 2000, timeout = DIRECT_TIMEOUT, expect = null, archive = false } = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `${SITE}/`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const html = await res.text();
      // The challenge page is small and self-identifying; a real page is huge.
      if (html && html.length >= minLength && !/Just a moment/i.test(html.slice(0, 1200))) return html;
    }
  } catch {
    // fall through to the reader
  }

  if (!proxyEnabled()) throw new Error(`manga source unreachable: ${url}`);
  // translate.goog first: it is LIVE (serves same-day pages) and typically
  // answers in a few seconds, so it is the everyday path. The archive is the
  // stale-tolerant backup for when Google's anonymous quota 429s — trying it
  // first cost 20-40s of paced 429 retries whenever its flaky quota missed.
  try {
    return await fetchViaTranslate(url, minLength, expect);
  } catch {
    // fall through
  }
  if (archive) {
    try {
      return await fetchViaWayback(url, minLength, expect);
    } catch {
      // fall through to the reader
    }
  }
  return fetchViaReader(url, minLength, expect);
}

// Google's translate proxy (same-site slug, no mapping needed) fetches the
// page with Google's egress — the one fingerprint mangakakalot's Cloudflare
// accepts — and returns the full markup, translated into English. From an
// English source that is effectively a passthrough: classes, images and text
// come back as the site sent them; hrefs are rewritten to
// <host>.translate.goog with _x_tr_* query params, which the genre/link
// regexes accept. Anonymous quota is generous but does 429 occasionally, so
// requests share a light pacing gate and retry spaced.
function translateUrlFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== SITE_HOST) return null;
    const t = new URL(`https://${u.hostname.replace(/\./g, "-")}.translate.goog${u.pathname}${u.search}`);
    t.searchParams.set("_x_tr_sl", "auto");
    t.searchParams.set("_x_tr_tl", "en");
    t.searchParams.set("_x_tr_hl", "en");
    return t.toString();
  } catch {
    return null;
  }
}

const TRANSLATE_ATTEMPTS = 3;
const TRANSLATE_RETRY_DELAYS = [3000, 6000];
const TRANSLATE_MIN_GAP_MS = 3000;
let translateNextSlot = 0;

async function translatePace() {
  const wait = translateNextSlot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  translateNextSlot = Date.now() + TRANSLATE_MIN_GAP_MS;
}

async function fetchViaTranslate(url, minLength, expect = null) {
  const target = translateUrlFor(url);
  if (!target) throw new Error("translate: unsupported url");
  let lastErr = null;
  for (let attempt = 0; attempt < TRANSLATE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, TRANSLATE_RETRY_DELAYS[attempt - 1] ?? 6000));
    }
    let res;
    try {
      await translatePace();
      res = await fetch(target, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`translate -> ${res.status}`);
      // Google answers 429 when the anonymous quota runs out — worth retrying;
      // other 4xx mean the page itself is gone upstream.
      if (res.status !== 429 && res.status < 500) break;
      continue;
    }
    const html = await res.text();
    if (!html || html.length < minLength) {
      lastErr = new Error("translate returned no page");
      continue;
    }
    if (expect && !expect.test(html)) {
      lastErr = new Error("translate returned unexpected markup");
      continue;
    }
    return html;
  }
  throw lastErr || new Error(`translate unreachable: ${url}`);
}

// The Wayback Machine serves archived pages with no challenge. `2026id_` picks
// the newest snapshot up to 2026 and returns the original bytes (no banner,
// no rewritten URLs), so parsers see the same markup the live site sent.
// archive.org rate-limits bursts from Workers egress with a short 429 body;
// spaced retries clear it within seconds.
const WAYBACK_PREFIX = "https://web.archive.org/web/2026id_/";
const ARCHIVE_ATTEMPTS = 5;
const ARCHIVE_RETRY_DELAYS = [3000, 5000, 7000, 9000];
// archive.org accepts roughly every other request from Workers egress (measured
// 200/429/429/200/429 at 5s spacing), and a chapter request fires the detail
// and chapter fetches at the same time — without a shared gate the two chains
// burn each other's quota. Every archive request (success or 429) claims the
// next slot, so all chains in this isolate interleave at >=5s spacing.
const ARCHIVE_MIN_GAP_MS = 5000;
let archiveNextSlot = 0;

async function archivePace() {
  const wait = archiveNextSlot - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  archiveNextSlot = Date.now() + ARCHIVE_MIN_GAP_MS;
}

async function fetchViaWayback(url, minLength, expect = null) {
  let lastErr = null;
  for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, ARCHIVE_RETRY_DELAYS[attempt - 1] ?? 9000));
    }
    let res;
    try {
      await archivePace();
      res = await fetch(WAYBACK_PREFIX + url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastErr = e;
      continue;
    }
    // Never captured — the archive will not have it later this minute either.
    if (res.status === 404 || res.status === 410) throw new Error(`archive: not archived (${res.status})`);
    if (!res.ok) {
      lastErr = new Error(`archive -> ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
      continue;
    }
    const html = await res.text();
    if (!html || html.length < minLength) {
      lastErr = new Error("archive returned no page");
      continue;
    }
    if (READER_CHALLENGE.test(html.slice(0, 1500))) {
      lastErr = new Error("archive returned a challenge page");
      continue;
    }
    if (expect && !expect.test(html)) {
      lastErr = new Error("archive returned unexpected markup");
      continue;
    }
    return html;
  }
  throw lastErr || new Error(`archive unreachable: ${url}`);
}

/**
 * The chapters endpoint is plain JSON and is not challenged. It is paginated
 * (50 rows by default, with `pagination.has_more`), and accepts a limit, so one
 * request pulls a whole series: limit=2000 returned all 1381 One Piece rows and
 * all 787 Naruto rows.
 */
async function fetchChaptersJson(slug, { fallbackToReader = true } = {}) {
  const url = `${SITE}/api/manga/${encodeURIComponent(slug)}/chapters?limit=2000`;
  const attempt = async (target) => {
    const res = await fetch(target, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: `${SITE}/manga/${slug}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT),
    });
    if (!res.ok) throw new Error(`chapters -> ${res.status}`);
    return res.text();
  };

  let text;
  try {
    text = await attempt(url);
  } catch (err) {
    // The bridge's slug probe passes fallbackToReader:false — a wrong guess
    // must fail fast instead of burning reader attempts on a 404.
    if (!fallbackToReader || !proxyEnabled()) throw err;
    // Same rate-limit-aware reader as page fetches; the reader hands JSON
    // back wrapped in an HTML <pre>.
    text = await fetchViaReader(url, 100);
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(text);
    if (pre) text = decodeEntities(pre[1]);
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) throw new Error("chapters: unexpected payload");
  return JSON.parse(trimmed);
}

function decodeEntities(input) {
  return String(input || "")
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;br\s*\/?&gt;|&lt;\/?p&gt;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#038;|&amp;/g, "&")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&#8212;|&mdash;/g, "-")
    .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove the source site's branding and title boilerplate from any text that
 * reaches the UI: page titles arrive as "Hot Manga List - Read Top Trending
 * Manga Online Free On MangaKakalot" and image alts as "... page 1 -
 * MangaKakalot". The tail is dropped only when it actually carries the brand,
 * so legitimate titles that contain " - " are untouched.
 */
export function debrand(text) {
  let out = decodeEntities(String(text || "")).replace(/\s*class=$/i, "");
  const tail = out.search(/\s+[-|–—]\s+[^-|–—]*MangaKakalot/i);
  if (tail > 0) out = out.slice(0, tail);
  return out
    .replace(/\s*[-|–—,:]?\s*MangaKakalot\b/gi, "")
    .replace(/\s+[-|–—]\s*Read\s+(?:Top\s+Trending|Manga|Manhwa)[^|]*$/i, "")
    .trim();
}

const stripTags = (html) => {
  const text = decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(?:br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
  // Entities that decoded into real tags (the source stores "&lt;br&gt;" in
  // summaries) must not survive as text either.
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
};

/**
 * Card windows: the reader's serialized DOM nests card content in sibling divs
 * (e.g. `.story_item` holds only the cover link while `h3.story_name` sits in
 * `.story_item_right`), so a naive split on the card class truncates every
 * card. Each window here runs from one card marker to the next marker, capped
 * at `max` characters.
 */
function cardWindows(html, marker, { max = 3000 } = {}) {
  const marks = [];
  for (const m of String(html || "").matchAll(marker)) marks.push(m.index);
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const next = i + 1 < marks.length ? marks[i + 1] : html.length;
    out.push(html.slice(start, Math.min(next, start + max)));
  }
  return out;
}

function absolute(url) {
  const u = decodeEntities(url);
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `${SITE}${u}`;
  return u;
}

/**
 * Card title. The lookup is bounded to the card's own <h3>: without that bound
 * the lazy match runs past the title into the chapter link, which is how
 * "Naruto" ended up reported as its newest chapter name.
 */
function cardTitle(card, altFallback = "") {
  const h3 = (card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || "";
  const fromH3 = decodeEntities(
    (h3.match(/title="([^"]+)"/i) || [])[1] || (h3.match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || ""
  );
  if (fromH3) return debrand(fromH3.replace(/\s*class=$/i, ""));
  return debrand(altFallback.replace(/\s*class=$/i, ""));
}

/** Thumbnails are served from a rotating set of CDN hosts; keep the path. */
const thumbPath = (url) => {
  const u = absolute(url);
  const m = /^https?:\/\/[^/]+(\/.*)$/i.exec(u);
  return m ? m[1] : "";
};

/** /manga/<slug> -> <slug> */
const slugFromUrl = (url) => {
  const m = /\/manga\/([^/?#]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
};

/** Chapter number out of "chapter-12.5" or "Chapter 12.5". */
function chapterNumber(raw) {
  const m = /(\d+(?:[.-]\d+)?)/.exec(String(raw || "").replace(/chapter[-_\s]*/i, ""));
  return m ? m[1] : "";
}

/**
 * Every page image inside the chapter reader div: src plus the onerror mirror.
 * Only page art is kept — the reader container also holds the site's spinner
 * (`/images/loadingimg.gif`) and 404 avatar, which are mangakakalot.gg chrome,
 * not pages of the chapter.
 */
const CHROME_IMAGE = /(loadingimg|404-avatar|favicon|logo)/i;

function isPageArt(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (CHROME_IMAGE.test(url)) return false;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (/mangakakalot\.gg$/i.test(host)) return false;
  if (CDN_HOSTS.test(host)) return true;
  return /\/\d+(?:[.-]\d+)?\.(?:webp|jpe?g|png)$/i.test(url);
}

/**
 * Extent of one element, found by walking its <div> nesting to the matching
 * close. The reader container is followed by "recommended" cover art and
 * comments whose <img> tags are not pages of this chapter.
 */
function elementExtent(html, startIndex, tag = "div") {
  const open = new RegExp(`<${tag}\\b`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  const region = html.slice(startIndex);
  open.lastIndex = 1;
  const openTags = [...region.matchAll(open)];
  close.lastIndex = 1;
  const closeTags = [...region.matchAll(close)];
  const limit = Math.min(openTags.length, closeTags.length);
  for (let i = 0; i < limit; i++) {
    if (closeTags[i].index < openTags[i].index) {
      return startIndex + closeTags[i].index + closeTags[i][0].length;
    }
  }
  return startIndex + Math.min(region.length, 900000);
}

export function parseChapterHtml(html) {
  const start = html.search(/class="container-chapter-reader"/i);
  const regionStart = start >= 0 ? html.lastIndexOf("<", start) : 0;
  const end = start >= 0 ? elementExtent(html, regionStart) : html.length;
  const region = html.slice(Math.max(0, regionStart), end);
  const images = [];
  const seen = new Set();
  for (const m of region.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // Quote-agnostic: the live page double-quotes attributes, archived
    // snapshots of the same template single-quote them.
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
    if (!src) continue;
    const clean = absolute(src);
    if (!isPageArt(clean) || seen.has(clean)) continue;
    seen.add(clean);
    const onerror = decodeEntities((tag.match(/onerror="([^"]*)"/i) || [])[1] || "");
    const mirror = (onerror.match(/https?:\/\/[^'"\s)]+\.(?:webp|jpg|jpeg|png)/i) || [])[0] || "";
    images.push({
      raw: clean,
      mirror: mirror && isPageArt(absolute(mirror)) ? absolute(mirror) : "",
      alt: debrand((tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || ""),
    });
  }
  return images;
}

/** A list/genre page: `.list-comic-item-wrap` cards. */
export function parseListHtml(html) {
  const chunks = cardWindows(html, /<div[^>]*class="[^"]*list-comic-item-wrap[^"]*"/gi, { max: 4000 });
  const items = [];
  for (const card of chunks) {
    const href = (card.match(/<a[^>]*class="[^"]*list-story-item[^"]*"[^>]*href="([^"]+)"/i) || [])[1]
      || (card.match(/href="([^"]*\/manga\/[^"]+)"/i) || [])[1]
      || "";
    const slug = slugFromUrl(href);
    if (!slug) continue;
    const imgTag = (card.match(/<img\b[^>]*>/i) || [])[0] || "";
    const poster = absolute(
      (imgTag.match(/\bdata-src="([^"]+)"/i) || [])[1] || (imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || ""
    );
    const title = cardTitle(card, (imgTag.match(/alt="([^"]+)"/i) || [])[1] || "");
    const chapterHref = (card.match(/class="[^"]*list-story-item-wrap-chapter[^"]*"[^>]*href="([^"]+)"/i) || [])[1]
      || (card.match(/href="([^"]*\/chapter-[^"]+)"/i) || [])[1]
      || "";
    const latestChapter = decodeEntities(
      (card.match(/class="[^"]*list-story-item-wrap-chapter[^"]*"[^>]*title="([^"]+)"/i) || [])[1] ||
        (card.match(/class="[^"]*list-story-item-wrap-chapter[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
        ""
    );
    const views = decodeEntities((card.match(/class="[^"]*aye_icon[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "");
    const summary = stripTags((card.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "");
    items.push({
      slug,
      title: title || slug.replace(/-/g, " "),
      poster,
      thumbPath: thumbPath(poster),
      latestChapter: latestChapter || (chapterHref ? `Chapter ${chapterNumber(chapterHref)}` : ""),
      latestChapterSlug: chapterHref ? chapterHref.split("/").pop() : "",
      views,
      summary,
    });
  }
  return items;
}

/** Pagination footer: `.group_page` links carry the last page number. */
function parseTotalPages(html) {
  const start = html.search(/class="[^"]*group_page[^"]*"/i);
  if (start < 0) return 1;
  const region = html.slice(start, start + 4000);
  let max = 1;
  for (const m of region.matchAll(/[?&]page=(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const LIST_PATHS = {
  latest: "/manga-list/latest-manga",
  hot: "/manga-list/hot-manga",
  new: "/manga-list/new-manga",
  completed: "/manga-list/completed-manga",
};

const sanitizeSlug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
/** Popular carousel + latest releases for the manga landing view. */
export async function mangaHome() {
  return cached("manga:home", TTL_PAGE, async () => {
    // MangaDex powers the landing rows directly — no reader hop, no shared-IP
    // rate limit. The scraped homepage needs the reader from production
    // egress, so it only runs when the API is unavailable.
    try {
      return await mdxHome();
    } catch {
      const html = await fetchPage(`${SITE}/`, { minLength: 20000 });
      return parseHomeHtml(html);
    }
  });
}

/** Pure parser for the landing page, so it can be tested without the network. */
export function parseHomeHtml(html) {
  {
    const popular = [];
    const carouselStart = html.search(/class="[^"]*owl-carousel[^"]*"/i);
    if (carouselStart >= 0) {
      // Bound to the carousel's own element: a fixed-size window runs on into
      // the "latest releases" and "most popular" lists, whose cards reuse the
      // same `item` class and would leak into the popular row.
      const carouselOpen = html.lastIndexOf("<", carouselStart);
      const carousel = html.slice(carouselOpen, elementExtent(html, carouselOpen));
      for (const card of cardWindows(carousel, /<div[^>]*class="[^"]*\bitem\b[^"]*"/gi, { max: 1200 })) {
        const href = (card.match(/href="([^"]*\/manga\/[^"]+)"/i) || [])[1] || "";
        const slug = slugFromUrl(href);
        if (!slug) continue;
        const imgTag = (card.match(/<img\b[^>]*>/i) || [])[0] || "";
        const poster = absolute((imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || "");
        const title = cardTitle(card, (imgTag.match(/alt="([^"]+)"/i) || [])[1] || "");
        const chapterHref = (card.match(/href="([^"]*\/chapter-[^"]+)"/i) || [])[1] || "";
        if (popular.some((p) => p.slug === slug)) continue;
        popular.push({
          slug,
          title: title || slug.replace(/-/g, " "),
          poster,
          thumbPath: thumbPath(poster),
          latestChapter: chapterHref ? `Chapter ${chapterNumber(chapterHref)}` : "",
          latestChapterSlug: chapterHref ? chapterHref.split("/").pop() : "",
        });
      }
    }

    const latest = [];
    const updatesStart = html.search(/id="contentstory"/i);
    if (updatesStart >= 0) {
      const updatesOpen = html.lastIndexOf("<", updatesStart);
      const region = html.slice(updatesOpen, elementExtent(html, updatesOpen));
      for (const card of cardWindows(region, /<div[^>]*class="[^"]*itemupdate[^"]*"/gi, { max: 2600 })) {
        const href = (card.match(/<a[^>]*href="([^"]*\/manga\/[^"]+)"/i) || [])[1] || "";
        const slug = slugFromUrl(href);
        if (!slug) continue;
        const imgTag = (card.match(/<img\b[^>]*>/i) || [])[0] || "";
        const poster = absolute(
          (imgTag.match(/\bdata-src="([^"]+)"/i) || [])[1] || (imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || ""
        );
        const title = cardTitle(card, (imgTag.match(/alt="([^"]+)"/i) || [])[1] || "");
        const chapters = [];
        for (const m of card.matchAll(/href="([^"]*\/chapter-[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
          const name = decodeEntities(m[2]) || `Chapter ${chapterNumber(m[1])}`;
          if (chapters.length >= 3) break;
          chapters.push({ slug: m[1].split("/").pop(), name });
        }
        if (latest.some((x) => x.slug === slug)) continue;
        latest.push({
          slug,
          title: title || slug.replace(/-/g, " "),
          poster,
          thumbPath: thumbPath(poster),
          chapters,
          latestChapter: chapters[0]?.name || "",
          latestChapterSlug: chapters[0]?.slug || "",
        });
      }
    }

    const genres = [];
    for (const m of html.matchAll(/href="(?:https:\/\/www\.mangakakalot\.gg)?\/genre\/([a-z0-9-]+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = decodeEntities(m[2]).trim();
      if (!name || name.length > 24) continue;
      if (genres.some((g) => g.slug === m[1])) continue;
      genres.push({ slug: m[1], name });
      if (genres.length >= 40) break;
    }

    return { popular, latest, genres };
  }
}

/** Search: `.panel_story_list .story_item`. */
/** Mangakakalot search (reader-backed) — the fallback for anything the
 * MangaDex API does not carry. */
async function mangakakalotSearch(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const key = q.toLowerCase();
  return cached(`manga:search:${key}`, TTL_PAGE, async () => {
    const html = await fetchPage(`${SITE}/search/story/${encodeURIComponent(q.replace(/\s+/g, "_"))}`, {
      minLength: 5000,
      expect: /story_item/i,
    });
    return parseSearchHtml(html);
  });
}

export async function mangaSearch(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  // MangaDex's official API first — no challenge page, no reader hop, no
  // shared-IP rate limit, so it answers in a second from Workers egress.
  // The mangakakalot reader path is the fallback for titles it does not
  // carry (and when the API errors).
  try {
    const hits = await mdxSearch(q);
    if (Array.isArray(hits) && hits.length) return hits;
  } catch {
    // fall through to the mangakakalot path
  }
  return mangakakalotSearch(q);
}

/** Pick the closest mangakakalot title by normalized token overlap. */
function bestTitleMatch(title, items) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
      .replace(/\b(?:hindi|dubbed|dub|sub|eng|english|org|multi|season|part|\d+(?:st|nd|rd|th))?\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const target = new Set(norm(title).split(" ").filter((w) => w.length > 1));
  if (!target.size) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items || []) {
    const tokens = new Set(norm(item.title).split(" ").filter((w) => w.length > 1));
    if (!tokens.size) continue;
    let common = 0;
    for (const w of target) if (tokens.has(w)) common++;
    const score = common / Math.max(target.size, tokens.size);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** Pure parser for a /search/story/<term> page. */
export function parseSearchHtml(html) {
  {
    const items = [];
    for (const card of cardWindows(html, /<div[^>]*class="[^"]*\bstory_item\b[^"]*"/gi, { max: 3000 })) {
      const href = (card.match(/href="([^"]*\/manga\/[^"]+)"/i) || [])[1] || "";
      const slug = slugFromUrl(href);
      if (!slug || items.some((i) => i.slug === slug)) continue;
      const imgTag = (card.match(/<img\b[^>]*>/i) || [])[0] || "";
      const poster = absolute(
        (imgTag.match(/\bdata-src="([^"]+)"/i) || [])[1] || (imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || ""
      );
      const title = cardTitle(card, (imgTag.match(/alt="([^"]+)"/i) || [])[1] || "");
      const chapterHref = (card.match(/class="[^"]*story_chapter[^"]*"[\s\S]*?href="([^"]+)"/i) || [])[1]
        || (card.match(/href="([^"]*\/chapter-[^"]+)"/i) || [])[1]
        || "";
      // The right block carries "<title> Chapter N Author(s) : X Updated : …
      // View : N" on this page, so the metadata is pulled out by label and the
      // rest is only kept when it reads like a synopsis.
      const meta = stripTags((card.match(/class="[^"]*story_item_right[^"]*"([\s\S]*)$/i) || [])[1] || "");
      const metaAuthor = decodeEntities((meta.match(/author\(s\)\s*:?\s*([\s\S]*?)(?=\s*(?:updated|view)\s*:|$)/i) || [])[1] || "");
      const metaViews = decodeEntities((meta.match(/view\s*:?\s*([\d,.]+)/i) || [])[1] || "");
      const metaUpdated = decodeEntities((meta.match(/updated\s*:?\s*([A-Za-z]{3}-\d{2}-\d{4}[\s\S]*?)(?=\s*view\s*:|$)/i) || [])[1] || "");
      items.push({
        slug,
        title: title || slug.replace(/-/g, " "),
        poster,
        thumbPath: thumbPath(poster),
        latestChapter: chapterHref ? `Chapter ${chapterNumber(chapterHref)}` : "",
        latestChapterSlug: chapterHref ? chapterHref.split("/").pop() : "",
        author: metaAuthor,
        views: metaViews,
        updatedAt: metaUpdated,
      });
    }
    return items.slice(0, 40);
  }
}

/** Browse list (`latest|hot|new|completed`) or one genre; both are paginated. */
export async function mangaBrowse({ type = "latest", genre = "", page = 1 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const g = genre ? sanitizeSlug(genre) : "";
  const path = g ? `/genre/${g}` : LIST_PATHS[type] || LIST_PATHS.latest;
  const key = `manga:browse:${g || type}:${p}`;
  return cached(key, TTL_PAGE, async () => {
    // MangaDex list API first (genre slugs it does not carry throw and fall
    // through). The scraped list pages below need the rate-limited reader
    // from production egress, so they are the fallback, not the default.
    try {
      return await mdxBrowse({ type, genre: g, page: p });
    } catch {
      // fall through to the mangakakalot path
    }
    const html = await fetchPage(`${SITE}${path}?page=${p}`, { minLength: 5000, expect: /list-comic-item-wrap|list-story-item/i });
    const items = parseListHtml(html);
    const titleMatch = /<title>\s*([^<]{2,120})/i.exec(html);
    return {
      type: g ? "genre" : type,
      genre: g || null,
      page: p,
      totalPages: parseTotalPages(html),
      heading: debrand(titleMatch ? titleMatch[1].split("|")[0] : "") || (g ? g : type),
      items,
    };
  });
}

/** Genres index — MangaDex tags first, /genre/all scraped as the fallback. */
export async function mangaGenres() {
  return cached("manga:genres", 6 * 60 * 60 * 1000, async () => {
    try {
      const tags = await mdxTags();
      if (tags.length) return tags.map((t) => ({ slug: t.slug, name: t.name }));
    } catch {
      // fall through to the scraped index
    }
    const home = await mangaHome();
    if (home?.genres?.length) return home.genres;
    const html = await fetchPage(`${SITE}/genre/all`, { minLength: 5000 });
    const genres = [];
    for (const m of html.matchAll(/href="(?:https:\/\/www\.mangakakalot\.gg)?\/genre\/([a-z0-9-]+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = decodeEntities(m[2]).trim();
      if (!name || name.length > 24 || genres.some((g) => g.slug === m[1])) continue;
      genres.push({ slug: m[1], name });
    }
    return genres;
  });
}

/** Chapter JSON rows -> the list shape the UI renders, newest first. */
function rowsToChapters(rows, slug) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const slugVal = String(row?.chapter_slug || "").replace(/[^a-z0-9.-]/gi, "");
      return {
        slug: slugVal,
        number: String(row?.chapter_num ?? chapterNumber(slugVal)),
        name: decodeEntities(row?.chapter_name || "") || `Chapter ${row?.chapter_num ?? ""}`,
        updatedAt: row?.updated_at || "",
        views: row?.view ?? null,
        url: slugVal ? `${SITE}/manga/${slug}/${slugVal}` : "",
      };
    })
    .filter((c) => c.slug)
    .sort((a, b) => Number(b.number) - Number(a.number));
}

/** Detail page + the chapter list from the JSON endpoint. */
export async function mangaInfo(slugInput) {
  const slug = sanitizeSlug(slugInput);
  if (!slug) return null;
  // "md-<uuid>" slugs come from MangaDex search results. When MangaDex has
  // the title but no readable English chapters (most mainstream series are
  // external-link-only after the takedowns), the same title is resolved on
  // mangakakalot so the reader still works end to end.
  if (slug.startsWith("md-")) {
    return cached(`manga:info:${slug}`, TTL_CHAPTERS, async () => {
      const info = await mdxInfo(slug);
      if (!info) return null;
      // A handful of surviving chapters (stray volumes after takedowns) is
      // not a usable chapter list for a mainstream title — bridge instead.
      if (info.chapters.length >= 5) return info;

      // Fast bridge: the chapters JSON endpoint is NOT challenged from
      // Workers egress (verified with /api/diag — unlike the HTML pages) and
      // mainstream titles use plain lowercased-hyphenated slugs, so the full
      // chapter list resolves directly in a second while MangaDex keeps its
      // own metadata and covers. The reader-backed search below stays as the
      // fallback for titles whose slug differs from their title.
      try {
        const guess = sanitizeSlug(
          String(info.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        );
        if (guess) {
          const payload = await fetchChaptersJson(guess, { fallbackToReader: false });
          const chapters = rowsToChapters(payload?.data?.chapters, guess);
          if (chapters.length >= 5) {
            return {
              ...info,
              slug: guess,
              chapters,
              totalChapters: chapters.length,
              latestChapter: chapters[0]?.name || "",
              latestChapterSlug: chapters[0]?.slug || "",
              firstChapterSlug: chapters[chapters.length - 1]?.slug || "",
            };
          }
        }
      } catch {
        // Wrong guess (slug differs from the title) or endpoint hiccup —
        // fall through to the reader-backed search.
      }

      const match = bestTitleMatch(info.title, await mangakakalotSearch(info.title).catch(() => []));
      if (match?.slug) {
        const bridged = await mangaInfo(match.slug).catch(() => null);
        if (bridged?.chapters?.length) return bridged;
      }
      return info; // metadata only — honest empty chapter list
    });
  }
  return cached(`manga:info:${slug}`, TTL_CHAPTERS, async () => {
    const [html, chaptersPayload] = await Promise.all([
      fetchPage(`${SITE}/manga/${slug}`, { minLength: 5000, expect: /manga-info-top/i, archive: true }),
      fetchChaptersJson(slug).catch(() => null),
    ]);

    const base = parseInfoHtml(html);

    const chapters = rowsToChapters(chaptersPayload?.data?.chapters, slug);

    return {
      ...base,
      slug,
      title: base.title || slug.replace(/-/g, " "),
      chapters,
      totalChapters: chapters.length,
      latestChapter: chapters[0]?.name || "",
      latestChapterSlug: chapters[0]?.slug || "",
      firstChapterSlug: chapters[chapters.length - 1]?.slug || "",
    };
  });
}

/** Pure parser for the /manga/<slug> detail page. */
export function parseInfoHtml(html) {
  const infoStart = html.search(/class="manga-info-top"/i);
  const infoHtml = infoStart >= 0 ? html.slice(infoStart, infoStart + 60000) : html;

  const imgTag = (infoHtml.match(/class="manga-info-pic"[\s\S]{0,400}?<img\b[^>]*>/i) || [])[0] || "";
  const poster = absolute(
    (imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || (imgTag.match(/\bdata-src="([^"]+)"/i) || [])[1] || ""
  );
  const title = debrand(
    (infoHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
      (html.match(/<title>\s*([^<|]{2,120})/i) || [])[1] ||
      ""
  );
  const alternative = decodeEntities(
    (infoHtml.match(/class="[^"]*story-alternative[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || ""
  ).replace(/^alternative\s*:\s*/i, "");
  const field = (label) => {
    const re = new RegExp(`<li[^>]*>[^<]*${label}[^<:]*:?([\\s\\S]{0,160}?)<\\/li>`, "i");
    return decodeEntities((infoHtml.match(re) || [])[1] || "");
  };
  const author = field("author\\(s\\)");
  const status = field("status");
  const lastUpdated = field("last\\s*updated");
  const views = field("view") || decodeEntities((infoHtml.match(/class="[^"]*aye_icon[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "");
  const rating = decodeEntities((infoHtml.match(/itemprop="ratingValue"[^>]*content="([^"]+)"/i) || [])[1] || "");

  // Genres sit in their own `.genres-wrap` block, which the source places
  // *before* `.manga-info-top`, so this is parsed against the whole page.
  const genres = [];
  const genreStart = html.search(/class="[^"]*genres-wrap[^"]*"/i);
  if (genreStart >= 0) {
    const region = html.slice(genreStart, genreStart + 8000);
    const end = region.search(/<\/(?:div|section)>\s*<\/(?:div|section)>/i);
    const scope = end > 0 ? region.slice(0, end) : region;
    for (const m of scope.matchAll(/href="[^"]*\/genre\/([a-z0-9-]+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = decodeEntities(m[2]).trim();
      if (!name || name.length > 24) continue;
      if (genres.some((g) => g.slug === m[1])) continue;
      genres.push({ slug: m[1], name });
    }
  }
  const tags = [];
  const tagStart = html.search(/class="[^"]*tags-wrap[^"]*"/i);
  if (tagStart >= 0) {
    const region = html.slice(tagStart, tagStart + 6000);
    for (const m of region.matchAll(/<a[^>]*>([\s\S]{1,40}?)<\/a>/gi)) {
      const name = decodeEntities(m[1]);
      if (!name || name.length > 24 || tags.includes(name)) continue;
      tags.push(name);
      if (tags.length >= 20) break;
    }
  }

  let description = stripTags((html.match(/id="contentBox"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
  description = description.replace(/^[A-Za-z0-9'’:\-\s]{3,80}?summary\s*:\s*/i, "").trim();

  return {
    title,
    alternative,
    poster,
    thumbPath: thumbPath(poster),
    author,
    status,
    lastUpdated,
    views,
    rating,
    genres,
    tags,
    description,
  };
}

/** One chapter: page images plus prev/next from the neighbouring chapters. */
export async function mangaChapter(slugInput, chapterInput) {
  const slug = sanitizeSlug(slugInput);
  const chapter = String(chapterInput || "").replace(/[^a-z0-9.-]/gi, "");
  if (!slug || !chapter) return null;
  if (slug.startsWith("md-")) return mdxChapter(slug, chapter);
  return cached(`manga:chapter:${slug}:${chapter}`, TTL_CHAPTERS, async () => {
    const [html, info] = await Promise.all([
      fetchPage(`${SITE}/manga/${slug}/${chapter}`, { minLength: 5000, expect: /container-chapter-reader/i, archive: true }),
      mangaInfo(slug).catch(() => null),
    ]);

    const found = parseChapterHtml(html);
    const number = chapterNumber(chapter);
    const list = Array.isArray(info?.chapters) ? info.chapters : [];
    const idx = list.findIndex((c) => c.slug === chapter);
    const nextUp = idx >= 0 && idx - 1 >= 0 ? list[idx - 1] : null; // newer chapter
    const prev = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null; // older chapter
    const heading = decodeEntities(
      (html.match(/class="[^"]*current-chapter[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] ||
        (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] ||
        ""
    );

    return {
      slug,
      chapter,
      number,
      heading,
      title: info?.title || slug.replace(/-/g, " "),
      poster: info?.poster || "",
      images: found.map((img) => ({
        raw: img.raw,
        mirror: img.mirror,
        alt: img.alt,
      })),
      pages: found.length,
      prevChapter: prev ? { slug: prev.slug, name: prev.name } : null,
      nextChapter: nextUp ? { slug: nextUp.slug, name: nextUp.name } : null,
      chapters: list.map((c) => ({ slug: c.slug, name: c.name, number: c.number })),
    };
  });
}

/**
 * Stream one page image. The CDN rejects any request without a mangakakalot.gg
 * Referer, so the browser cannot load these URLs directly.
 */
export async function proxyMangaImage(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("image url required");
  // Only page art / thumbnails from this source, never an arbitrary host.
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("invalid image url");
  }
  if (!CDN_HOSTS.test(host) && !/mangakakalot|2xstorage|waitst|mangadex/i.test(host)) {
    throw new Error("image host not allowed");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      // MangaDex's CDN answers a foreign (mangakakalot) Referer with its
      // "You can read this at MANGADEX" placeholder image — every cover on
      // /manga came back as that same JPEG. Send each host its own Referer.
      Referer: /mangadex/i.test(host) ? "https://mangadex.org/" : `${SITE}/`,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`image -> ${res.status}`);
  const type = res.headers.get("content-type") || "image/webp";
  if (!/^image\//i.test(type)) throw new Error("not an image");
  return {
    stream: res.body,
    contentType: type,
    contentLength: res.headers.get("content-length"),
  };
}

export const MANGA_SOURCE = { site: SITE, listPaths: LIST_PATHS };
