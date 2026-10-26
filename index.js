import { getMedia }                from "./core/anilist.js";
import { mapAnimeIds }             from "./core/mapper.js";
import mkissaHandler               from "./providers/mkissa.js";
import reanimeHandler              from "./providers/reanime.js";
import anikotoHandler              from "./providers/anikoto.js";
import animeggHandler              from "./providers/animegg.js";
import aninekoHandler              from "./providers/anineko.js";
import anidbappHandler             from "./providers/anidbapp.js";
import animenosubHandler           from "./providers/animenosub.js";
import anizoneHandler              from "./providers/anizone.js";
import aniwavesHandler             from "./providers/aniwaves.js";
import anibdHandler                from "./providers/anibd.js";
import senshiHandler               from "./providers/senshi.js";
import kaaHandler                  from "./providers/kickassanime.js";
import animedunyaHandler           from "./providers/animedunya.js";
import animeonsenHandler           from "./providers/animeonsen.js";
import { getEpisodesResponse, getFilteredEpisodesResponse } from "./core/episode-cache.js";
import { resolveProviders }         from "./core/episode-strategy.js";
import { getAsync, setAsync, isFresh, mapTTL, WATCH_TTL, _CACHE_ENABLED } from "./core/smartcache.js";
import { getIndexHtml, getLogoSvg, getPngAsset, getGifAsset, getSwJs } from "./core/index-html.js";
import { handleAnimeApi } from "./core/anime-router.js";

