// Terminal launcher for 9Anime dev server on Windows.
// Kept as a PS1 so PowerShell quoting is reliable.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const app = dirname(__dir);

const child = spawn("node", ["server.js"], {
  cwd: app,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { err += d.toString(); });

child.on("error", (e) => {
  console.error("spawn error:", e.message);
  process.exit(1);
});

child.on("exit", (code) => {
  if (code !== 0) console.error("node exit:", code, err.slice(0, 500));
});

console.log("launched pid=" + child.pid);
console.log("stdout:", out.trim());
console.error("stderr:", err.trim());
