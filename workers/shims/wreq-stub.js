// Stand-in for wreq-js: TLS-fingerprint sessions cannot exist on Workers.
// core/wreq.js already falls back to plain fetch on import failure — this stub
// makes that fallback explicit and keeps the bundle free of Node networking.
export async function createSession() {
  return {
    fetch: (url, opts) => fetch(url, opts),
    close: async () => {},
  };
}

export default { createSession };
