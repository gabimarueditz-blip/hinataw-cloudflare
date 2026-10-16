// MangaDex (api.mangadex.org) — official JSON API, no scraping and no reader
// hop, so it works reliably from Cloudflare Workers egress where the
// mangakakalot reader keeps 429ing (shared-IP rate limits, verified). Used as
// the primary source for search/info/chapter; the mangakakalot + r.jina.ai
// reader path in manga.js stays as the fallback for titles MangaDex does not
// carry. Slugs are namespaced "md-<uuid>" so both providers can coexist in
// one URL scheme.
//
// Endpoints used (all unauthenticated):
//   GET /manga?title=&includes[]=cover_art&order[relevance]=desc   search
//   GET /manga/<id>?includes[]=cover_art                            detail
//   GET /manga/<id>/feed?limit=500&translatedLanguage[]=en          chapters
//   GET /chapter/<id>?includes[]=manga                              chapter context
//   GET /at-home/server/<chapterId>                                 page images
// Rate limit is generous (5 req/s) and every response is JSON.

const API = "https://api.mangadex.org";
const COVERS = "https://uploads.mangadex.org";
const UA = "HinatawManga/1.0 (manga reader; freebuff.page)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATINGS = "contentRating[]=safe&contentRating[]=suggestive";
const FEED_PAGE = 500;
const FEED_MAX = 2000;

async function mdx(path, { timeout = 20000 } = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`mangadex ${path.split("?")[0]} -> ${res.status}`);
  return res.json();
}

// Small TTL cache: info + feed are re-read constantly (chapter pages ask for
// the neighbouring list) and the responses are immutable for our purposes.
const CACHE = new Map();
async function cachedJson(key, ttl, loader) {
  const hit = CACHE.get(key);
  if (hit && Date.now() < hit.exp) return hit.value;
  const value = await loader();
  if (CACHE.size > 200) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, { value, exp: Date.now() + ttl });
  return value;
}

function idOf(slug) {
  const id = String(slug || "").replace(/^md-/, "");
  return UUID_RE.test(id) ? id : null;
}

function pickTitle(a) {
  if (a?.title?.en) return a.title.en;
  // Browse rows surface plenty of titles whose primary key is ja/ko — prefer
  // a romanised English alt title over them before falling back to the raw
  // primary value.
  const alt = (a?.altTitles || []).map((t) => t?.en).find(Boolean);
  if (alt) return alt;
  return Object.values(a?.title || {})[0] || "";
}

function coverOf(m) {
  const cov = (m?.relationships || []).find((r) => r.type === "cover_art" && r.attributes?.fileName);
  return cov ? `${COVERS}/covers/${m.id}/${cov.attributes.fileName}.256.jpg` : "";
}

function toItem(m) {
  const a = m?.attributes || {};
  const title = pickTitle(a);
  if (!m?.id || !title) return null;
  const cover = coverOf(m);
  const lastChapter = a.lastChapter ? String(a.lastChapter) : "";
  return {
    slug: `md-${m.id}`,
    title,
    poster: cover,
    posterDirect: true, // MangaDex covers hotlink fine — skip the image proxy
    thumbPath: "",
    latestChapter: lastChapter ? `Chapter ${lastChapter}` : "",
    latestChapterSlug: "",
    author: (a.authors || []).map((r) => r?.attributes?.name).filter(Boolean).join(", "),
    views: "",
    updatedAt: a.updatedAt ? String(a.updatedAt).slice(0, 10) : "",
  };
}

/** Title search — relevance ordered, safe/suggestive content only. */
export async function mdxSearch(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  return cachedJson(`search:${q.toLowerCase()}`, 5 * 60 * 1000, async () => {
    const d = await mdx(
      `/manga?title=${encodeURIComponent(q)}&limit=20&includes[]=cover_art&${RATINGS}&order[relevance]=desc`
    );
    return (d.data || []).map(toItem).filter(Boolean);
  });
}

async function getManga(id) {
  return cachedJson(`manga:${id}`, 30 * 60 * 1000, async () => {
    const d = await mdx(`/manga/${id}?includes[]=cover_art`);
    return d.data;
  });
}

