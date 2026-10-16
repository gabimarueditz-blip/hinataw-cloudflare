// node:vm shim for megaplay.js's signing-key extraction. It evaluates a script
// prefix with the provided context objects bound as parameters and `globalThis`
// bound to the context object (mirroring vm.runInNewContext's global binding).
// This is NOT a sandbox — same trust level as the Node version (both execute
// remote player script); failures are caught by megaplay and degrade to an
// unsigned URL.
export function runInNewContext(code, context, _options) {
  const ctx = context || {};
  const keys = Object.keys(ctx);
  const values = keys.map((k) => ctx[k]);
  const fn = new Function("globalThis", ...keys, String(code));
  fn(ctx, ...values);
}

export function createContext(obj) {
  return { ...(obj || {}) };
}

export default { runInNewContext, createContext };
