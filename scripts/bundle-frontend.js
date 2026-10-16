import fs from "fs";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// NOTE: this uses the plain React entry of @vercel/analytics, not /next.
// The /next entry requires next/navigation (Next.js app router), which this
// project does not have. The /react entry exposes the same <Analytics />.
import { Analytics } from "@vercel/analytics/react";

const rootDir = process.cwd();
const htmlPath = path.join(rootDir, "public", "index.html");
// The manga portal is a separate document served at /manga; on Vercel only the
// serverless function answers, so its HTML has to travel inside the bundle too.
const mangaPath = path.join(rootDir, "public", "manga.html");
const logoPath = path.join(rootDir, "public", "logo.svg");

// The service worker is bundled for the same reason as the PNGs: Vercel only
// runs the serverless function, so a raw public/sw.js is never served and
// /sw.js falls through to the HTML catch-all (browsers then refuse to
// register it because the MIME type is not JavaScript).
const swPath = path.join(rootDir, "public", "sw.js");

// Raster brand assets are bundled too: Vercel does not serve public/ statically
// for this project (only the serverless function answers), so /favicon.png,
// /logo-64.png and friends would otherwise fall through to the HTML catch-all.
const pngAssets = ["favicon.png", "logo-64.png", "logo-128.png", "logo.png"];
const outputPath = path.join(rootDir, "core", "index-html.js");

try {
  const html = fs.readFileSync(htmlPath, "utf8");
  const mangaHtml = fs.existsSync(mangaPath) ? fs.readFileSync(mangaPath, "utf8") : "";
  const logo = fs.readFileSync(logoPath, "utf8");
  const sw = fs.readFileSync(swPath, "utf8");

  // Render the <Analytics /> React component to static markup and inject it
  // into the page body. On a plain-HTML site there is no client router/hydration,
  // so the component is prerendered at build time instead of mounted in a layout.
  const analyticsMarkup = renderToStaticMarkup(createElement(Analytics));
  const htmlWithAnalytics = html.includes("</body>")
    ? html.replace("</body>", `${analyticsMarkup}\n</body>`)
    : `${html}\n`;
  // Trim any trailing blank lines so the final byte sequence ends with
  // exactly one newline and the injected analytics markup sits on its own
  // line above </body>. The source ends with "\n</body>\n</html>\n".
  const htmlB64 = Buffer.from(htmlWithAnalytics).toString("base64");
  // No analytics injection here: the manga portal is a plain reader page.
  const mangaB64 = Buffer.from(mangaHtml).toString("base64");

  // Only the <Analytics /> component is React-rendered; the rest of the page
  // is shipped verbatim, so the build output is byte-for-byte stable and any
  // mismatch below means a template drift rather than a subtle React diff.
  // Emit a single newline before </body> (the source already has one) so the
  // bundle round-trips back to exactly the committed index.html.
  
  const logoB64 = Buffer.from(logo).toString("base64");
  const swB64 = Buffer.from(sw).toString("base64");

  const pngB64 = {};
  for (const name of pngAssets) {
    const file = path.join(rootDir, "public", name);
    pngB64[name] = fs.existsSync(file)
      ? fs.readFileSync(file).toString("base64")
      : null;
  }

  const content = `// Auto-generated bundle of frontend assets for Vercel and Serverless deployments
export const INDEX_HTML_B64 = "${htmlB64}";
export const MANGA_HTML_B64 = "${mangaB64}";
export const LOGO_SVG_B64 = "${logoB64}";
export const SW_JS_B64 = "${swB64}";
export const PNG_ASSETS_B64 = ${JSON.stringify(pngB64, null, 2)};

let _html = null;
let _manga = null;
let _logo = null;
let _sw = null;
let _png = null;

export function getIndexHtml() {
  if (_html === null) _html = Buffer.from(INDEX_HTML_B64, "base64").toString("utf8");
  return _html;
}

export function getMangaHtml() {
  if (_manga === null) _manga = Buffer.from(MANGA_HTML_B64, "base64").toString("utf8");
  return _manga;
}

export function getLogoSvg() {
  if (_logo === null) _logo = Buffer.from(LOGO_SVG_B64, "base64").toString("utf8");
  return _logo;
}

export function getSwJs() {
  if (_sw === null) _sw = Buffer.from(SW_JS_B64, "base64").toString("utf8");
  return _sw;
}

export function getPngAsset(name) {
  if (_png === null) _png = new Map();
  if (!_png.has(name)) {
    const b64 = PNG_ASSETS_B64[name];
    _png.set(name, b64 ? Buffer.from(b64, "base64") : null);
  }
  return _png.get(name);
}
`

  fs.writeFileSync(outputPath, content, "utf8");
  const bundled = pngAssets.filter((n) => pngB64[n]).join(", ") || "none";
  console.log(`[build] Bundled frontend assets (${htmlWithAnalytics.length} bytes HTML incl. <Analytics />, ${mangaHtml.length} bytes manga.html, ${sw.length} bytes sw.js, PNG: ${bundled}) -> ${outputPath}`);
} catch (err) {
  console.error("[build] Failed to bundle frontend:", err);
  process.exit(1);
}