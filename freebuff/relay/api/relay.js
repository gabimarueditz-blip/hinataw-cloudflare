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

  const headers = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    res.statusCode = 502;
    return res.end("Upstream error: " + (err && err.message));
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
