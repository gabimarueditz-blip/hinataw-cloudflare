// Hindi-dubbed anime source — GokuHD (gokuhd.com).
//
// Why this source: the original India feed (animeworld-india.me) is DNS-blocked
// on many Indian ISPs (it resolves to the ISP sinkhole 2405:200:1607:2820:41::36
// and never answers), so the Hindi rows rendered empty and /api/india/stream
// hung until timeout. gokuhd.com is reachable from the same network and carries
// a large, actively-updated Hindi-dubbed catalog (232 series + a movies index).
//
// Catalog shape (WordPress, GeneratePress theme):
//   listing   https://gokuhd.com/series/hindi-dubbed-series/page/N/
//             https://gokuhd.com/movies/hindi-dubbed-movies/page/N/
//   search    https://gokuhd.com/?s=<query>
//   post      https://gokuhd.com/<slug>/          (article: title, poster, score)
//
// Playback chain (verified end to end on 2026-10-13):
//   post HTML   -> "Download <Title> S0X {langs} 720p x264 [200MB/E]" blocks,
//                  each followed by 1-3 <a href="https://nexdrive.beer/...">
//   nexdrive    -> page lists <a href="https://fastdl.beer/embed.php?download=...">
//   fastdl      -> `var reurl = "https://fastdl.beer/dl.php?link=<DIRECT>"`
//   <DIRECT>    -> video-downloads.googleusercontent.com/...  => Content-Type
//                  video/mp4, no referer/cookie required, plays directly in the
//                  in-page <video> element (progressive MP4, not HLS).
//
// No external dependencies: plain fetch + regex parsing, with a small TTL cache
// so one page load never fans out to the source more than once per entry.

const SITE = "https://gokuhd.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const REQ_TIMEOUT = 15000;
const EMBED_TIMEOUT = 12000;

const TTL_CATALOG = 15 * 60 * 1000; // listing pages
const TTL_DETAIL = 30 * 60 * 1000; // post parse (links + seasons)
const TTL_STREAM = 45 * 60 * 1000; // resolved direct URL (token URLs expire)

// ---------------------------------------------------------------------------
// Tiny TTL cache. Keys are strings, values may be null (a cached failure) so a
// dead upstream is not re-hit on every request within the TTL window.
// ---------------------------------------------------------------------------
const CACHE = new Map();
const CACHE_MAX = 400;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.exp) {
    CACHE.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  if (CACHE.size >= CACHE_MAX) {
    // Drop the oldest entry (insertion order) to keep memory bounded.
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
    const value = await loader();
    return cacheSet(key, value, ttl);
  } catch {
    // Cache the failure briefly so a broken page does not stall every request.
    return cacheSet(key, null, 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchHtml(url, { referer = SITE + "/", timeout = REQ_TIMEOUT } = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: referer,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
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

/** Strip the SEO junk off a listing title so cards read cleanly. */
function cleanHindiTitle(raw) {
  let title = decodeEntities(raw);
  // Drop the site name the SEO title/og:title appends ("... - Gokuhd.Com").
  title = title.replace(/\s*[-|–]\s*Goku[\s-]?HD(?:\.Com)?\s*$/i, "");
  // Cut the bracketed " [S02 E02 Added | 2024 - 2026 | Anime Series]" suffix.
  // Some posts omit the " | " separator, so the keywords alone decide.
  const bracketNoise = /\s*(?:\|)?\s*\[[^\]]*(?:Added|Anime (?:Series|Movie)|\b(?:19|20)\d{2}\b|Season|Multi[\s-]?Audio|ORG)[^\]]*\]\s*$/i;
  for (let i = 0; i < 3; i++) {
    const before = title;
    title = title.replace(bracketNoise, "").trim();
    if (title === before) break;
  }
  // Drop a trailing " [ORG]" / " [Multi-Audio]" marker anywhere in the tail.
  title = title.replace(/\s*\[(?:ORG|Multi[\s-]?Audio)\]\s*/gi, " ");

  // Peel release/quality/dub descriptors off the end of the title, e.g.
  // "Death Note Relight (2008) Blu-Ray Hindi Dubbed" -> "Death Note Relight".
  // Loop because they stack ("... 1080p 720p HD", "... Blu-Ray Hindi Dubbed").
  const noise = /\s*(?:\(|\[)?\s*(?:\d{4}\s*[-–]\s*\d{4}|\d{4})\s*(?:\)|\])?\s*$|\s+(?:Blu-?Ray|WEB-?DL|HDTV|HDRip|WEBRip|HD|1080p|720p|480p|360p|2160p|4K|x264|x265|10Bit|HEVC|AVC|ORG|Hindi|Dubbed|Subbed|English|Japanese|Tamil|Telugu|Multi[\s-]?Audio|Anime (?:Series|Movie)|Movie|Series)\s*$/i;
  for (let i = 0; i < 12; i++) {
    const before = title;
    title = title.replace(noise, "").trim();
    title = title.replace(bracketNoise, "").trim();
    if (title === before) break;
  }
  // "(Blu-Ray 1080p 720p HD)" style parenthetical tails left mid-string.
  title = title.replace(/\s*[([][^)\]]*(?:1080p|720p|480p|Blu-?Ray|WEB-?DL|Dubbed)[^)\]]*[)\]]\s*/gi, " ");
  return decodeEntities(title).replace(/\s{2,}/g, " ").trim();
}

