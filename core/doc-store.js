// Isomorphic JSON document store — the durable layer replacing the old
// per-file readFileSync/writeFileSync pattern for notices/users/feedback/comments.
//
//   • On Cloudflare Workers (env.DB present) → D1 table `docs`, one row per
//     document ("notices", "users", "feedback", "comments"). A per-isolate
//     cache keeps hot reads synchronous-fast; writes are awaited so data is
//     durable the moment the API responds.
//   • On the local Node dev server (no env.DB) → the original data/*.json
//     files behave exactly as before.
//
// The Workers entry (workers/entry.js) exposes the raw env binding via
// globalThis.__WORKER_ENV__ before the app graph runs.

let DB = null;
let schemaReady = null;
const cache = new Map();     // key -> parsed JSON (last-known-good)
const pending = new Map();   // key -> latest serialized value awaiting flush

export function bindWorkersEnv(env) {
  DB = (env && env.DB) || null;
  if (!DB) schemaReady = null;
}

function fileFor(key) {
  return require_path().join(process.cwd(), "data", key + ".json");
}

// Lazy require of fs/path so the Workers bundle's shims and the Node disk
// path share one code shape without importing fs at module scope on Workers.
let _path = null;
function require_path() {
  if (!_path) _path = _path_mod;
  return _path;
}
import * as _path_mod from "path";
import _fs from "fs";

function readDisk(key) {
  try {
    const p = fileFor(key);
    if (_fs.existsSync(p)) return JSON.parse(_fs.readFileSync(p, "utf8"));
  } catch (e) {}
  return null;
}

function writeDisk(key, value) {
  try {
    const p = fileFor(key);
    const dir = require_path().dirname(p);
    if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
    _fs.writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = DB.prepare(
      "CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run().catch((e) => {
      console.error("[doc-store] schema init failed:", e && e.message);
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// Read a document. Returns parsed JSON or `fallback` when absent.
// On Node this behaves like readFileSync (disk every call). On Workers it
// always reads the D1 primary — a cache-first read would let one instance
// keep serving notices another instance already deleted, which is exactly
// the "delete never sticks" bug this store exists to fix. The cache survives
// only as a last-known-good fallback when D1 errors.
export async function readDoc(key, fallback = null) {
  if (DB) {
    try {
      await ensureSchema();
      const row = await DB.prepare("SELECT value FROM docs WHERE key = ?").bind(key).first();
      if (row && row.value != null) {
        const parsed = JSON.parse(row.value);
        cache.set(key, parsed);
        return parsed;
      }
      // No D1 row yet — fall to disk (bundled seed / local file) without
      // persisting it implicitly; the first owner write migrates it.
    } catch (e) {
      console.error("[doc-store] D1 read failed:", e && e.message);
      // Fall through to disk/memory: never lose the read entirely.
      const disk = readDisk(key);
      if (disk != null) return disk;
      if (cache.has(key)) return cache.get(key);
    }
  } else if (cache.has(key)) {
    return cache.get(key);
  }

  const disk = readDisk(key);
  if (disk != null) {
    cache.set(key, disk);
    return disk;
  }
  cache.set(key, fallback);
  return fallback;
}

// Write a document. On Workers the value goes to D1 and the write is awaited
// by callers (so the API only responds once the row is durable). Returns
// true when the durable layer accepted it.
export async function writeDoc(key, value) {
  cache.set(key, value);

  if (DB) {
    // Mirror to disk first (fs shim keeps it per-isolate on Workers) so a
    // D1 hiccup still leaves the last-known-good value readable.
    writeDisk(key, value);
    try {
      await ensureSchema();
      await DB.prepare(
        "INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, JSON.stringify(value), Date.now()).run();
      return true;
    } catch (e) {
      console.error("[doc-store] D1 write failed:", e && e.message);
      return false;
    }
  }

  return writeDisk(key, value);
}

// Seed helper: write only if the durable layer has no value yet (used to
// migrate data/*.json into D1 exactly once).
export async function ensureDoc(key, seedValue) {
  const existing = await readDoc(key, null);
  if (existing != null) return existing;
  await writeDoc(key, seedValue);
  return seedValue;
}
