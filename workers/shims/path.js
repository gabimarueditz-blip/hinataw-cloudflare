// path-browserify re-exported with both default and named exports so
// `import path from "path"` and `import { dirname, join } from "node:path"`
// both resolve in the Workers bundle. POSIX semantics only — correct on
// Cloudflare, and all call sites here build POSIX-style virtual paths.
import p from "path-browserify";

export const join = p.join;
export const dirname = p.dirname;
export const basename = p.basename;
export const normalize = p.normalize;
export const extname = p.extname;
export const resolve = p.resolve;
export const sep = "/";
export const posix = p;

export default p;