async function getFeed(id) {
  return cachedJson(`feed:${id}`, 30 * 60 * 1000, async () => {
    const chapters = [];
    for (let offset = 0; offset < FEED_MAX; offset += FEED_PAGE) {
      const d = await mdx(
        `/manga/${id}/feed?limit=${FEED_PAGE}&offset=${offset}&translatedLanguage[]=en&${RATINGS}&order[chapter]=asc`
      );
      const rows = d.data || [];
      for (const c of rows) {
        const ca = c?.attributes || {};
        // Post-takedown MangaDex carries many "external" chapters that only
        // link to MangaPlus/VIZ and have no readable pages — they would show
        // in the list and then fail to open, so they are skipped.
        if (!ca.pages || ca.externalUrl) continue;
        const num = ca.chapter ? String(ca.chapter) : "";
        chapters.push({
          slug: `md-${c.id}`,
          number: num,
          name: (num ? `Chapter ${num}` : "") + (ca.title ? ` ${ca.title}` : "") || "Chapter ?",
          updatedAt: ca.readableAt || ca.publishAt || "",
          views: null,
          url: "",
        });
      }
      if (rows.length < FEED_PAGE) break;
    }
    // Numeric ordering by chapter number, newest first (matches the
    // mangakakalot feed shape the UI renders: chapters[0] = latest).
    chapters.sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));
    return chapters.reverse();
  });
}

/** Full detail: metadata + the English chapter list, newest first. */
export async function mdxInfo(slugInput) {
  const id = idOf(slugInput);
  if (!id) return null;
  const [manga, chapters] = await Promise.all([getManga(id), getFeed(id)]);
  if (!manga) return null;
  const a = manga.attributes || {};
  const poster = coverOf(manga);
  const genres = (a.tags || [])
    .map((t) => {
      const name = String(t?.attributes?.name?.en || "").trim();
      return name ? { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name } : null;
    })
    .filter(Boolean);

  return {
    title: pickTitle(a) || String(id),
    alternative: (a.altTitles || []).map((t) => t?.en).filter(Boolean)[0] || "",
    poster,
    posterDirect: true,
    thumbPath: "",
    author: (a.authors || []).map((r) => r?.attributes?.name).filter(Boolean).join(", "),
    status: a.status || "",
    lastUpdated: (chapters[0] && chapters[0].updatedAt) || "",
    views: "",
    rating: a.year ? String(a.year) : "",
    genres,
    tags: genres.map((g) => g.name),
    description: String(a.description?.en || "").trim(),
    slug: `md-${id}`,
    chapters,
    totalChapters: chapters.length,
    latestChapter: chapters[0]?.name || "",
    latestChapterSlug: chapters[0]?.slug || "",
    firstChapterSlug: chapters[chapters.length - 1]?.slug || "",
  };
}

// ---------------------------------------------------------------------------
// Browse / home / genre lists — the reader-free replacement for the
// mangakakalot HTML list pages. Every ordering this app uses (popular =
// followedCount, latest = latestUploadedChapter, new = createdAt) answers
// anonymously on the same official API, verified against api.mangadex.org.
// ---------------------------------------------------------------------------

const BROWSE_LIMIT = 24;
// MangaDex serves at most 10 000 items of offset+limit combined; paging past
// that would 400, so the pager stops where the API does.
const BROWSE_MAX_PAGES = Math.floor(10000 / BROWSE_LIMIT);

const tagSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** Genre + demographic tags for the picker and the browse filter. */
export async function mdxTags() {
  return cachedJson("tags", 12 * 60 * 60 * 1000, async () => {
    const d = await mdx("/manga/tag");
    return (d.data || [])
      .map((t) => {
        const group = String(t?.attributes?.group || "");
        const name = String(t?.attributes?.name?.en || "").trim();
        if (!name || (group !== "genre" && group !== "demographic")) return null;
        return { id: t.id, name, slug: tagSlug(name) };
      })
      .filter(Boolean);
  });
}

const BROWSE_ORDERS = {
  latest: "latestUploadedChapter",
  hot: "followedCount",
  new: "createdAt",
  completed: "latestUploadedChapter",
};
const BROWSE_HEADINGS = {
  latest: "Latest Manga",
  hot: "Popular Manga",
  new: "New Manga",
  completed: "Completed Manga",
};

