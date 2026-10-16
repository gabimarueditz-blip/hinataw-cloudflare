import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ".");

function readJson(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

const pj = readJson(resolve(root, ".vercel", "project.json"));
if (!pj?.projectId) { console.error("No projectId in .vercel/project.json"); process.exit(1); }

// The Vercel CLI reads VERCEL_TOKEN from the environment. Falling back to a
// local, git-ignored token file keeps the value out of the shell history and
// out of chat (create .vercel-token yourself; never commit it).
let token = process.env.VERCEL_TOKEN || "";
if (!token && existsSync(resolve(root, ".vercel-token"))) {
  token = readFileSync(resolve(root, ".vercel-token"), "utf8").split(/\r?\n/)[0].trim();
}

const childEnv = {
  ...process.env,
  VERCEL_ORG_ID: pj.orgId,
  VERCEL_PROJECT_ID: pj.projectId,
  ...(token ? { VERCEL_TOKEN: token } : {}),
};

function run(cmd, label) {
  console.log(`[deploy] ${label} …`);
  try {
    execSync(cmd, { cwd: root, env: childEnv, stdio: "inherit", timeout: 600_000 });
  } catch (e) {
    console.error(`[deploy] ${label} failed:`, e.message);
    process.exit(1);
  }
}

// 1. Rebuild the front-end bundle from public/index.html. It is embedded into
//    core/index-html.js, which is what both the dev server and the deploy serve.
run("node scripts/bundle-frontend.js", "bundling frontend assets");

// 2. Regenerate the whole deployable output from source. Skipping this step was
//    a real hazard: the script used to refresh only the HTML bundle inside a
//    pre-existing .vercel/output, so a deploy could ship a NEW frontend against
//    OLD backend modules (core/anime-router.js, core/moviebox.js, …).
run("npx --yes vercel@latest build --prod", "vercel build (regenerate .vercel/output)");

// 3. Deploy the freshly built output as-is.
if (!token) {
  console.warn("[deploy] No VERCEL_TOKEN (env or ./.vercel-token) — the CLI will likely answer 'Not authorized'.");
}
run(`npx --yes vercel@latest deploy --prod --yes --prebuilt`, `deploying ${pj.projectName || pj.projectId}`);
console.log("[deploy] done");
