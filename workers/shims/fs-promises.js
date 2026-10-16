// fs/promises is only imported by the IS_LOCAL_NODE branch of smartcache.js,
// which never executes on Workers; these stubs exist purely so the import
// resolves at build time.
export async function writeFile() { /* no-op */ }
export async function readFile() { throw new Error("fs/promises is not supported in the Workers build"); }
export async function unlink() { /* no-op */ }
export async function mkdir() { /* no-op */ }
export default { writeFile, readFile, unlink, mkdir };