/** First production year (or a year range) found in a listing title. */
function extractYear(raw) {
  const text = decodeEntities(raw);
  const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return "";
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

// ---------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------
/**
 * Parse `<article id="post-N" class="... category-...">` cards from a listing
 * page. Each card carries the poster, poster-quality chip, IMDb score and the
 * post permalink/title, which is everything the Hindi rows render.
 */
function parseListingArticles(html, defaultType = "series") {
  const out = [];
  if (!html) return out;
  const articleRe = /<article\b[^>]*id="post-(\d+)"[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const postId = m[1];
    const classes = m[2] || "";
    const block = m[3];

    const link = (block.match(/<h[23][^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) || []);
    if (!link[1]) continue;
    const url = link[1];
    const rawTitle = link[2];

    const img = (block.match(/<img[^>]*class="[^"]*(?:wp-post-image|attachment)[^"]*"[^>]*src="([^"]+)"/i) ||
      block.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*(?:wp-post-image)[^"]*"/i) ||
      block.match(/<img[^>]*src="([^"]+)"/i) || [])[1];

    const score = (block.match(/class="imdb-score"[^>]*>\s*([\d.]+)/i) || [])[1];
    const posterQuality = (block.match(/class="poster-quality"[^>]*>\s*([^<]+)/i) || [])[1];

    const slug = url.replace(/\/+$/, "").split("/").pop();
    // Category classes are authoritative; the listing's default type is the
    // fallback for cards that carry no category at all.
    const movieCategory = /category-hindi-dubbed-movies|category-anime-movies/i.test(classes);
    const seriesCategory = /category-hindi-dubbed-series/i.test(classes);
    const isMovie = movieCategory || (!seriesCategory && defaultType === "movie");

    out.push({
      id: `goku:${slug}`,
      postId,
      slug,
      title: cleanHindiTitle(rawTitle),
      rawTitle: decodeEntities(rawTitle),
      image: img || "",
      year: extractYear(rawTitle),
      rating: score ? String(score) : "",
      quality: posterQuality ? decodeEntities(posterQuality) : "",
      type: isMovie ? "movie" : "series",
      url,
      source: "gokuhd.com",
    });
  }
  return out;
}

/** Highest page number linked on a listing page (WordPress /page/N/ links). */
function maxPageNumber(html) {
  if (!html) return 1;
  let max = 1;
  const re = /\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  // The rel="next" link is the reliable single-step signal when the pager only
  // prints a few numbers.
  const next = (html.match(/<link[^>]+rel="next"[^>]+href="([^"]+)"/i) || [])[1];
  if (next) {
    const nm = next.match(/\/page\/(\d+)\//);
    if (nm && Number(nm[1]) > max) max = Number(nm[1]);
    else if (!nm) max = Math.max(max, 2);
  }
  return max;
}

/** Total post count from the Rank Math twitter:data1 meta. */
function totalPostCount(html) {
  const m = (html || "").match(/name="twitter:data1"\s+content="(\d+)"/i);
  return m ? Number(m[1]) : 0;
}

export async function fetchHindiSeriesPage(page = 1) {
  const p = Math.max(1, Number(page) || 1);
  return cached(`goku:series:${p}`, TTL_CATALOG, async () => {
    const url = p === 1 ? `${SITE}/series/hindi-dubbed-series/` : `${SITE}/series/hindi-dubbed-series/page/${p}/`;
    const html = await fetchHtml(url);
    const items = parseListingArticles(html, "series").filter((it) => it.type === "series");
    return { items, itemsPerPage: items.length, totalPages: maxPageNumber(html), total: totalPostCount(html), page: p };
  });
}

export async function fetchHindiMoviesPage(page = 1) {
  const p = Math.max(1, Number(page) || 1);
  return cached(`goku:movies:${p}`, TTL_CATALOG, async () => {
    const url = p === 1 ? `${SITE}/movies/hindi-dubbed-movies/` : `${SITE}/movies/hindi-dubbed-movies/page/${p}/`;
    const html = await fetchHtml(url);
    const items = parseListingArticles(html, "movie");
    // The movies index also links series; keep only movie-typed cards.
    const movies = items.filter((it) => it.type === "movie");
    return {
      items: movies.length ? movies : items,
      itemsPerPage: items.length,
      totalPages: maxPageNumber(html),
      total: totalPostCount(html),
      page: p,
    };
  });
}

/** Latest Hindi series + movies for the home rows. */
export async function fetchHindiHome() {
  return cached("goku:home", TTL_CATALOG, async () => {
    const [series, movies] = await Promise.all([
      fetchHindiSeriesPage(1).catch(() => null),
      fetchHindiMoviesPage(1).catch(() => null),
    ]);
    return {
      series: (series?.items || []).slice(0, 24),
      movies: (movies?.items || []).slice(0, 24),
      totalSeries: series?.total || 0,
      totalMovies: movies?.total || 0,
    };
  });
}

/** WordPress site search (/?s=query). */
export async function searchHindi(query, page = 1) {
  const q = String(query || "").trim();
  if (!q) return [];
  const p = Math.max(1, Number(page) || 1);
  return cached(`goku:search:${q.toLowerCase()}:${p}`, TTL_CATALOG, async () => {
    const url =
      p === 1
        ? `${SITE}/?s=${encodeURIComponent(q)}`
        : `${SITE}/page/${p}/?s=${encodeURIComponent(q)}`;
    const html = await fetchHtml(url);
    return parseListingArticles(html, "series");
  });
}

// ---------------------------------------------------------------------------
// Post detail: seasons, quality options and the nexdrive links behind them
// ---------------------------------------------------------------------------
/**
 * Parse one post's download block. Each "Download <label>" line is followed by
 * one or more nexdrive anchors ("Source 1", "Source 2", "Batch File [4GB]").
 *
 * Returns { seasons, entries } where each entry is
 *   { season, quality, label, source, url } and seasons is a de-duplicated list.
 */
function parsePostDownloadBlock(html) {
  const entries = [];
  if (!html) return { seasons: [], entries };

  // Tokenize in document order: either a "Download ..." caption or a nexdrive link.
  const tokenRe = /Download\s+([^<]{3,220})|<a[^>]*href="(https:\/\/nexdrive\.[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let currentLabel = "";
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[1]) {
      currentLabel = decodeEntities(m[1]);
      continue;
    }
    const url = m[2];
    const sourceLabel = decodeEntities(m[3]).slice(0, 40) || "Source";

    const seasonMatch = currentLabel.match(/\bS(?:eason)?\s*0*(\d{1,2})\b/i);
    const qualityMatch = currentLabel.match(/\b(2160p|1440p|1080p|720p|480p|360p)\b/i);
    const isBatch = /batch/i.test(sourceLabel) || /batch/i.test(currentLabel);

    // Quality falls back to the tail of the caption when no explicit tag exists.
    const quality = qualityMatch
      ? qualityMatch[1]
      : (currentLabel.match(/\b(x265|10Bit|HEVC|AVC|BluRay|WEB-DL)\b/i) || [])[0] || "";

    entries.push({
      season: seasonMatch ? Number(seasonMatch[1]) : 1,
      quality: quality || "",
      label: currentLabel.slice(0, 120),
      source: sourceLabel,
      batch: isBatch,
      url,
    });
  }
  return { seasons: [], entries };
}

