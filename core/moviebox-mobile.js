// MovieBox mobile API — the signed client protocol the MovieBoxPro Android
// app uses (ported from the Genga-World client's LocalMovieBoxServer).
//
// Why this exists: the *web* player (netfilm/mzfi embed) opens its
// "Please log in before payment" purchase modal on limited/VIP episodes, so an
// embed can never be the lead playback path. The mobile app API answers with
// plain files instead — either play-info streams or, for UGC-hosted titles
// where play-info only serves the 23-second dummy clip, the same
// collection/download-list bypass the official app itself falls back to.
// It doubles as a live search fallback when the h5 POST search is rejected.
//
// Protocol (all requests signed per request):
//   GET  /wefeed-mobile-bff/tab-operating           -> guest JWT from x-user
//   GET  /wefeed-mobile-bff/subject-api/play-info   -> data.streams[]
//   GET  /wefeed-mobile-bff/subject-api/get         -> subject detail
//   GET  /wefeed-mobile-bff/ugc/video/first-by-subject -> ugcVideoId/collection
//   GET  /wefeed-mobile-bff/ugc/collection/download-list -> real files
//   GET  /wefeed-mobile-bff/ugc/video/download      -> real files (movies)
//   POST /wefeed-mobile-bff/subject-api/search      -> { keyword, page, pageSize }
//   POST /wefeed-mobile-bff/subject-api/trending/v2 -> { }
//
// Signature: HMAC-MD5 over a canonical request string with a base64 app key,
// wrapped as `timestamp|2|base64sig`; the client token is
// `timestamp,md5(reversed(timestamp))`.

import crypto from "crypto";

const BASE = "https://api.inmoviebox.com";
const SIGN_KEY_B64 = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
const UA = "MovieBoxPro/16.2.1 (Android 14; com.community.mbox.in)";

const md5 = (input) => crypto.createHash("md5").update(input, "utf8").digest("hex");

// Guest JWT from the x-user response header, refreshed on 401 the same way the
// app bootstraps it.
let guestToken = "";
let bootPromise = null;
// Non-mutating content-path check so the early auth-retry decision does not
// depend on reading the response body twice (which some runtimes reject).
function isContentPath(path) {
  return /\/subject-api\/|\/ugc\//.test(path);
}

function clientInfo() {
  return JSON.stringify({
    package_name: "com.movieboxpro.android",
    version_name: "16.2.1",
    version_code: 16210,
    os: "android",
    os_version: "12",
    install_ch: "googleplay",
    device_id: "8c5da15be6ca34e724a27bc102cd8bcf",
    install_store: "googleplay",
    gaid: "",
    brand: "google",
    model: "Pixel 6",
    system_language: "en",
    net: "wifi",
    region: "IN",
    timezone: "Asia/Kolkata",
    sp_code: "404",
  });
}

function signHeaders(pathWithQuery, method, body) {
  const timestamp = Date.now().toString();
  const reversed = [...timestamp].reverse().join("");
  const clientToken = `${timestamp},${md5(reversed)}`;
  const u = new URL(pathWithQuery, BASE);
  // Canonical query: names sorted, values decoded — same as the app's
  // `queryParameterNames.sorted()` + decoded `queryParameter()` pair.
  const sortedQuery = [...u.searchParams.keys()]
    .sort()
    .map((n) => `${n}=${u.searchParams.get(n)}`)
    .join("&");
  const bodyLen = body ? String(Buffer.byteLength(body, "utf8")) : "";
  const bodyHash = body ? md5(Buffer.from(body, "utf8").subarray(0, 102400)) : "";
  const canonical =
    `${method}
application/json
application/json;charset=UTF-8
` +
    `${bodyLen}
${timestamp}
${bodyHash}
` +
    `${u.pathname}${sortedQuery ? `?${sortedQuery}` : ""}`;
  const sig = crypto
    .createHmac("md5", Buffer.from(SIGN_KEY_B64, "base64"))
    .update(canonical, "utf8")
    .digest("base64");
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Language": "en-IN,hi-IN;q=0.9,en;q=0.8",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Sign-Version": "2.0",
    appid: "4U01pxRu278GqCZKY9",
    region: "IN",
    lang: "en",
    os: "android",
    "X-Timestamp": timestamp,
    Referer: `${BASE}/`,
    "X-Client-Token": clientToken,
    "x-tr-signature": `${timestamp}|2|${sig}`,
    "X-Play-Mode": "2",
    "X-Client-Info": clientInfo(),
    "X-Client-Status": "1",
    ...(guestToken ? { Authorization: `Bearer ${guestToken}` } : {}),
  };
}

function absorbToken(res) {
  const xUser = res.headers.get("x-user");
  if (!xUser) return;
  try {
    const t = xUser.startsWith("{") ? JSON.parse(xUser).token : xUser;
    if (t) guestToken = t;
  } catch {}
}

