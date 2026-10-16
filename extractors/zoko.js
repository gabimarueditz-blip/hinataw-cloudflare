// ZokoAnime (zokoanime.video) embed extractor.
//
// A Zoko embed is a small HTML shell that boots a JW Player build carrying a
// third-party ad stack (Connatix and its partner syncs). That player lives in a
// cross-origin iframe, so its ads cannot be removed from our page — and it
// refuses to run inside a sandboxed iframe, so sandboxing is not an option
// either.
//
// The shell does, however, hand us everything we need: its whole player config
// is a single XOR-obfuscated JSON blob in `window.__P` that names the real HLS
// master playlist and its subtitle tracks. We decode it and feed the stream to
// our own native player, which means the embed's ad-laden player is never
// loaded at all.
//
// Obfuscation mirrors the provider's own core/obfuscate.js:
//   obfuscate(obj) = base64(xor(JSON.stringify(obj)))   with key below.
//
// The stream host is Referer-locked to the provider, so every URL we emit goes
// through /api/anime/proxy-stream with that Referer attached.

import { isEnglishSubtitle } from "../core/subtitle-lang.js";

const OBF_KEY = "otaku-embed-v1";
const ZOKO_ORIGIN = "https://zokoanime.video";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function isZokoEmbedUrl(url) {
  try {
    return /(^|\.)zokoanime\.video$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

export function deobfuscateZokoConfig(blob) {
  try {
    const bytes = Buffer.from(String(blob), "base64");
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
    }
    return JSON.parse(out.toString("utf8"));
  } catch {
    return null;
  }
}

// Fetch a Zoko embed shell and return its decoded player config, or throw.
export async function extractZoko(embedUrl, { userAgent = DEFAULT_UA, timeoutMs = 4000 } = {}) {
  const res = await fetch(String(embedUrl), {
    headers: { "User-Agent": userAgent, Referer: `${ZOKO_ORIGIN}/` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Zoko embed HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(/window\.__P="([^"]+)"/);
  if (!match) throw new Error("Zoko player config not found");

  const config = deobfuscateZokoConfig(match[1]);
  if (!config || !config.src) throw new Error("Zoko player config has no stream source");
  return config;
}

// Turn a decoded config into the fields our stream list expects: the master
// playlist and its subtitle tracks, each pointed at the relay that re-attaches
// the provider Referer. Only English subtitles survive the filter.
// Pass relay:true when the caller needs URLs already wrapped for playback (the
// stream API does its own wrapping for HiAnime, so those callers leave it off
// and just take url/rawUrl/referer).
export function buildZokoStream(config, { origin = ZOKO_ORIGIN, relay = false } = {}) {
  const referer = origin.replace(/\/$/, "") + "/";
  const link = (url) =>
    relay
      ? `/api/anime/proxy-stream?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`
      : url;

  const subtitles = (config.subtitles || [])
    .filter((t) => t && t.src)
    .map((t, idx) => ({
      url: link(t.src),
      label: t.label || `Subtitle ${idx + 1}`,
      srclang: t.lang || "en",
      default: !!t.default,
    }))
    .filter(isEnglishSubtitle);
  if (subtitles[0]) subtitles[0].default = true;

  return {
    type: "hls",
    url: link(config.src),
    rawUrl: config.src,
    referer,
    subtitles,
  };
}

// One call for callers that just want a ready stream: returns null when the
// embed cannot be read (so callers can fall back to the embed itself).
export async function zokoStreamFromEmbed(embedUrl, { relay = false, origin = ZOKO_ORIGIN, userAgent, timeoutMs } = {}) {
  try {
    const config = await extractZoko(embedUrl, { userAgent, timeoutMs });
    return buildZokoStream(config, { origin, relay });
  } catch {
    return null;
  }
}
