// node:crypto subset backed by @noble/* (pure JS, Workers-safe, sync APIs).
// Covers exactly what the app graph uses:
//   - createHmac("sha256").update().digest("hex"|"base64url")  (portal tokens, megaplay signing)
//   - createDecipheriv("aes-128-cbc"|"aes-256-cbc")            (nova, megaplay)
//   - timingSafeEqual, randomBytes, webcrypto                  (portal auth, ids, extractors)
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha512 } from "@noble/hashes/sha512.js";
// MD5 is not a Workers-native digest, but the MovieBox mobile client signs
// every request with HMAC-MD5 (and md5(reversed(timestamp)) for its client
// token). Without it the moviebox API calls threw "Unsupported hash
// algorithm: md5" on the Worker, so MovieBox search returned nothing there
// while working on Node.
import { md5 } from "@noble/hashes/legacy.js";
import { cbc } from "@noble/ciphers/aes.js";

const ENCODER = new TextEncoder();

function toU8(v) {
  if (v == null) return new Uint8Array(0);
  if (typeof v === "string") return ENCODER.encode(v);
  if (v instanceof Uint8Array) return v;
  if (typeof v === "object" && v.buffer) return new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength);
  return ENCODER.encode(String(v));
}

function toBuf(u8) {
  return Buffer.from(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

function b64u(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const HASHES = { sha256, sha512, md5 };

export function createHash(alg) {
  const hash = HASHES[String(alg).toLowerCase()];
  if (!hash) throw new Error("Unsupported hash algorithm: " + alg);
  const chunks = [];
  return {
    update(data) { chunks.push(toU8(data)); return this; },
    digest(enc) {
      const out = hash(concat(chunks));
      return encode(out, enc);
    },
  };
}

export function createHmac(alg, key) {
  const hash = HASHES[String(alg).toLowerCase().replace(/[-_]/g, "")] || HASHES[String(alg).toLowerCase()];
  if (!hash) throw new Error("Unsupported HMAC algorithm: " + alg);
  const chunks = [];
  const k = toU8(key);
  return {
    update(data) { chunks.push(toU8(data)); return this; },
    digest(enc) {
      const out = hmac(hash, k, concat(chunks));
      return encode(out, enc);
    },
  };
}

function encode(bytes, enc) {
  if (enc === "hex" || enc === "latin1") {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return enc === "hex" ? s : toBuf(bytes).toString("latin1");
  }
  if (enc === "base64url") return b64u(bytes);
  if (enc === "base64") return toBuf(bytes).toString("base64");
  return toBuf(bytes);
}

export function createDecipheriv(alg, key, iv) {
  const norm = String(alg).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm !== "aescbc128" && norm !== "aescbc256") {
    throw new Error("Unsupported cipher: " + alg);
  }
  const chunks = [];
  return {
    // Node's decipher streams; every caller in this codebase does
    // Buffer.concat([decipher.update(allInput), decipher.final()]), so buffering
    // here and decrypting once in final() is behaviour-identical for them.
    update(data) { chunks.push(toU8(data)); return Buffer.alloc(0); },
    final() {
      const plain = cbc(toU8(key), toU8(iv)).decrypt(concat(chunks));
      return toBuf(plain);
    },
  };
}

export function timingSafeEqual(a, b) {
  const ua = toU8(a), ub = toU8(b);
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return toBuf(b);
}

export function randomUUID() {
  return crypto.randomUUID();
}

export const webcrypto = crypto;

function concat(list) {
  let len = 0;
  for (const c of list) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of list) { out.set(c, off); off += c.length; }
  return out;
}

const cryptoShim = {
  createHash,
  createHmac,
  createDecipheriv,
  timingSafeEqual,
  randomBytes,
  randomUUID,
  webcrypto,
};

export default cryptoShim;