function seasonName(n) {
  return `Season ${n}`;
}

/** Full detail for one post: metadata + season/quality options. */
export async function fetchHindiDetail(slug) {
  const clean = String(slug || "").replace(/^goku:/, "").replace(/[^a-z0-9-]/gi, "").trim();
  if (!clean) return null;
  return cached(`goku:detail:${clean}`, TTL_DETAIL, async () => {
    const url = `${SITE}/${clean}/`;
    const html = await fetchHtml(url);
    if (!html || html.length < 500) return null;

    const rawTitle =
      (html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] || clean;
    const title = cleanHindiTitle(rawTitle) || clean;

    const poster = decodeEntities(
      (html.match(/<meta property="og:image" content="([^"]+)"/i) || [])[1] ||
        (html.match(/<img[^>]*class="[^"]*wp-post-image[^"]*"[^>]*src="([^"]+)"/i) || [])[1] || "",
    );

    const description = decodeEntities(
      (html.match(/<meta property="og:description" content="([^"]+)"/i) || [])[1] || "",
    );

    const schemaSection = (html.match(/"articleSection":"([^"]*)"/i) || [])[1];
    const genres = schemaSection
      ? decodeEntities(schemaSection).split(",").map((s) => s.trim())
          .filter((s) =>
            s &&
            !/^\d{3,4}p$/i.test(s) &&        // quality tags
            !/^\d{4}$/.test(s) &&            // bare years
            !/^(hindi|english|japanese|tamil|telugu)/i.test(s) &&
            !/(series|movie|trending|dubbed)/i.test(s) // category noise
          )
      : [];

    // The post's publish date is not the title's year; prefer a year that the
    // title itself carries (movies especially) and fall back to the post date.
    const titleYear = extractYear(rawTitle);
    const year = (titleYear || (html.match(/"datePublished":"(\d{4})/i) || [])[1] || "");
    const rating = (html.match(/class="imdb-score"[^>]*>\s*([\d.]+)/i) || [])[1] || "";
    const languages = ["Hindi"];
    if (/\bEnglish\b/i.test(title) || /Hindi-English/i.test(title)) languages.push("English");
    if (/\bJapanese\b/i.test(title) || /Hindi-English-Japanese/i.test(title)) languages.push("Japanese");

    const { entries } = parsePostDownloadBlock(html);

    // Group entries into seasons (movies land in season 1).
    const bySeason = new Map();
    for (const e of entries) {
      if (!bySeason.has(e.season)) bySeason.set(e.season, []);
      bySeason.get(e.season).push(e);
    }
    const seasonNumbers = [...bySeason.keys()].sort((a, b) => a - b);

    const seasons = seasonNumbers.map((n) => ({
      seasonNumber: String(n),
      seasonName: seasonName(n),
      episodes: String(bySeason.get(n).length),
      seasonId: `goku:${clean}~S${n}`,
      url,
    }));

    const isMovie =
      /category-hindi-dubbed-movies|category-anime-movies/i.test(html) ||
      /\[(?:Anime )?Movie\]/i.test(rawTitle);

    return {
      slug: clean,
      title,
      poster,
      description,
      year: String(year || ""),
      rating: String(rating || ""),
      genres: genres.slice(0, 8),
      languages,
      type: isMovie ? "movie" : "series",
      url,
      entries,
      seasons: seasons.length
        ? seasons
        : [{ seasonNumber: "1", seasonName: "Season 1", episodes: String(entries.length), seasonId: `goku:${clean}~S1`, url }],
    };
  });
}

/** Flat list of quality/source options for one season (or the whole post). */
export async function fetchHindiEpisodes(slug, seasonNumber) {
  const detail = await fetchHindiDetail(slug);
  if (!detail) return null;
  const want = Number(seasonNumber) || null;

  const list = detail.entries.filter((e) => (want === null ? true : e.season === want));
  if (!list.length) return null;

  const episodes = list.map((e, idx) => ({
    episodeId: `goku:${detail.slug}~S${e.season}~${idx}`,
    title: [e.quality, e.batch ? "Batch" : "", e.source].filter(Boolean).join(" · ") || e.label,
    episodeNumber: e.batch ? "Batch" : String(idx + 1),
    quality: e.quality,
    season: String(e.season),
    airDate: "",
    image: detail.poster,
    url: e.url,
  }));

  return {
    seasonId: `goku:${detail.slug}~S${want || 1}`,
    seasonUrl: detail.url,
    detail,
    episodes,
  };
}

// ---------------------------------------------------------------------------
// Stream resolution: nexdrive -> fastdl embed -> direct MP4
// ---------------------------------------------------------------------------
/** Pull the first playable direct URL out of a fastdl.beer embed page. */
function extractDirectFromEmbed(html) {
  if (!html) return null;
  // Primary: the redirect script carries a dl.php?link=<DIRECT> target.
  const reurl = (html.match(/var\s+reurl\s*=\s*"([^"]+)"/i) || html.match(/reurl\s*=\s*'([^']+)'/i) || [])[1];
  if (reurl) {
    const direct = reurl.split("link=")[1];
    if (direct) {
      try {
        return decodeURIComponent(direct);
      } catch {
        return direct;
      }
    }
    if (/^https?:\/\//i.test(reurl) && /\.(mp4|m3u8|mkv)/i.test(reurl)) return reurl;
  }
  // Secondary: a plain mp4/m3u8 anywhere on the page.
  const direct = (html.match(/https?:\/\/[^\s"'<>\\]+\.(?:mp4|m3u8)[^\s"'<>\\]*/i) || [])[0];
  return direct || null;
}

/**
 * Verify a candidate URL actually serves video bytes.
 *
 * Asks for a single byte instead of the whole file: Google answers a plain GET
 * with headers only after it has begun streaming the 100-250 MB file (~2 s per
 * probe from a Worker), while a 1-byte range gives the same answer in a few
 * hundred milliseconds and never buffers video in the isolate.
 */
async function isPlayableVideo(url, referer) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*", Referer: referer, Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(EMBED_TIMEOUT),
    });
    const type = (res.headers.get("content-type") || "").toLowerCase();
    const okType = type.startsWith("video/") || type.includes("octet-stream") || type.includes("mp4");
    const servedRange = Boolean(res.headers.get("content-range"));
    try { await res.body?.cancel(); } catch {}
    return (res.ok || res.status === 206 || servedRange) && okType;
  } catch {
    return false;
  }
}

/**
 * Resolve every mirror at once and answer the first one that plays.
 * Sequential probing waited ~2 s per drive, so a film with three mirrors needed
 * 6 s and hit the router's cap — the player then reported "no stream" although
 * every link was fine.
 */
function firstPlayable(entries, postUrl) {
  return new Promise((resolve) => {
    let pending = entries.length;
    let settled = false;
    if (!pending) return resolve(null);
    for (const entry of entries) {
      resolveNexdriveLink(entry.url, postUrl)
        .then((resolved) => {
          if (settled) return;
          if (resolved) {
            settled = true;
            resolve({ entry, resolved });
            return;
          }
          if (--pending === 0) resolve(null);
        })
        .catch(() => {
          if (!settled && --pending === 0) resolve(null);
        });
    }
  });
}

/**
 * Resolve one nexdrive link into a direct playable URL.
 * Returns { url, from } or null.
 */
async function resolveNexdriveLink(nexdriveUrl, postUrl) {
  return cached(`goku:nd:${nexdriveUrl}`, TTL_STREAM, async () => {
    const page = await fetchHtml(nexdriveUrl, { referer: postUrl });
    if (!page) return null;

    // Embeddable player links on the nexdrive page. Two URL shapes are in use:
    //   older posts  https://fastdl.beer/embed.php?download=<id>   (playable)
    //   newer posts  https://fastdl.beer/embed?download=<id>       (playable)
    //   wrapper      https://nexdrive.beer/embed?url=<encoded>    (player page)
    // The host also alternates between nexdrive.beer and nexdrive.fit, so match
    // any /embed path carrying a download= query instead of one exact form.
    const collectEmbeds = (html) => [
      ...new Set(
        [...html.matchAll(/href="(https?:\/\/[a-z0-9.-]+\/embed(?:\.php)?\?[^"]*(?:download|url)=[^"]*)"/gi)].map(
          (m) => decodeEntities(m[1]),
        ),
      ),
    ];

    let embeds = collectEmbeds(page).filter((u) => /[?&]download=/.test(u));

    // Wrapper-only pages: follow the nexdrive player URL one level to reach the
    // fastdl download links it embeds.
    if (!embeds.length) {
      const wrappers = collectEmbeds(page).filter((u) => /[?&]url=/.test(u)).slice(0, 3);
      for (const wrapper of wrappers) {
        try {
          embeds.push(...collectEmbeds(await fetchHtml(wrapper, { referer: nexdriveUrl, timeout: EMBED_TIMEOUT })).filter((u) => /[?&]download=/.test(u)));
        } catch {}
      }
      embeds = [...new Set(embeds)];
    }
    if (!embeds.length) return null;

    for (const embed of embeds) {
      let embedHtml;
      try {
        embedHtml = await fetchHtml(embed, { referer: nexdriveUrl, timeout: EMBED_TIMEOUT });
      } catch {
        continue;
      }
      const direct = extractDirectFromEmbed(embedHtml);
      if (!direct || !/^https?:\/\//i.test(direct)) continue;
      if (await isPlayableVideo(direct, embed)) {
        return { url: direct, from: embed };
      }
    }
    return null;
  });
}

/** Parse the id forms this module issues. */
function parseGokuId(id) {
  const raw = String(id || "").trim();
  if (!raw.startsWith("goku:")) return null;
  const body = raw.slice(5);
  const [slugPart, ...rest] = body.split("~");
  const slug = slugPart.replace(/[^a-z0-9-]/gi, "");
  if (!slug) return null;
  let season = null;
  let index = null;
  for (const part of rest) {
    const s = part.match(/^S(\d{1,2})$/i);
    if (s) { season = Number(s[1]); continue; }
    if (/^\d+$/.test(part)) index = Number(part);
  }
  return { slug, season, index };
}

/**
 * Resolve a Hindi stream for an episode/movie id issued by this module.
 * Returns the India router's stream payload, or null when nothing resolved.
 */
export async function resolveHindiStream(episodeId, movieId) {
  const parsed = parseGokuId(episodeId || movieId);
  if (!parsed) return null;

  const wantsMovie = Boolean(movieId) && !episodeId;
  const detail = await fetchHindiDetail(parsed.slug);
  if (!detail || !detail.entries.length) return null;

  // Pick the requested option, or the best available one (1080p > 720p > rest).
  const pool = parsed.season === null
    ? detail.entries
    : detail.entries.filter((e) => e.season === parsed.season);
  const candidates = pool.length ? pool : detail.entries;

  const qualityRank = (q) => {
    const n = Number(String(q || "").replace(/\D/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const ordered = [...candidates].sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));

  const chosen =
    parsed.index !== null && candidates[parsed.index]
      ? candidates[parsed.index]
      : (wantsMovie ? ordered[0] : ordered[0]);

  // One drive usually appears once per quality/mirror label; collapsing them
  // keeps a single page from being parsed (and probed) several times.
  const unique = [];
  const seenUrls = new Set();
  for (const entry of [chosen, ...ordered]) {
    if (!entry || seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    unique.push(entry);
    if (unique.length >= 4) break;
  }

  const hit = await firstPlayable(unique, detail.url);
  if (!hit) return null;
  const { entry, resolved } = hit;

  return {
    success: true,
    type: episodeId ? "episode" : "movie",
    title: detail.title,
    poster: detail.poster,
    quality: entry.quality || "",
    // `stream` stays a plain string for older callers; `streams` is the
    // richer shape the current player prefers (it picks streams[0]).
    stream: resolved.url,
    streams: [
      {
        url: resolved.url,
        quality: entry.quality || "",
        label: `${entry.quality || "Auto"} · ${entry.source}`,
        server: entry.source || "G-Direct",
        type: "mp4",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dedupe helpers (shared with the MovieBox Hindi-anime merge)
// ---------------------------------------------------------------------------
/**
 * Normalize a title for duplicate detection: strips bracketed suffixes, season
 * markers, dub/quality noise and punctuation so "Blue Box [Hindi]" and
 * "Blue Box (Season 1 & 2) Hindi Dubbed 1080p" collapse to the same key.
 */
export function normalizeHindiTitle(raw) {
  return decodeEntities(raw)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:hindi|dubbed|dub|subbed|sub|english|japanese|multi[\s-]?audio|blu[\s-]?ray|web[\s-]?dl|hdtv|hdrip|webrip|hd|org|batch|anime|series|movie)\b/gi, " ")
    .replace(/\b(?:1080p|720p|480p|360p|2160p|4k|10bit|x264|x265|hevc|avc)\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:season|s)\s*\d{1,2}\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when two normalized titles describe the same show. Exact keys match a
 * show across sources; the prefix rule catches "X" vs "X - Subtitle" (e.g.
 * "Death Note Relight 2" listed by one source as "... - L's Successors").
 * The remainder is capped so a long distinct sequel title is never swallowed.
 */
function isLikelySameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 12) return false;
  if (!long.startsWith(short)) return false;
  const remainder = long.slice(short.length).trim();
  return remainder.length > 1 && remainder.length <= 25;
}

/**
 * Merge two Hindi item lists without duplicates, keeping the first list's items
 * and only appending second-list items whose title is not already present.
 */
export function mergeHindiItems(primary, secondary, limit = null) {
  const keys = [];
  const out = [];
  const push = (item) => {
    if (!item || !item.title) return;
    const key = normalizeHindiTitle(item.title);
    if (!key) return;
    if (keys.some((existing) => existing === key || isLikelySameTitle(existing, key))) return;
    keys.push(key);
    out.push(item);
  };
  (primary || []).forEach(push);
  (secondary || []).forEach(push);
  return limit ? out.slice(0, limit) : out;
}
