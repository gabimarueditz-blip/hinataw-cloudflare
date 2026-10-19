// Moviebox relay for the Freebuff-hosted site.
//
// Why this exists: the moviebox API (aoneroom BFF + netfilm play endpoint) and
// its video CDN reject Cloudflare Workers' HTTP fingerprint (429/427) while
// accepting ordinary Node/undici clients — proven by direct comparison. The
// site itself runs on Freebuff; this 1-file Vercel function is the egress hop
// their API accepts. Same pattern the old Vercel deployment used natively.
//
// Contract: GET /api/relay?k=<RELAY_KEY>&u=<encoded https url>
//   - target host must be on the allowlist below (no open proxy)
//   - whitelisted request headers are forwarded (Authorization, Range, …)
//   - response status/headers pass through; the body streams (video needs it)

const ALLOWED_HOSTS = new Set([
  "h5-api.aoneroom.com",
  "netfilm.world",
  "bcdnxw.hakunaymatata.com",
]);
// The player "get-domain" endpoint returns a live host we can't enumerate
// up front; these suffixes cover the moviebox CDN/BFF family without turning
// the function into an open proxy.
const ALLOWED_HOST_SUFFIX = /(\.aoneroom\.com|\.hakunaymatata\.com|\.moviebox\.ph|\.netfilm\.world)$/i;

const FORWARD_REQUEST_HEADERS = [
  "authorization",
  "range",
  "referer",
  "origin",
  "accept",
  "accept-language",
  "content-type",
  "x-client-info",
  "x-request-lang",
  "user-agent",
];

// The player's browser cannot fetch the video CDN itself: a browser UA — and
// the page Referer a <video> request carries — is answered 429 on EVERY host.
// Forwarding the client's identity headers therefore made every MovieBox
// stream fail through this relay, so for CDN targets the client's gating
// headers are dropped and the profile the host actually accepts is substituted
// (the same split the Node proxy uses in core/moviebox.js): server 2 (bcdnxw)
// wants okhttp + the site Referer, bcdn wants okhttp and no Referer at all.
const CDN_HOST = /\.hakunaymatata\.com$/i;
const CDN_CLIENT_HEADERS = ["user-agent", "referer", "origin", "accept", "accept-language"];
const CDN_PROFILE_REFERER = {
  "user-agent": "okhttp/4.12.0",
  referer: "https://moviebox.ph/",
  origin: "https://moviebox.ph",
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
};
const CDN_PROFILE_APP = { "user-agent": "okhttp/4.12.0", accept: "*/*" };
const CDN_GATE_STATUS = new Set([403, 426, 428, 429, 451]);

// Server 2 (bcdnxw) is the primary mirror and carries the 1080p masters, so it
// is tried first for its own hosts. bcdn rejects a Referer outright, so it is
// only ever offered the app profile.
function cdnProfilesFor(hostname) {
  return /bcdnxw/i.test(String(hostname || ""))
    ? [CDN_PROFILE_REFERER, CDN_PROFILE_APP]
    : [CDN_PROFILE_APP];
}

const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "x-user",
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  const key = String(req.query.k || "");
  const expected = process.env.RELAY_KEY || "";
  if (!expected || key !== expected) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const target = String(req.query.u || "");
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.statusCode = 400;
    return res.end("Bad url");
  }
  if (parsed.protocol !== "https:" || !(ALLOWED_HOSTS.has(parsed.hostname) || ALLOWED_HOST_SUFFIX.test(parsed.hostname))) {
    res.statusCode = 403;
    return res.end("Host not allowed");
  }

  const isCdn = CDN_HOST.test(parsed.hostname);
  const baseHeaders = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (isCdn && CDN_CLIENT_HEADERS.includes(name)) continue;
    const value = req.headers[name];
    if (value !== undefined) baseHeaders[name] = value;
  }

  const profiles = isCdn ? cdnProfilesFor(parsed.hostname) : [null];
  let upstream = null;
  let lastStatus = 0;
  let lastErr = null;
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const headers = profile ? { ...baseHeaders, ...profile } : baseHeaders;
    const last = i === profiles.length - 1;
    try {
      const r = await fetch(parsed.toString(), {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(120000),
      });
      // A gate answer on a profile that has an alternative left is retried;
      // the last profile's answer is passed through as-is (404/gate alike) so
      // the player sees the real reason instead of a generic 502.
      if (last || !CDN_GATE_STATUS.has(r.status)) {
        upstream = r;
        break;
      }
      lastStatus = r.status;
      try { await r.body?.cancel(); } catch {}
    } catch (err) {
      lastErr = err;
    }
  }

  if (!upstream) {
    res.statusCode = lastStatus || 502;
    return res.end(
      lastErr && !lastStatus
        ? "Upstream error: " + (lastErr && lastErr.message)
        : "CDN declined the request (" + (lastStatus || "unreachable") + ")",
    );
  }

  res.statusCode = upstream.status;
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!upstream.body) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  }

  // Stream so large MP4s never buffer in the function; Range requests from the
  // player arrive as 206 partial responses and seek instantly.
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    try { res.end(); } catch {}
  }
}
