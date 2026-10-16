import fs from "fs";
import path from "path";
import worker from "../index.js";
import { handleAnimeApi } from "../core/anime-router.js";
import { getIndexHtml, getLogoSvg, getMangaHtml } from "../core/index-html.js";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

export default async function handler(req, res) {
  const pathname = req.url.split("?")[0];


  // 1. Anime streaming, HiAnime & India catalogs, MovieBox, manga, user
  // progress, feedback and notice endpoints.
  if (
    pathname.startsWith("/api/anime/") ||
    pathname.startsWith("/api/india/") ||
    pathname.startsWith("/api/moviebox/") ||
    pathname.startsWith("/api/manga/") ||
    pathname.startsWith("/api/hianime/") ||
    pathname.startsWith("/api/feedback/") ||
    pathname.startsWith("/api/notices") ||
    pathname.startsWith("/api/user/") ||
    pathname === "/api/diag" ||
    pathname === "/home" ||
    pathname === "/api/home"
  ) {
    // Same guard as server.js: an unhandled rejection from a provider throw
    // would surface as an uncaughtException instead of an error response.
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

  // 2. Direct provider scraper API endpoints (watch, episodes, stream, map, api docs)
  if (
    pathname.startsWith("/watch/") ||
    pathname.startsWith("/episodes/") ||
    pathname.startsWith("/stream/") ||
    pathname.startsWith("/map/") ||
    pathname === "/api/docs" ||
    pathname === "/api/raw"
  ) {
    const host = req.headers["host"] ?? "localhost";
    const url = `https://${host}${req.url}`;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;

    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body?.length ? body : undefined,
      duplex: "half",
    });

    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    return res.end(Buffer.from(buf));
  }

  // 2b. Standalone manga portal (/manga) — its own document, own tab.
  if (pathname === "/manga" || pathname === "/manga.html") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    return res.end(getMangaHtml());
  }

  // 3. Logo SVG asset
  if (pathname === "/logo.svg") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.end(getLogoSvg());
  }

  // 4. Vercel Web Analytics script (@vercel/analytics injects this on Vercel)
  if (pathname === "/_vercel/insights/script.js") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.end("/* Vercel Web Analytics placeholder — active when deployed on Vercel */");
  }

  // 5. Try serving other static assets from public/ if available on disk
  try {
    const sanitizedPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
    if (sanitizedPath !== "/" && sanitizedPath !== "" && sanitizedPath !== "index.html") {
      const targetFile = path.join(PUBLIC_DIR, sanitizedPath);
      if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
        const ext = path.extname(targetFile).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        return res.end(fs.readFileSync(targetFile));
      }
    }
  } catch (e) {}

  // 6. Default frontend SPA: Always serve Hinataw.exe streaming web app
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  return res.end(getIndexHtml());
}