/** One page of browse/genre results, shaped like the mangakakalot list. */
export async function mdxBrowse({ type = "latest", genre = "", page = 1 } = {}) {
  const g = String(genre || "");
  const p = Math.max(1, Number(page) || 1);
  const order = BROWSE_ORDERS[type] || BROWSE_ORDERS.latest;

  let tagId = "";
  let heading = BROWSE_HEADINGS[type] || BROWSE_HEADINGS.latest;
  if (g) {
    const tags = await mdxTags();
    const tag = tags.find((t) => t.slug === g);
    // A slug this API does not carry (e.g. mangakakalot's "manhua") must
    // throw so the caller falls back to the reader-backed list path.
    if (!tag) throw new Error(`mangadex: no tag ${g}`);
    tagId = tag.id;
    heading = tag.name;
  }

  const params = [
    `limit=${BROWSE_LIMIT}`,
    `offset=${(p - 1) * BROWSE_LIMIT}`,
    "includes[]=cover_art",
    RATINGS,
    `order[${order}]=desc`,
  ];
  if (tagId) params.push(`includedTags[]=${encodeURIComponent(tagId)}`, "includedTagsMode=AND");
  if (type === "completed") params.push("status[]=ended");

  const d = await cachedJson(`browse:${g || type}:${p}`, 10 * 60 * 1000, async () =>
    mdx(`/manga?${params.join("&")}`)
  );
  const total = Number(d.total) || (d.data || []).length;
  return {
    type: g ? "genre" : type,
    genre: g || null,
    page: p,
    totalPages: Math.max(1, Math.min(Math.ceil(total / BROWSE_LIMIT), BROWSE_MAX_PAGES)),
    heading,
    items: (d.data || []).map(toItem).filter(Boolean),
  };
}

/** Home rows: the popular carousel, the latest-updates row and the genres. */
export async function mdxHome() {
  const [popular, latest, tags] = await Promise.all([
    mdxBrowse({ type: "hot" }),
    mdxBrowse({ type: "latest" }),
    mdxTags(),
  ]);
  return {
    popular: popular.items,
    latest: latest.items,
    genres: tags.map((t) => ({ slug: t.slug, name: t.name })),
  };
}

/** One chapter: page image URLs from the at-home server + prev/next. */
export async function mdxChapter(slugInput, chapterInput) {
  const mangaId = idOf(slugInput);
  const chapterId = idOf(chapterInput);
  if (!mangaId || !chapterId) return null;

  const [ctx, chapters, server] = await Promise.all([
    mdx(`/chapter/${chapterId}?includes[]=manga`).catch(() => null),
    getFeed(mangaId),
    mdx(`/at-home/server/${chapterId}`, { timeout: 25000 }),
  ]);

  const hash = server?.chapter?.hash || "";
  const base = String(server?.baseUrl || "").replace(/\/+$/, "");
  const files = server?.chapter?.data || [];
  if (!base || !hash || !files.length) return null;

  const ca = ctx?.data?.attributes || {};
  const number = ca.chapter ? String(ca.chapter) : "";
  const idx = chapters.findIndex((c) => c.slug === `md-${chapterId}`);
  const newer = idx > 0 ? chapters[idx - 1] : null;
  const older = idx >= 0 && idx + 1 < chapters.length ? chapters[idx + 1] : null;
  const manga = await getManga(mangaId).catch(() => null);

  return {
    slug: `md-${mangaId}`,
    chapter: `md-${chapterId}`,
    number,
    heading: (number ? `Chapter ${number}` : "") + (ca.title ? ` ${ca.title}` : ""),
    title: manga ? pickTitle(manga.attributes || {}) : String(mangaId),
    poster: manga ? coverOf(manga) : "",
    posterDirect: true,
    // At-home CDN URLs carry no Referer requirement — load them directly
    // instead of relaying every page image through the Worker.
    images: files.map((f, i) => ({
      raw: `${base}/data/${hash}/${f}`,
      mirror: "",
      alt: `page ${i + 1}`,
      direct: true,
    })),
    pages: files.length,
    prevChapter: older ? { slug: older.slug, name: older.name } : null,
    nextChapter: newer ? { slug: newer.slug, name: newer.name } : null,
    chapters: chapters.map((c) => ({ slug: c.slug, name: c.name, number: c.number })),
  };
}
