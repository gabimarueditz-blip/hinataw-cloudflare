// Maps human subtitle track labels (from MegaPlay / Zoko sources) to ISO 639-1
// codes. Sources ship multi-language track lists (Arabic, French, German, ...)
// and naive label.slice(0, 2) produced wrong codes (German -> "ge").
const LABEL_TO_LANG = {
  english: "en",
  arabic: "ar",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  spanish: "es",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
  dutch: "nl",
  turkish: "tr",
  polish: "pl",
  hindi: "hi",
  indonesian: "id",
  thai: "th",
  vietnamese: "vi",
};

export function labelToSrclang(label) {
  const key = (label || "").toLowerCase();
  if (!key.trim()) return "en";
  for (const name of Object.keys(LABEL_TO_LANG)) {
    if (key.includes(name)) return LABEL_TO_LANG[name];
  }
  return key.trim().slice(0, 2);
}

// True when a source subtitle entry is English — used to stream English only.
// Prefers the human label; falls back to the language code; assumes English
// when the source provides neither.
export function isEnglishSubtitle({ label, srclang } = {}) {
  const l = String(label || "").trim().toLowerCase();
  const s = String(srclang || "").trim().toLowerCase();
  if (l && !l.startsWith("subtitle ")) return l.startsWith("english");
  if (s) return s.startsWith("en");
  return true;
}

// Final choke point: sanitise a stream list so only English subtitles can ever
// reach a client. Applied right before responses are serialised (and on cache
// reads, so payloads cached under older rules cannot leak other languages).
export function englishOnlyStreams(streams) {
  return (streams || []).map((s) => {
    if (!s || !Array.isArray(s.subtitles)) return s;
    return { ...s, subtitles: s.subtitles.filter(isEnglishSubtitle) };
  });
}

// Cue-level guard: some subtitle files stack several languages in one track
// (a Thai line, an Indonesian line, a Chinese line ... next to the English
// one). Drop any cue that contains no Latin letters at all but does contain a
// non-Latin script, keeping English cues and symbol-only cues (e.g. "♪").
export function englishOnlyVtt(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n/);
  const latin = /[A-Za-z]/;
  const nonLatin = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  const isTiming = (s) => s.includes("-->") || /^\d+$/.test(s);
  const out = [];
  blocks.forEach((block, idx) => {
    const t = block.trim();
    if (!t) return;
    if (idx === 0 && t.startsWith("WEBVTT")) { out.push(block); return; }
    if (/^(NOTE|STYLE|REGION)\b/.test(t)) { out.push(block); return; }
    const keptLines = block.split(/\r?\n/).filter((line) => {
      const s = line.trim();
      if (!s || isTiming(s)) return true;
      // Drop text lines that are pure non-Latin script (Thai, Chinese, Arabic,
      // Cyrillic, ...). Latin-script languages cannot be told apart by script.
      return latin.test(s) || !nonLatin.test(s);
    });
    const textLines = keptLines.filter((line) => { const s = line.trim(); return s && !isTiming(s); });
    if (textLines.length === 0) return; // nothing English left in this cue
    out.push(keptLines.join("\n"));
  });
  return out.join("\n\n") + "\n";
}