async function bootstrapToken() {
  if (guestToken) return;
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        const res = await fetch(
          `${BASE}/wefeed-mobile-bff/tab-operating?host=api.inmoviebox.com&page=1&pageSize=24&tabId=1`,
          { headers: signHeaders("/wefeed-mobile-bff/tab-operating?host=api.inmoviebox.com&page=1&pageSize=24&tabId=1", "GET", ""), signal: AbortSignal.timeout(15000) },
        );
        absorbToken(res);
        // Drain the body so the connection can be reused.
        try { await res.arrayBuffer(); } catch {}
      } catch {
        // A missing guest token is not fatal for every endpoint; callers see
        // the upstream status and fall through to the next source.
      } finally {
        bootPromise = null;
      }
    })();
  }
  await bootPromise;
}

async function mobileCall(path, { method = "GET", payload = null, timeout = 20000, retried = false } = {}) {
  const body = payload ? JSON.stringify(payload) : "";
  const headers = signHeaders(path, method, body);
  const res = await fetch(new URL(path, BASE).toString(), {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(timeout),
  });
  absorbToken(res);
  const text = await res.text();
  if (res.status === 429 || text.toLowerCase().includes("too many requests")) {
    await new Promise((r) => setTimeout(r, 3500));
    const headers2 = signHeaders(path, method, body);
    const res2 = await fetch(new URL(path, BASE).toString(), {
      method,
      headers: headers2,
      body: body || undefined,
      signal: AbortSignal.timeout(timeout),
    });
    absorbToken(res2);
    const text2 = await res2.text();
    if (res2.ok) {
      let json2 = null;
      try { json2 = JSON.parse(text2); } catch {}
      if (json2 && (json2.code === 0 || json2.code === 200)) return json2;
    }
  }

  let json = null;
  try { json = JSON.parse(text); } catch {}

  // Logged-out content endpoints return 401/441 with "miss token"/
  // "token has expired" before any guest token is held. Retry once so a
  // logged-out user does not rely on the slow h5 fallback for the first hit.
  if (!retried && isContentPath(path)) {
    const code = json && typeof json.code === "number" ? json.code : null;
    if (res.status === 401 || res.status === 441 || code === 401 || code === 441) {
      if (/miss token|token has expired/i.test(text)) {
        guestToken = "";
        try { await bootstrapToken(); } catch {}
        return mobileCall(path, { method, payload, timeout, retried: true });
      }
    }
  }
  if (!res.ok) {
    throw new Error(`moviebox-mobile ${path} -> ${res.status} ${text.slice(0, 140)}`.trim());
  }
  if (!json) throw new Error(`moviebox-mobile ${path} -> bad json`);
  if (json.code !== undefined && Number(json.code) !== 0 && Number(json.code) !== 200) {
    throw new Error(`moviebox-mobile ${path} -> code ${json.code} ${json.message || ""}`.trim());
  }
  return json;
}
// The anti-piracy "dummy" answers: a 23-second placeholder clip on
// macdn.aoneroom.com (or an explicit update trap). Identical to the check in
// the Genga-World client.
function isDummyUrl(u) {
  return !u || /macdn\.aoneroom\.com|please_update|update_app|b164fbfb43/.test(u);
}

// Browser-playable resources only, best first: H.264 MP4 wins (HEVC decodes
// inconsistently in desktop browsers), then HLS, with h265 variants demoted
// exactly like the app's own scorer.
function resourceScore(u) {
  const low = String(u || "").toLowerCase();
  if (!/\.(mp4|m3u8)(\?|$)/.test(low)) return -1;
  const h265 = /h265|x265|hev1/.test(low);
  if (low.includes(".mp4")) return h265 ? 60 : 100;
  return h265 ? 30 : 50;
}

