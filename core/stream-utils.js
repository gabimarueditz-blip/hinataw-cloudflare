// Shared streaming helpers.
//
// Every media byte that leaves this app comes from an upstream `fetch()`
// Response and lands in a Node-style `res`. Buffering a whole segment (or a
// whole movie) before answering is what causes the "buffering" spinner: the
// player sits idle until the *entire* upstream object is in server memory.
// These helpers forward bytes as they arrive, with backpressure, so the first
// frame paints immediately and the process never holds a full transfer.

/** True when this response object can stream (Node/Vercel), not just buffer. */
export function canStream(res) {
  return Boolean(res) && typeof res.write === "function" && typeof res.end === "function";
}

/** True when a body has already been consumed and can no longer be read. */
export function isLocked(stream) {
  return !stream || stream.locked === true;
}

/**
 * Pipe an already-created reader into a Node-style response, optionally
 * emitting a chunk that was read earlier while sniffing the payload.
 * Writes are awaited through `drain` so a slow client cannot balloon memory,
 * and an aborted client cancels the upstream read. Never rejects.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {import("node:http").ServerResponse} res
 * @param {Uint8Array|null} [headChunk] Bytes read before the reader was handed over
 */
export async function pipeReader(reader, res, headChunk = null) {
  let aborted = false;
  const onAbort = () => { aborted = true; };
  if (typeof res.on === "function") res.on("close", onAbort);

  try {
    if (headChunk && headChunk.byteLength) {
      if (!res.write(Buffer.from(headChunk))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }

    for (;;) {
      if (aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
  } catch {
    // Upstream failed or the client hung up — stop reading, keep what was sent.
  } finally {
    if (typeof res.off === "function") res.off("close", onAbort);
    try { await reader.cancel(); } catch {}
    try { res.end(); } catch {}
  }
}

/**
 * Pipe an upstream web ReadableStream into a Node-style response.
 * Bails out quietly if the stream is missing or already consumed, so a caller
 * can never turn a mis-ordered read into an unhandled rejection.
 *
 * @param {ReadableStream<Uint8Array>} webStream
 * @param {import("node:http").ServerResponse} res
 */
export async function pipeWebStream(webStream, res) {
  if (isLocked(webStream)) return;
  let reader;
  try {
    reader = webStream.getReader();
  } catch {
    return;
  }
  return pipeReader(reader, res);
}

/** Read a reader to completion into a Buffer (non-streaming fallback only). */
export async function drainReader(reader) {
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) parts.push(Buffer.from(value));
    }
  } catch {}
  return Buffer.concat(parts);
}
