import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Chain B: cumulative per-share cap (1 GB). `MAX_UPLOAD_BYTES` caps a single
// request; this caps the TOTAL a share may grow to across create + chunks.
export const MAX_SHARE_BYTES = 1_073_741_824;

// Round 11: how much of an over-cap body to consume before answering the 413.
// Bounded so a huge (1 GB) or slow body can't hang the reject. Mirrors the
// @hono/node-server's own post-response drain (64 MB / 500 ms).
const DRAIN_CAP = 64 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 500;

/**
 * Read and discard up to `cap` bytes from `reader`, stopping after
 * `timeoutMs`. Used on an over-cap reject to consume the request body BEFORE
 * the response is sent, so the server can close the socket gracefully (a FIN,
 * not a RST). A RST — unread body bytes sitting in the receive buffer when the
 * socket closes — makes the kernel discard the queued 413, so a pooling client
 * sees a bare ECONNRESET instead of the response. Best-effort: never throws.
 */
async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cap: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let drained = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      if (drained >= cap || Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      const readPromise = reader.read();
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('drain timeout')), remaining);
      });
      try {
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        drained += value.byteLength;
      } catch {
        break; // timeout or read error — stop draining
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // The drain must never throw — a reject path is already in flight.
  }
}

/** Pure cap comparison (Chain B): would `added` bytes push `current` over `cap`? */
export function wouldExceedCap(currentBytes: number, addedBytes: number, cap: number = MAX_SHARE_BYTES): boolean {
  return currentBytes + addedBytes > cap;
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // script-src needs 'wasm-unsafe-eval': the SPA highlights code with Shiki,
    // which instantiates a WebAssembly module. WebAssembly.instantiate() is
    // governed by script-src and requires wasm-unsafe-eval (or a per-module
    // hash/nonce) — without it every code block in a transcript renders
    // unhighlighted and the console fills with CompileError. 'wasm-unsafe-eval'
    // only permits WASM compilation from already-same-origin ('self') sources;
    // it does NOT allow arbitrary JS eval, so the CSP stays strict.
    // Round 5: base-uri 'none' blocks an injected <base href> from rewriting
    // relative resource loads; form-action 'self' pins any form submission to
    // this origin. Both are no-ops for the current SPA (no <base>, no cross-
    // origin forms) but close the vectors if one is ever introduced.
    // Round 8 (D3): explicit connect-src/object-src/frame-src. connect-src
    // 'self' pins fetch/XHR/WebSocket to this origin (the SPA only talks to
    // its own API); object-src 'none' blocks <object>/<embed>; frame-src
    // 'none' blocks <iframe> to any origin. default-src 'self' already covers
    // all three as a fallback, but the explicit directives document intent and
    // survive a future default-src relaxation.
    c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'");
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Shared sessions are opt-in, password-gated, expiring transcripts — they must
    // never be crawled or indexed. The header is the authoritative signal (it is
    // honored even when a robots.txt is unreachable, e.g. on the SPA's client-routed
    // URLs); it is reinforced by a robots.txt and a <meta robots> tag in the SPA.
    c.header('X-Robots-Tag', 'noindex, nofollow');
  };
}

// Caps the request body. The `content-length` header is checked first as a
// cheap fast path (before any body is read) and rejects an oversized
// declaration. The body is then ALWAYS streamed and counted (a client that
// declares a small length but streams a large body is caught by the running
// count, not just the header). The request body is replaced with the buffered
// bytes so downstream handlers still read the full payload.
//
// Round 4: the moment the running count exceeds the cap the stream is torn
// down and a 413 is returned WITHOUT buffering the excess — the old code
// pushed every chunk into `chunks[]` first and only checked the cap after, so
// a chunked (no-content-length) body of arbitrary size was fully memory-buffered
// before the reject. That is a memory-exhaustion DoS: the shipped compose stack
// has no fronting proxy to catch it, so this middleware is the only guard.
//
// Round 11: every reject path answers with `Connection: close`. An over-cap
// 413 leaves the body unconsumed on the socket; advertising keep-alive (Node's
// default) invites a pooling client to reuse that socket while the server may
// still be draining — or force-closing (500 ms drain timeout) — the unread
// body. Under load that reuse lands on a socket the server is destroying:
// "socket hang up" (the e2e "lazy-loads subsequent pages" flake; Playwright's
// driver shares one keep-alive agent across all APIRequestContexts). nginx and
// Express do the same: close the connection on an oversized-body reject.
export function bodyLimit(maxBytes: number = MAX_UPLOAD_BYTES): MiddlewareHandler {
  return async (c, next) => {
    // Cheap fast path: reject an oversized DECLARED length before reading.
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Round 11: drain the body BEFORE answering so the socket close is a
      // graceful FIN, not a RST. Unread body bytes in the receive buffer make
      // the kernel RST the close, which discards the queued 413 — a pooling
      // client sees a bare ECONNRESET instead of the response. Bounded by
      // DRAIN_CAP / DRAIN_TIMEOUT_MS so a huge or slow body can't hang the
      // reject (a no-body declaration just hits the timeout).
      const body = c.req.raw.body;
      if (body) {
        const reader = body.getReader();
        await drainReader(reader, DRAIN_CAP, DRAIN_TIMEOUT_MS);
        reader.releaseLock();
      }
      c.header('Connection', 'close');
      return c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413);
    }
    // Always stream-count the ACTUAL bytes.
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            // Over the cap: stop buffering. Round 11: drain the REMAINDER
            // before answering so the socket close is a graceful FIN, not a
            // RST (unread body bytes would make the kernel discard the queued
            // 413 → the client sees a bare ECONNRESET). We have already read
            // `received` bytes, so the remaining drain is capped at
            // DRAIN_CAP - received. releaseLock (NOT reader.cancel): cancel
            // destroys the socket BEFORE the 413 flushes.
            await drainReader(reader, Math.max(0, DRAIN_CAP - received), DRAIN_TIMEOUT_MS);
            reader.releaseLock();
            c.header('Connection', 'close');
            return c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413);
          }
          chunks.push(value);
        }
      } catch {
        // The body stream errored mid-read: the connection state is suspect —
        // do not let a pooling client reuse it.
        reader.releaseLock();
        c.header('Connection', 'close');
        throw new HTTPException(400, { message: 'Failed to read request body' });
      }
      const body = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      c.req.raw = new Request(c.req.raw, { body, method: c.req.raw.method });
    }
    await next();
  };
}
