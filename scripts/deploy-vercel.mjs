import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function readJson(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function readEnvFile(p) {
  if (!existsSync(p)) return {};
  return readFileSync(p, "utf8")
    .split("\n")
    .reduce((acc, line) => {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (!m) return acc;
      acc[m[1]] = m[2].replace(/^["']|["']$/g, "");
      return acc;
    }, {});
}

const projectJson = readJson(resolve(root, ".vercel", "project.json"));
if (!projectJson?.id) {
  console.error("No Vercel project ID found in .vercel/project.json");
  process.exit(1);
}

const projectId = projectJson.id;

// Prefer an already-authenticated `v` CLI. If the project has a .env.local with
// the deploy token, fall back to `vercel deploy` with the DEPLOY_HOOK_URL so
// we don't need interactive login.
const vRc = readEnvFile(resolve(root, ".vercel", "ignore"));
const envFile = readEnvFile(resolve(root, ".env.local"));
const env = { ...readEnvFile(resolve(root, ".env")), ...envFile };

let cmd;
if (env.VERCEL_TOKEN && env.VERCEL_URL) {
  // Use the deploy hook URL when available (non-interactive, no login needed).
  cmd = `vercel deploy --prod --token=${env.VERCEL_TOKEN} --project=${projectId}`;
} else {
  cmd = `vercel deploy --prod --yes --project=${projectId}`;
}

console.log(`[deploy] deploying project ${projectId} from ${root}`);
try {
  const out = execSync(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  console.log(out || "[deploy] completed");
} catch (e) {
  console.error("[deploy] failed:", (e.message || "").slice(0, 400));
  process.exit(1);
}
