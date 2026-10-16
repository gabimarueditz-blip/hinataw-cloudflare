// esbuild `inject` file: makes `Buffer` a free identifier everywhere in the
// bundle and patches the encodings the npm buffer package lacks
// ("base64url" — used by extractors/megaplay.js for signing) plus legacy
// escape/unescape used by the deobfuscation helpers.
import { Buffer as NodeBuffer } from "buffer";

const origFrom = NodeBuffer.from;
const origToString = NodeBuffer.prototype.toString;

function b64uToB64(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return t;
}

function b64ToB64u(s) {
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Buffer.from(str, "base64url") — decode via padded standard base64.
NodeBuffer.from = function from(value, encoding, ...rest) {
  if (typeof value === "string" && encoding === "base64url") {
    return origFrom.call(this, b64uToB64(value), "base64", ...rest);
  }
  return origFrom.call(this, value, encoding, ...rest);
};

// buf.toString("base64url") — encode as base64, then url-safe map.
NodeBuffer.prototype.toString = function toString(encoding, ...rest) {
  if (encoding === "base64url") {
    return b64ToB64u(origToString.call(this, "base64", ...rest));
  }
  return origToString.call(this, encoding, ...rest);
};

export { NodeBuffer as Buffer };

// Legacy globals still referenced by anime-router/hianime-service
// deobfuscation helpers (Annex B — not guaranteed on workerd).
if (typeof globalThis.escape !== "function") {
  globalThis.escape = function escape(str) {
    const s = String(str);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ch = s[i];
      if (/[A-Za-z0-9@*_+\-./]/.test(ch)) out += ch;
      else if (c < 256) out += "%" + c.toString(16).toUpperCase().padStart(2, "0");
      else out += "%u" + c.toString(16).toUpperCase().padStart(4, "0");
    }
    return out;
  };
}
if (typeof globalThis.unescape !== "function") {
  globalThis.unescape = function unescape(str) {
    return String(str).replace(/%u([0-9A-Fa-f]{4})|%([0-9A-Fa-f]{2})/g, (_, u, b) =>
      String.fromCharCode(parseInt(u || b, 16))
    );
  };
}
