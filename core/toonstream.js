// Hindi per-episode source — ToonStream (toonstream.dad).
//
// Why this source: gokuhd publishes one whole-season file per post, so episodes
// 2..N have no source there at all. ToonStream publishes one page per episode
// with several embed servers, which is what a real Hindi episode list needs.
//
// Catalog shape (WordPress):
//   search    https://toonstream.dad/?s=<query>            -> #aa-movies li.series
//   series    https://toonstream.dad/series/<slug>/         (title, poster, meta)
//   episode   https://toonstream.dad/episode/<slug>-<S>x<E>/
//             -> #episode_by_temp li   (episode list: .num-epi, .entry-title, img)
//             -> .aa-cnt li a          (season links, data-season)
//             -> #aa-options > div.video  (servers: id="options-N" + iframe src)
//
// The servers are third-party embed players (rubystm, filesforever, ...), not
// direct MP4/HLS files, so the player consumes them through its iframe path.
//
// Network note: toonstream.dad is DNS-sinkholed on some Indian ISPs — it resolves
// to the ISP sinkhole 2405:200:1607:2820:41::36 and the TLS handshake is reset,
// so a plain fetch can never reach it there. Every request therefore falls back
// to the r.jina.ai reader, which returns the page's raw HTML when asked with
// `x-respond-with: html` (verified against the live site). Set
// TOONSTREAM_PROXY=off to disable the fallback.

const SITE = "https://toonstream.dad";
const READER = "https://r.jina.ai/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const DIRECT_TIMEOUT = 12000;
const PROXY_TIMEOUT = 30000;

const TTL_PAGE = 30 * 60 * 1000;
const TTL_STREAM = 45 * 60 * 1000;

const CACHE = new Map();
const CACHE_MAX = 300;

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

async function cached(key, ttl, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  try {
    return cacheSet(key, await loader(), ttl);
  } catch {
    return cacheSet(key, null, 60 * 1000);
  }
}

const proxyEnabled = () => String(process.env.TOONSTREAM_PROXY || "on").toLowerCase() !== "off";

/**
 * Fetch a toonstream.dad page. Direct first; when the ISP sinkholes the domain
 * (fetch throws or answers non-OK) the reader proxy supplies the same HTML.
 */
async function fetchPage(url, { timeout = DIRECT_TIMEOUT, minLength = 500 } = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `${SITE}/`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const html = await res.text();
      if (html && html.length >= minLength) return html;
    }
  } catch {
    // fall through to the proxy
  }

  if (!proxyEnabled()) throw new Error(`toonstream unreachable: ${url}`);
  const res = await fetch(`${READER}${url}`, {
    headers: { "User-Agent": UA, "x-respond-with": "html", Accept: "text/plain" },
    signal: AbortSignal.timeout(PROXY_TIMEOUT),
  });
  if (!res.ok) throw new Error(`toonstream proxy -> ${res.status}`);
  const html = await res.text();
  if (!html || html.length < minLength) throw new Error("toonstream proxy returned no page");
  return html;
}

