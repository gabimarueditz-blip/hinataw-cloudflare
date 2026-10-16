const __name = (fn, _) => fn;

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var ANILIST_WEB = "https://anilist.co";

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

function cookiesFromHeaders(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => String(value).split(";")[0]).join("; ");
}

async function mediaFromResponse(res) {
  if (!res?.ok) return null;
  try {
    const json = await res.json();
    return json.data?.Media ?? null;
  } catch {
    return null;
  }
}

async function fetchFromAniListWeb(body) {
  const home = await fetch(`${ANILIST_WEB}/`, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  }).catch(() => null);
  if (!home?.ok) return null;
  const html = await home.text();
  const token = html.match(/window\.al_token\s*=\s*"([^"]+)"/)?.[1];
  const cookie = cookiesFromHeaders(home.headers);
  if (!token || !cookie) return null;
  const res = await fetch(`${ANILIST_WEB}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: `${ANILIST_WEB}/home`,
      "x-csrf-token": token,
      schema: "default",
      Cookie: cookie,
    },
    body,
  }).catch(() => null);
  return mediaFromResponse(res);
}

async function fetchFromAniList(id) {
  const fullQuery = `query($id:Int){Media(id:$id,type:ANIME){id title{english romaji native} status format episodes seasonYear startDate{year} synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const body = JSON.stringify({ query: fullQuery, variables: { id } });
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body,
  }).catch(() => null);
  return await mediaFromResponse(res) ?? fetchFromAniListWeb(body);
}

async function getMedia(anilistId) {
  const id = Number(anilistId);
  if (resolved.has(id)) return resolved.get(id);
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    const arm = await fetch(`${ARM}?source=anilist&id=${id}`, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    }).then((r) => {
      if (!r.ok) return null;
      return r.json();
    }).catch(() => null);

    const al = await fetchFromAniList(id);
    if (!al) throw new Error(`No data found for AniList ID ${id}`);
    const media = {
      id,
      idMal: arm?.myanimelist ?? null,
      title: {
        english: al.title?.english ?? null,
        romaji: al.title?.romaji ?? null,
        native: al.title?.native ?? null,
      },
      status: AL_STATUS_MAP[al.status] ?? "RELEASING",
      format: al.format ?? null,
      episodes: al.episodes ?? null,
      seasonYear: al.seasonYear ?? null,
      startDate: al.startDate ?? null,
      nextAiringEpisode: al.nextAiringEpisode ?? null,
      synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
    };
    resolved.set(id, media);
    inflight.delete(id);
    return media;
  })().catch((e) => {
    inflight.delete(id);
    throw e;
  });
  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  resolved.delete(Number(anilistId));
}

var TRENDING_TTL = 30 * 60 * 1000;
var trendingCache = null;

// Trending = currently-airing anime, ranked by AniList's trending signal.
// Status RELEASING keeps finished all-time favourites (Frieren, JJK, ...) out of the list.
async function getTrendingOngoing(perPage = 12) {
  if (trendingCache && Date.now() - trendingCache.at < TRENDING_TTL) return trendingCache.data;

  const query = `query($per:Int){Page(page:1,perPage:$per){media(type:ANIME,status:RELEASING,sort:TRENDING_DESC,isAdult:false){id title{english romaji native}status format episodes seasonYear season averageScore popularity coverImage{large extraLarge}bannerImage nextAiringEpisode{episode airingAt timeUntilAiring}}}}`;
  const body = JSON.stringify({ query, variables: { per: perPage } });

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body,
  }).catch(() => null);

  const json = res?.ok ? await res.json().catch(() => null) : null;
  const media = json?.data?.Page?.media;
  if (!Array.isArray(media) || media.length === 0) {
    return trendingCache ? trendingCache.data : [];
  }

  const data = media.map((m) => {
    const title = m.title?.english || m.title?.romaji || m.title?.native || "Untitled";
    const cover = m.coverImage?.extraLarge || m.coverImage?.large || "";
    return {
      id: m.id,
      title: { english: title, romaji: m.title?.romaji || title, native: m.title?.native || title, userPreferred: title },
      titleStr: title,
      status: AL_STATUS_MAP[m.status] ?? "RELEASING",
      format: m.format,
      episodes: m.episodes ?? null,
      season: m.season,
      seasonYear: m.seasonYear,
      averageScore: m.averageScore ?? null,
      popularity: m.popularity ?? null,
      coverImage: { large: cover, extraLarge: cover, medium: cover },
      poster: cover,
      bannerImage: m.bannerImage || cover,
      nextAiringEpisode: m.nextAiringEpisode ?? null,
      totalEpisodes: m.episodes ?? null,
      duration: "24m",
    };
  });

  trendingCache = { at: Date.now(), data };
  return data;
}

export { getMedia, forgetMedia, getTrendingOngoing };
