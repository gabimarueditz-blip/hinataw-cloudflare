// Freebuff Sites Worker entry.
//
// Responsibilities, in order:
//   1. Prime process.env from the deployment env BEFORE the app graph is
//      evaluated (the app reads ADMIN_PASSWORD & friends at module top level,
//      so the app is lazily imported on first request — esbuild inlines the
//      dynamic import as a lazily-initialized module).
//   2. Expose the raw env (env.DB binding) to core/doc-store.js via a global.
//   3. Serve the two routes index.js doesn't know about (/manga, the Vercel
//      analytics placeholder), then hand off to the stock app fetch handler.
import { bindWorkersEnv } from "../core/doc-store.js";
import { getMangaHtml, getAdHtml } from "../core/index-html.js";

let appPromise = null;

function primeEnv(env) {
  const flat = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      flat[k] = String(v);
    }
  }
  try {
    globalThis.process = globalThis.process || {};
    globalThis.process.env = Object.assign(globalThis.process.env || {}, flat);
    globalThis.process.cwd = globalThis.process.cwd || (() => "/");
    globalThis.process.versions = globalThis.process.versions || {};
  } catch (e) {}
}

async function loadApp(env) {
  primeEnv(env);
  bindWorkersEnv(env);
  if (!appPromise) {
    // Lazy so top-of-module env reads (ADMIN_PASSWORD, FEEDBACK_*, …) see the
    // deployment env instead of an empty object.
    appPromise = import("../index.js");
  }
  return appPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Manga portal: its own document (index.js has no route for it).
    if (path === "/manga" || path === "/manga.html") {
      await loadApp(env);
      return new Response(getMangaHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=0, must-revalidate",
        },
      });
    }

    // Sponsored tab the player opens for the owner ad.
    if (path === "/ad" || path === "/ad.html") {
      await loadApp(env);
      return new Response(getAdHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex",
        },
      });
    }

    // Vercel analytics placeholder (index.html ships the <Analytics/> tag).
    if (path === "/_vercel/insights/script.js") {
      return new Response("/* analytics placeholder — active on Vercel */", {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    const mod = await loadApp(env);
    const app = mod.default || mod;
    return app.fetch(request, env, ctx);
  },
};