function decodeEntities(input) {
  return String(input || "")
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
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

/** Absolute-ise protocol-relative and root-relative URLs. */
function absolute(url) {
  const u = decodeEntities(url);
  if (!u) return "";
  if (u.startsWith("//")) return `https:${u}`;
  if (u.startsWith("/")) return `${SITE}${u}`;
  return u;
}

// Search rows link to either /series/<slug> or /movies/<slug>; the old
// series-only pattern turned every movie hit into a slug like
// "/movies/foo" that no detail page could resolve.
const slugFromHref = (href) => {
  const m = /^\/?(?:series|movies)\/([^/?#]+)\/?/i.exec(String(href || "").trim());
  return m ? m[1].toLowerCase() : "";
};

/**
 * Search results: [{ title, slug, poster }].
 * The site's own search box calls /search/all?q=, which answers JSON
 * (`{ count, data: [{ title, type, url }] }`) rather than the WordPress `?s=`
 * page — that URL serves the homepage. The reader proxy hands the JSON back
 * wrapped in a <pre>, so unwrap before parsing.
 */
export async function searchToonstream(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  return cached(`toon:search:${q.toLowerCase()}`, TTL_PAGE, async () => {
    // Search is the latency-critical path and the site is DNS-sinkholed on
    // many ISPs, so the direct attempt gets a short leash before the reader
    // proxy answers: a full 12s direct timeout made every cold search take
    // 12s+ and the Hindi search endpoint's own cap then dropped its rows.
    const raw = await fetchPage(`${SITE}/search/all?q=${encodeURIComponent(q)}`, { timeout: 4000, minLength: 20 });
    const jsonText = (() => {
      const trimmed = raw.trim();
      if (trimmed.startsWith("{")) return trimmed;
      const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(raw);
      return pre ? decodeEntities(pre[1]) : trimmed;
    })();

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch {}
    const rows = Array.isArray(parsed?.data) ? parsed.data : [];

    return rows
      .map((row) => ({
        title: decodeEntities(row?.title || ""),
        slug: slugFromHref(row?.url),
        poster: "",
        type: String(row?.type || ""),
      }))
      .filter((row) => row.title && row.slug);
  });
}

/**
 * One season of a series: the episode list plus every season the page links.
 * Returns { episodes: [{ episode, season, title, image, url }], seasons: [n...],
 * title, poster }.
 *
 * Episode lists live on the SERIES page (and on its per-season fragment), not
 * on a constructed /episode/<slug>-SxE/ URL. Series slugs carry a suffix the
 * episode URLs drop — "naruto-shippuden-hindi-dub" lists episodes as
 * /episode/naruto-shippuden-1x1/ — so the old constructed URL answered 404 and
 * every ToonStream title came back with no episodes at all. Each row's own
 * href is the only reliable episode address, so it is parsed and kept.
 */
export async function fetchToonstreamEpisodes(slug, season = 1) {
  const clean = String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const se = Math.max(1, Number(season) || 1);
  if (!clean) return null;
  return cached(`toon:eps:${clean}:${se}`, TTL_PAGE, async () => {
    // The series page carries the season buttons and one season's episodes;
    // /series/<slug>/season/<n> is the fragment the page itself loads for the
    // other seasons (always fetched with that XHR header).
    const fetchList = async (url) => {
      const html = await fetchPage(url, { minLength: 400 });
      return { html, region: episodeRegion(html) };
    };
    let html = "";
    let region = "";
    if (se === 1) {
      ({ html, region } = await fetchList(`${SITE}/series/${clean}/`));
    } else {
      try {
        ({ html, region } = await fetchList(`${SITE}/series/${clean}/season/${se}`));
      } catch {
        ({ html, region } = await fetchList(`${SITE}/series/${clean}/`));
      }
    }

    const episodes = [];
    for (const chunk of region.split(/<li[\s>]/i).slice(1)) {
      const code = /class="[^"]*num-epi[^"]*"[^>]*>\s*(\d{1,2})\s*x\s*(\d{1,4})/i.exec(chunk);
      if (!code) continue;
      const sNum = Number(code[1]);
      const eNum = Number(code[2]);
      if (sNum !== se) continue;
      const rawTitle = (chunk.match(/class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/(?:h\d|span|div|p)>/i) || [])[1] || "";
      const imgTag = (chunk.match(/<img[^>]*>/i) || [])[0] || "";
      const image = absolute((imgTag.match(/(?:data-src|data-lazy-src|data-original|src)="([^"]+)"/i) || [])[1] || "");
      const href = (chunk.match(/href="(\/episode\/[^"]+)"/i) || [])[1] || "";
      episodes.push({
        season: sNum,
        episode: eNum,
        title: decodeEntities(rawTitle) || `Episode ${eNum}`,
        image,
        url: absolute(href),
      });
    }
    episodes.sort((a, b) => a.episode - b.episode);

    const seasons = new Set();
    for (const m of html.matchAll(/data-season="(\d{1,2})"/gi)) seasons.add(Number(m[1]));
    if (!seasons.size) seasons.add(se);

    // Series name for a detail panel that has no search row to borrow from.
    const rawTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const title = decodeEntities(rawTitle).replace(/\s*[-–|]\s*ToonStream\s*$/i, "").replace(/\s+Series\s*$/i, "").trim();

    return {
      episodes,
      seasons: [...seasons].sort((a, b) => a - b),
      title,
      poster: episodes[0]?.image || "",
    };
  });
}

function episodeRegion(html) {
  const start = html.search(/id="episode_by_temp"/i);
  if (start < 0) return "";
  const end = html.indexOf("</ul>", start);
  return html.slice(start, end > 0 ? end : start + 200000);
}

/** Embed servers for one episode: [{ server, embedUrl }]. */
export async function fetchToonstreamStreams(slug, season = 1, episode = 1) {
  const clean = String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const se = Math.max(1, Number(season) || 1);
  const ep = Math.max(1, Number(episode) || 1);
  if (!clean) return [];
  return cached(`toon:stream:${clean}:${se}:${ep}`, TTL_STREAM, async () => {
    // The episode's own link is authoritative (series slugs and episode slugs
    // differ); the constructed URL stays as the fallback for the simple slugs
    // where both shapes are the same.
    const list = await fetchToonstreamEpisodes(clean, se).catch(() => null);
    const row = (list?.episodes || []).find((e) => e.episode === ep);
    const pageUrl = row?.url || `${SITE}/episode/${clean}-${se}x${ep}/`;
    const html = await fetchPage(pageUrl);
    const start = html.search(/id="aa-options"/i);
    if (start < 0) return [];
    const region = html.slice(start, start + 40000);

    const servers = [];
    for (const chunk of region.split(/<div[^>]*class="[^"]*(?:video|aa-tb)[^"]*"/i).slice(1)) {
      const id = (chunk.match(/^(?:[^>]*?)id="([^"]+)"/i) || [])[1] || "";
      const iframe = (chunk.match(/<iframe[^>]*>/i) || [])[0] || "";
      const src = absolute((iframe.match(/(?:data-src|src)="([^"]+)"/i) || [])[1] || "");
      if (!src || !/^https?:\/\//i.test(src)) continue;
      servers.push({ server: id || `options-${servers.length}`, embedUrl: src });
    }
    return servers;
  });
}

// A page that only offers a play button still needs the viewer's click, so it
// ranks below one that already carries a player. Hosts that bounce to an ad farm
// are treated as dead rather than offered.
const AD_HOSTS = /(iqsmartgames|adsterra|popads|propellerads)/i; // No provider names or ad markers are surfaced to the player.
const EMBED_PROBE_TIMEOUT = 9000;
const TTL_PROBE = 12 * 60 * 1000;
const PROBE_LIMIT = 6;

async function probeEmbed(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", Referer: `${SITE}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(EMBED_PROBE_TIMEOUT),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    if (AD_HOSTS.test(res.url || url)) return { ok: false, reason: "redirects to an ad host" };
    const xfo = String(res.headers.get("x-frame-options") || "").toLowerCase();
    if (xfo.includes("deny") || xfo.includes("sameorigin")) return { ok: false, reason: "refuses to be embedded" };

    const html = (await res.text()).slice(0, 240000);
    if (!html || html.length < 200) return { ok: false, reason: "empty page" };
    const hasVideoTag = /<video[\s>]/i.test(html);
    const hasPlayer = /(jwplayer|hls\.js|videojs|<iframe|sources\s*:|["']file["']\s*:|\.m3u8|\.mp4)/i.test(html);
    if (!hasVideoTag && !hasPlayer) return { ok: false, reason: "no player found" };

    // Many of these hosts (rubystm and friends) build a jwplayer/videojs
    // instance from a direct file they hide in the page's own script. Pulling
    // that file out lets the site's own player (hls.js / <video>) play the
    // episode instead of framing someone else's player page — which is what a
    // viewer asking for "our player" actually sees today.
    const files = [];
    const seenFile = new Set();
    const pushFile = (raw) => {
      const u = decodeEntities(String(raw || "")).trim().replace(/\\\//g, "/");
      if (!/^https?:\/\//i.test(u)) return;
      const kind = /\.m3u8(\?|#|$)/i.test(u) ? "hls" : (/\.mp4(\?|#|$)/i.test(u) ? "mp4" : "");
      if (!kind) return;
      const key = u.split("#")[0];
      if (seenFile.has(key)) return;
      seenFile.add(key);
      files.push({ url: key, kind });
    };
    for (const m of html.matchAll(/["']file["']\s*:\s*["']([^"']+)["']/gi)) pushFile(m[1]);
    for (const m of html.matchAll(/["']source(?:s)?["']?\s*:\s*["']([^"']+)["']/gi)) pushFile(m[1]);
    for (const m of html.matchAll(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/gi)) pushFile(m[0]);
    for (const m of html.matchAll(/https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi)) pushFile(m[0]);

    return { ok: true, hasVideoTag, files };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * Servers for one episode, best first. Every candidate is checked server-side so
 * the player can present one working source and keep the rest as silent
 * failover instead of listing mirrors that do not play.
 * Returns { primary: {server, embedUrl} | null, alternates: [...], probed: n }.
 */
export async function fetchBestToonstreamServer(slug, season = 1, episode = 1) {
  const servers = await fetchToonstreamStreams(slug, season, episode).catch(() => []);
  if (!servers.length) return { primary: null, alternates: [], probed: 0 };

  const clean = String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const se = Math.max(1, Number(season) || 1);
  const ep = Math.max(1, Number(episode) || 1);
  const outcome = await cached(`toon:probe:${clean}:${se}:${ep}`, TTL_PROBE, async () => {
    const candidates = servers.slice(0, PROBE_LIMIT);
    const probed = await Promise.all(candidates.map(async (s) => ({ ...s, probe: await probeEmbed(s.embedUrl) })));
    // A page with its own <video> element needs no click; click-to-play hosts
    // (rubystm and friends) follow.
    const rank = (entry) => (entry.probe.ok ? (entry.probe.hasVideoTag ? 2 : 1) : 0);
    probed.sort((a, b) => rank(b) - rank(a));
    return { ordered: probed, working: probed.filter((p) => p.probe.ok).length };
  });    const ordered = outcome?.ordered?.length ? outcome.ordered : servers.map((s) => ({ ...s }));
    const best = ordered[0]?.probe?.ok ? ordered[0] : null;
    const list = best ? ordered : servers.map((s) => ({ ...s }));
    const head = list[0] || null;
    if (head && Array.isArray(head.probe?.files) && head.probe.files.length) {
      head.direct = head.probe.files[0];
    }
    return {
      primary: head,
      alternates: list.slice(1),
      probed: outcome?.working ?? 0,
    };
}

/**
 * Pick the ToonStream series that matches a Hindi title. Prefers an exact
 * normalized match, then a prefix match ("Fairy Tail" vs "Fairy Tail (Season
 * 1 - 8)"), so a season-pack post still finds its per-episode counterpart.
 */
export async function findToonstreamSeries(title) {
  const query = String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:hindi|dubbed|dub|org|dual|audio|multi|bluray|blu|ray|web|dl|webrip|hdtv|hdrip|batch|series|movie|episode)s?\b/gi, " ")
    .replace(/\b(?:1080p|720p|480p|360p|2160p|4k|10bit|x264|x265|hevc|avc)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!query) return null;

  const normalize = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\b(?:hindi|dubbed|dub|season|series|all|part|the)\b/gi, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const want = normalize(query);
  const results = await searchToonstream(query).catch(() => []);
  if (!results.length) return null;

  // Never fall back to "the first result": a search for a title the site does
  // not carry answers with unrelated shows, and playing those would be worse
  // than offering no episode-wise source at all.
  let best = null;
  for (const item of results) {
    const have = normalize(item.title);
    if (!have) continue;
    if (have === want) return item;
    if (have.startsWith(want) || want.startsWith(have)) {
      if (!best) best = item;
    }
  }
  return best;
}
