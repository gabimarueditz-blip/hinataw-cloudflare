// Workers have no file: URLs — import.meta.url is the https worker URL.
// Normalize any URL to a POSIX path so dirname/join chains in hianime-sync
// and moviebox produce stable keys (/data/…, /.cache/…).
export function fileURLToPath(u) {
  const s = String(u);
  try {
    const url = new URL(s);
    let p = url.pathname || "/";
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    return p;
  } catch {
    return s.replace(/^file:\/\//, "");
  }
}

export function pathToFileURL(p) {
  return { href: "file://" + String(p) };
}

export default { fileURLToPath, pathToFileURL };