// Bridge the Node-style (req, res) anime router into the Web-standard fetch entrypoint.
async function runAnimeApi(request) {
  const req = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    // Node-style handlers read the body with `for await (const chunk of req)`.
    // Without this the async iterator is missing, so every POST handler
    // (portal login, comment posting, feedback submit) parsed an empty body.
    [Symbol.asyncIterator]: async function* () {
      if (!request.body) return;
      const buf = Buffer.from(await request.arrayBuffer());
      if (buf.length) yield buf;
    },
  };

  const outHeaders = {};
  let status = 200;
  let body = null;

  // Streaming support. A Node-style handler treats `res` as a sink it can
  // write into and forget; the entrypoint has no such luxury, so `write()`
  // feeds a ReadableStream that is handed to the platform the moment the first
  // byte is produced. Without this, every video segment and MovieBox byte was
  // accumulated in a Buffer before the response was even constructed — the
  // client saw nothing until the entire object had crossed the wire.
  const chunks = [];
  let controller = null;
  let closed = false;
  let wrote = false;
  let settle = null;
  const firstOutput = Promise.race([
    new Promise((resolve) => { settle = resolve; }),
  ]);

  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() { closed = true; },
  });

  const push = (chunk) => {
    const buf = chunk == null
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (buf.length) {
      chunks.push(buf);
      if (!closed && controller) {
        try { controller.enqueue(new Uint8Array(buf)); } catch {}
      }
    }
    return buf;
  };

  // Mirrors the Node property of the same name: true once the response has
  // started, so handlers can avoid mutating headers that are already gone.
  let headersSent = false;

  const res = {
    setHeader(name, value) { outHeaders[name] = value; },
    getHeader(name) { return outHeaders[name]; },
    get headersSent() { return headersSent; },
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    write(chunk) {
      headersSent = true;
      push(chunk);
      if (!wrote) { wrote = true; if (settle) settle(); }
      return true;
    },
    end(chunk) {
      headersSent = true;
      if (chunk != null) push(chunk);
      if (!closed) {
        closed = true;
        try { controller?.close(); } catch {}
      }
      if (settle) settle();
    },
  };

  handleAnimeApi(req, res)
    .catch((err) => {
      // A provider throw must not silently close the response: report it as a
      // JSON 502 so the client can show a real message. Pushing here is safe
      // because `wrote` stays false, so the buffered body is what gets sent.
      console.error("[api] route failed:", (err && err.message) || err);
      if (!wrote) {
        status = 502;
        outHeaders["Content-Type"] = "application/json; charset=utf-8";
        push(JSON.stringify({ success: false, error: "Provider temporarily unavailable" }));
      }
    })
    .finally(() => {
      if (!closed) {
        closed = true;
        try { controller?.close(); } catch {}
      }
      if (settle) settle();
    });

  // Wait only until the handler has produced its first byte or finished, so the
  // status and headers we hand back are the handler's real ones. Everything
  // already written is queued in the stream and leaves immediately.
  await firstOutput;

  return new Response(wrote ? stream : (body ?? Buffer.concat(chunks)), {
    status,
    headers: outHeaders,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function rewriteRequest(request, newPath) {
  const u = new URL(request.url);
  u.pathname = newPath;
  return new Request(u.toString(), { method: request.method, headers: request.headers });
}

const watchInflight = new Map();
const SIGNED_STREAM_WATCH_TTL = 60_000;

async function cachedWatch(cacheKey, handlerFn, ttl = WATCH_TTL) {
  const entry = await getAsync(cacheKey);
  if (entry && isFresh(entry)) return json(entry.data);

  if (watchInflight.has(cacheKey)) {
    await watchInflight.get(cacheKey).catch(() => {});
    const warm = await getAsync(cacheKey);
    if (warm && isFresh(warm)) return json(warm.data);
    return handlerFn();
  }

  const promise = (async () => {
    const response = await handlerFn();
    if (response.status === 200) {
      try {
        const data = await response.clone().json();
        await setAsync(cacheKey, data, ttl);
      } catch {}
    }
    return response;
  })();

  watchInflight.set(cacheKey, promise);
  try   { return await promise; }
  finally { watchInflight.delete(cacheKey); }
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Anime catalog / HiAnime / user-progress endpoints (core/anime-router.js)
    if (
      path.startsWith("/api/anime/") ||
      path.startsWith("/api/mux/") ||
      path.startsWith("/api/manga/") ||
      path.startsWith("/api/hianime/") ||
      path.startsWith("/api/feedback/") ||
      path.startsWith("/api/notices") ||
      path.startsWith("/api/user/") ||
      path === "/api/diag" ||
      path === "/api/home" ||
      path === "/home"
    ) {
      return runAnimeApi(request);
    }

    // Serve Hinataw.exe Frontend UI for Web Routes
    if (
      path === "/" ||
      path === "" ||
      path === "/index.html" ||
      path === "/app"
    ) {
      return new Response(getIndexHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=0, must-revalidate",
        },
      });
    }

    // Service worker (ad network) — must be served as JavaScript from the origin
    // root. Without this route it hit the HTML catch-all below and browsers
    // rejected the registration with a MIME-type error.
    if (path === "/sw.js") {
      return new Response(getSwJs(), {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/",
        },
      });
    }

    // Buffering animation. It is an <img> on the player page, so it has to be
    // served as a GIF from this origin: without an explicit route the HTML
    // catch-all answered with text/html and the browser refused the image
    // (ERR_BLOCKED_BY_ORB), leaving the buffer spinner blank on the deployed
    // site even though the dev server served public/ from disk.
    if (path === "/pikachu-buffer.gif") {
      const buf = getGifAsset("pikachu-buffer.gif");
      if (buf) {
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": "image/gif",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    }

    if (path === "/logo.svg") {
      return new Response(getLogoSvg(), {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Brand raster assets (favicon / logo PNGs) — bundled, since public/ is not served statically.
    // /favicon.ico maps to favicon.png: browsers probe it automatically, and without this
    // it falls through to the HTML catch-all and gets blocked (ERR_BLOCKED_BY_ORB).
    const pngName = path.match(/^\/(favicon\.(?:png|ico)|logo(?:-\d+)?\.png)$/);
    if (pngName) {
      const buf = getPngAsset(pngName[1] === "favicon.ico" ? "favicon.png" : pngName[1]);
      if (buf) {
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
    }

    let m = path.match(/^\/map\/(\d+)\/?$/);
    if (m) {
      const anilistId = m[1];
      const cacheKey  = `map:${anilistId}`;
      const entry     = await getAsync(cacheKey);
      if (entry && isFresh(entry)) return json(entry.data);

      try {
        const [data, media] = await Promise.all([
          mapAnimeIds(anilistId),
          getMedia(anilistId).catch(() => null),
        ]);
        await setAsync(cacheKey, data, mapTTL(media?.status ?? "RELEASING"));
        return json(data);
      } catch (e) {
        if (entry) return json(entry.data);
        return json({ error: e.message }, 500);
      }
    }

    m = path.match(/^\/episodes\/((?:[\w-]+\/)+)(\d+)\/?$/i);
    if (m) {
      const rawNames  = m[1].replace(/\/$/, "").split("/");
      const anilistId = m[2];
      const includeMap = url.searchParams.get("map") !== "false";
      const { resolved, unknown } = resolveProviders(rawNames);

      if (resolved.size === 0) {
        return json({ error: "No valid providers specified", unknown }, 400);
      }

      try {
        const data = await getFilteredEpisodesResponse(anilistId, resolved, includeMap);
        if (unknown.length) data._unknownProviders = unknown;
        return json(data);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    m = path.match(/^\/episodes\/(\d+)\/?$/);
    if (m) {
      const anilistId = m[1];
      try {
        return json(await getEpisodesResponse(anilistId, env));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    m = path.match(/^\/watch\/mkissa\/(\d+)\/(sub|dub)\/mkissa-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:mkissa:${id}:${audio}:${ep}`,
        () => mkissaHandler.fetch(request)
      );
    }

    if (path.match(/^\/captcha\/mkissa\/?$/)) {
      return mkissaHandler.fetch(request);
    }

    m = path.match(/^\/watch\/reanime\/(\d+)\/(sub|dub)\/reanime-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:reanime:${id}:${audio}:${ep}`,
        () => reanimeHandler.fetch(rewriteRequest(request, `/watch/${id}/${audio}/${ep}`))
      );
    }

    m = path.match(/^\/stream\/reanime\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return reanimeHandler.fetch(rewriteRequest(request, `/stream/${id}/${audio}/${ep}`));
    }

    m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anikoto:${id}:${audio}:${ep}`,
        () => anikotoHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL
      );
    }

    m = path.match(/^\/watch\/animegg\/(\d+)\/(sub|dub)\/animegg-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animegg:${id}:${audio}:${ep}`,
        () => animeggHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anineko\/(\d+)\/(sub|dub)\/anineko-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anineko:${id}:${audio}:${ep}`,
        () => aninekoHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anidbapp\/(\d+)\/(sub|dub)\/anidbapp-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anidbapp:${id}:${audio}:${ep}`,
        () => anidbappHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/animenosub\/(\d+)\/(sub|dub)\/animenosub-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animenosub:${id}:${audio}:${ep}`,
        () => animenosubHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anizone\/(\d+)\/(sub|dub)\/anizone-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anizone:${id}:${audio}:${ep}`,
        () => anizoneHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/aniwaves\/(\d+)\/(sub|dub)\/aniwaves-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:aniwaves:${id}:${audio}:${ep}`,
        () => aniwavesHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anibd\/(\d+)\/(sub|dub)\/anibd-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anibd:${id}:${audio}:${ep}`,
        () => anibdHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/senshi\/(\d+)\/(sub|dub)\/senshi-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:senshi:${id}:${audio}:${ep}`,
        () => senshiHandler.fetch(request),
        SIGNED_STREAM_WATCH_TTL
      );
    }

    m = path.match(/^\/watch\/kaa\/(\d+)\/(sub|dub)\/kaa-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:kaa:${id}:${audio}:${ep}`,
        () => kaaHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/animedunya\/(\d+)\/(sub|dub)\/animedunya-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animedunya:${id}:${audio}:${ep}`,
        () => animedunyaHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/animeonsen\/(\d+)\/(sub|dub)\/animeonsen-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animeonsen:${id}:${audio}:${ep}`,
        () => animeonsenHandler.fetch(request)
      );
    }

    if (path === "/api" || path === "/api/" || path === "/api/docs" || path === "/api/raw") {
      return json({
        name: "Hinataw.exe API 2.2.1",
        cache: _CACHE_ENABLED,
        providers: [
          "mkissa",
          "reanime",
          "anikoto",
          "animegg",
          "anineko",
          "anidbapp",
          "animenosub",
          "anizone",
          "aniwaves",
          "anibd",
          "senshi",
          "kaa",
          "animedunya",
          "animeonsen",
        ],
        routes: [
          "/map/:anilistId",
          "/episodes/:anilistId",
          "/episodes/:provider[/:provider...]/:anilistId?map=true|false",
          "/watch/mkissa/:id/sub|dub/mkissa-:ep",
          "/watch/reanime/:id/sub|dub/reanime-:ep",
          "/stream/reanime/:id/sub|dub/:ep",
          "/watch/anikoto/:id/sub|dub/anikoto-:ep",
          "/watch/animegg/:id/sub|dub/animegg-:ep",
          "/watch/anineko/:id/sub|dub/anineko-:ep",
          "/watch/anidbapp/:id/sub|dub/anidbapp-:ep",
          "/watch/animenosub/:id/sub|dub/animenosub-:ep",
          "/watch/anizone/:id/sub|dub/anizone-:ep",
          "/watch/aniwaves/:id/sub|dub/aniwaves-:ep",
          "/watch/anibd/:id/sub|dub/anibd-:ep",
          "/watch/senshi/:id/sub|dub/senshi-:ep",
          "/watch/kaa/:id/sub|dub/kaa-:ep",
          "/watch/animedunya/:id/sub|dub/animedunya-:ep",
          "/watch/animeonsen/:id/sub|dub/animeonsen-:ep",
        ],
      });
    }

    // Default: Serve Hinataw.exe streaming web app
    return new Response(getIndexHtml(), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  },
};
