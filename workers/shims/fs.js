// Workers-safe replacement for Node's `fs`.
// Reads come from (1) a per-isolate memory map, (2) PRELOADED build-time files
// (data/hianime-cache.json is embedded by the build so the HiAnime catalog
// hydrates on cold start exactly like it did from disk on Node).
// Writes land in the per-isolate memory map only — durable user data
// (notices/users/feedback/comments) goes through core/cloud-store.js → D1.
import { PRELOADED } from "./preloaded.js";

const mem = new Map();

function keyOf(p) {
  const s = String(p).replace(/\\/g, "/");
  const i = s.indexOf("data/");
  if (i >= 0) return s.slice(i);
  const j = s.indexOf(".cache/");
  if (j >= 0) return s.slice(j);
  return s;
}

function enoent(p) {
  const e = new Error("ENOENT: no such file or directory, open '" + p + "'");
  e.code = "ENOENT";
  return e;
}

function readFileSync(p /*, encoding */) {
  const k = keyOf(p);
  if (mem.has(k)) return mem.get(k);
  if (Object.prototype.hasOwnProperty.call(PRELOADED, k)) return PRELOADED[k];
  throw enoent(p);
}

function writeFileSync(p, data) {
  mem.set(keyOf(p), typeof data === "string" ? data : String(data));
}

function existsSync(p) {
  const k = keyOf(p);
  return mem.has(k) || Object.prototype.hasOwnProperty.call(PRELOADED, k);
}

function mkdirSync() { /* no directories on Workers */ }
function unlinkSync(p) { mem.delete(keyOf(p)); }
function statSync(p) {
  if (!existsSync(p)) throw enoent(p);
  return { isFile: () => true, isDirectory: () => false, size: 0 };
}
function createReadStream() {
  throw new Error("createReadStream is not supported in the Workers build");
}

export {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  createReadStream,
  enoent as _enoent,
  keyOf as _keyOf,
  mem as _mem,
};

export default {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  createReadStream,
};
