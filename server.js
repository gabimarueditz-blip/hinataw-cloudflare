// Native .env loader (zero external dependencies)
import { readFileSync, existsSync, statSync } from "node:fs";
try {
  if (existsSync(".env")) {
    const lines = readFileSync(".env", "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [k, ...v] = trimmed.split("=");
        if (k && !process.env[k.trim()]) {
          process.env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  }
} catch (e) {}
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";
import { handleAnimeApi } from "./core/anime-router.js";
import { initHiAnimeSyncEngine } from "./core/hianime-sync.js";
import { getIndexHtml, getMangaHtml, getAdHtml } from "./core/index-html.js";

const PORT  = Number(process.env.PORT) || 3000;
const BASE  = process.env.BASE_PATH ?? "";
const __dir = dirname(fileURLToPath(import.meta.url));

// The bundled page carries the <Analytics/> tag Vercel injects, so every
// deploy asks for /_vercel/insights/script.js. Only Vercel serves it; without a
// route here the HTML catch-all answered with index.html and the browser parsed
// that markup as JavaScript ("Uncaught SyntaxError: Unexpected token '<'" on
// every load). The Worker entry already ships this exact placeholder.
const ANALYTICS_STUB =
  "/* analytics placeholder — active on Vercel */";

const STATIC = {
  "/":               { inline: true },
  "/index.html":     { inline: true },
  "/app":            { inline: true },
  // The manga portal is its own document, opened in a new tab.
  "/manga.html":     { inlineManga: true },
  // Sponsored tab the player opens for the owner ad (the tag lives there, not
  // on the page the viewer is watching).
  "/ad":             { inlineAd: true },
  "/ad.html":        { inlineAd: true },
  "/docs":           { file: "docs/index.html",   mime: "text/html" },
  "/docs/":          { file: "docs/index.html",   mime: "text/html" },
  "/api-home":       { file: "docs/landing.html", mime: "text/html" },
  "/style.css":      { file: "docs/style.css",    mime: "text/css"  },
  "/docs/style.css": { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":       { file: "docs/logo.svg",     mime: "image/svg+xml" },
  "/docs/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
  "/sw.js":          { file: "public/sw.js",     mime: "application/javascript" },
  "/_vercel/insights/script.js": { js: ANALYTICS_STUB },
  // Buffer loader art (transparent GIF) served from disk like sw.js.
  "/pikachu-buffer.gif": { file: "public/pikachu-buffer.gif", mime: "image/gif" },
};

function serveStatic(req, res, entry) {
  if (entry.js) {
    res.writeHead(200, {
      "Content-Type":  "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Content-Length": Buffer.byteLength(entry.js),
    });
    return req.method === "HEAD" ? res.end() : res.end(entry.js);
  }
  if (entry.inline || entry.inlineManga || entry.inlineAd) {
    try {
      const body = entry.inlineAd ? getAdHtml() : entry.inlineManga ? getMangaHtml() : getIndexHtml();
      res.writeHead(200, {
        "Content-Type":  "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Length": Buffer.byteLength(body),
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(body);
      }
      return;
    } catch {
      res.writeHead(500);
      res.end("Failed to load built frontend");
      return;
    }
  }
  try {
    const body = readFileSync(join(__dir, entry.file));
    res.writeHead(200, {
      "Content-Type":  entry.mime + "; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": Buffer.byteLength(body),
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function nodeToRequest(req) {
  const host     = req.headers["host"] ?? `localhost:${PORT}`;
  const stripped = BASE && req.url.startsWith(BASE) ? req.url.slice(BASE.length) || "/" : req.url;
  const url      = `http://${host}${stripped}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method:  req.method,
    headers: req.headers,
    body:    body?.length ? body : undefined,
    duplex:  "half",
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`→ ${req.method} ${req.url}`);

  const pathname = req.url.split("?")[0];
  const staticEntry = STATIC[pathname] || STATIC[pathname.replace(/\/+$/, "")] || STATIC[pathname + "/"];

  if ((req.method === "GET" || req.method === "HEAD") && staticEntry) {
    return serveStatic(req, res, staticEntry);
  }

  // Handle Anime Frontend, HiAnime API, Manga, User Auth/Sync, and Feedback routes.
  if (
    pathname.startsWith("/api/anime/") ||
    pathname.startsWith("/api/mux/") ||
    pathname.startsWith("/api/manga/") ||
    pathname.startsWith("/api/hianime/") ||
    pathname.startsWith("/api/feedback/") ||
    pathname.startsWith("/api/notices") ||
    pathname.startsWith("/api/user/") ||
    pathname === "/api/diag" ||
    pathname === "/home" ||
    pathname === "/api/home"
  ) {
    // A rejected handler with no await/catch becomes an unhandled rejection,
    // which on Node terminates the process. One 404 title page from the Hindi
    // source used to take the whole server down, so every router throw is
    // converted into a JSON response here instead.
    try {
      return await handleAnimeApi(req, res);
    } catch (err) {
      console.error("[api] route failed:", (err && err.message) || err);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ success: false, error: "Provider temporarily unavailable" }));
      }
      return;
    }
  }

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hinataw.exe dev server → http://0.0.0.0:${PORT}`);
  initHiAnimeSyncEngine();
});