function resourcesToSources(resources) {
  const resOf = (r) => Number(r.resolution || r.resolutions) || 0;
  return (resources || [])
    .filter((r) => r && r.url && !isDummyUrl(r.url))
    .map((r) => ({ r, score: resourceScore(r.url) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || resOf(b.r) - resOf(a.r))
    .map(({ r }) => {
      const u = String(r.url);
      const isHls = /\.m3u8(\?|$)/i.test(u);
      return {
        direct: u,
        resolution: resOf(r),
        format: isHls ? "HLS" : "MP4",
        size: Number(r.size) || 0,
      };
    });
}

/**
 * Resolve direct sources for one episode.
 * 1. play-info — fast path; returns real files when the title is not gated.
 * 2. UGC download-list — the app's own bypass for dummy play-info answers.
 * Returns [] when neither yields a browser-playable file.
 */
export async function mobileStream({ subjectId, se = 1, ep = 1, timeout = 20000 } = {}) {
  const id = String(subjectId || "").trim();
  if (!id) return [];
  const numSe = Number(se) || 0;
  const numEp = Number(ep) || 0;
  // Movies play without se/ep (the app omits them when subjectType === 1);
  // our callers signal a movie with se=0/ep=0.
  const isMovie = numSe === 0 && numEp === 0;
  const qSe = numSe || 1;
  const qEp = numEp || 1;

  const baseQ =
    `/wefeed-mobile-bff/subject-api/play-info?host=api.inmoviebox.com&subjectId=${encodeURIComponent(id)}` +
    (isMovie ? "" : `&se=${qSe}&ep=${qEp}`) +
    `&quality=720p`;

  // --- Path 1: play-info -------------------------------------------------
  try {
    const pi = await mobileCall(baseQ, { timeout });
    const d = pi.data || {};
    const streams = d.streams || d.streamList || [];
    const real = streams.filter((s) => s && !isDummyUrl(s.url));
    if (real.length) {
      // One entry per distinct URL (play-info repeats the same file across
      // the advertised resolution list); resolution comes from the list.
      const out = [];
      const seen = new Set();
      for (const s of real) {
        const u = String(s.url);
        if (seen.has(u)) continue;
        seen.add(u);
        const resList = String(s.resolutions || "").split(",").map((n) => parseInt(n, 10));
        out.push({
          direct: u,
          resolution: resList.find((n) => Number.isFinite(n) && n > 0) || 0,
          format: /\.m3u8(\?|$)/i.test(u) ? "HLS" : String(s.format || "MP4").toUpperCase() === "HLS" ? "HLS" : "MP4",
          size: Number(s.size) || 0,
        });
      }
      if (out.length) return out;
    }
  } catch {
    // Fall through to the UGC bypass.
  }

  // --- Path 2: UGC download-list bypass ---------------------------------
  try {
    const first = await mobileCall(
      `/wefeed-mobile-bff/ugc/video/first-by-subject?host=api.inmoviebox.com&subjectId=${encodeURIComponent(id)}`,
      { timeout },
    );
    const fd = first.data || {};
    const collectionId = fd.belongToCollection && fd.belongToCollection.collectionId;

    if (collectionId) {
      const target = `S${qSe}EP${qEp}`;
      const targetAlt = `E${qEp}`;
      for (let page = 1; page <= 3; page++) {
        const list = await mobileCall(
          `/wefeed-mobile-bff/ugc/collection/download-list?host=api.inmoviebox.com` +
            `&collectionId=${encodeURIComponent(collectionId)}&page=${page}&perPage=50`,
          { timeout },
        );
        const items = (list.data && list.data.items) || [];
        if (!items.length) break;
        let hit = items.find((it) => {
          const t = `${it.epTitle || ""} ${it.title || ""}`.toUpperCase();
          return t.includes(target) || t.includes(targetAlt);
        });
        // The app's own fallback: episode 1 takes the first item.
        if (!hit && qEp === 1) hit = items[0];
        if (hit) {
          const sources = resourcesToSources(hit.resources);
          if (sources.length) return sources;
        }
        if (items.length < 50) break;
      }
    } else if (fd.ugcVideoId) {
      const dl = await mobileCall(
        `/wefeed-mobile-bff/ugc/video/download?host=api.inmoviebox.com&ugcVideoId=${encodeURIComponent(fd.ugcVideoId)}`,
        { timeout },
      );
      const items = (dl.data && dl.data.items) || [];
      const sources = resourcesToSources(items.flatMap((it) => it.resources || []));
      if (sources.length) return sources;
    }
  } catch {
    // Nothing else to try; the caller keeps the embed as a last resort.
  }

  return [];
}

/**
 * Live search through the mobile API. Items are mapped to the same shape the
 * h5 pipeline normalises (detailPath derived from detailUrl) so the caller can
 * run them through the shared normaliser, which also fills the id registry.
 */
async function cacheGuestTokenOnce() {
  if (guestToken) return;
  try {
    const res = await fetch(
      `${BASE}/wefeed-mobile-bff/tab-operating?host=api.inmoviebox.com&page=1&pageSize=24&tabId=1`,
      { headers: signHeaders("/wefeed-mobile-bff/tab-operating?host=api.inmoviebox.com&page=1&pageSize=24&tabId=1", "GET", ""), signal: AbortSignal.timeout(15000) },
    );
    absorbToken(res);
    try { await res.arrayBuffer(); } catch {}
  } catch {}
}

export async function mobileSearch(query, page = 1, timeout = 15000) {
  const q = String(query || "").trim();
  if (!q) return [];
  await cacheGuestTokenOnce();
  const data = await mobileCall(
    "/wefeed-mobile-bff/subject-api/search",
    { method: "POST", payload: { keyword: q, page: Math.max(1, Number(page) || 1), pageSize: 20 }, timeout },
  );
  const inner = data.data || {};
  const list = inner.list || inner.items || inner.subjects || (Array.isArray(data.data) ? data.data : []);
  return (Array.isArray(list) ? list : [])
    .map((it) => {
      if (!it || !it.title) return null;
      // detailUrl (https://movie-box.co/detail/<slug>) carries the h5 slug.
      let slug = it.detailPath || "";
      if (!slug && it.detailUrl) {
        try {
          const parts = new URL(it.detailUrl).pathname.split("/").filter(Boolean);
          slug = parts[parts.length - 1] || "";
        } catch {}
      }
      if (!slug) return null;
      const cover = typeof it.cover === "string" ? it.cover : it.cover?.url || "";
      return {
        ...it,
        subjectId: it.subjectId ?? it.id,
        detailPath: slug,
        cover: cover ? { url: cover } : it.cover,
      };
    })
    .filter(Boolean);
}
