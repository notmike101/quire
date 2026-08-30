import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Chain B: cumulative per-share cap (1 GB). `MAX_UPLOAD_BYTES` caps a single
// request; this caps the TOTAL a share may grow to across create + chunks.
export const MAX_SHARE_BYTES = 1_073_741_824;

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
export function bodyLimit(maxBytes: number = MAX_UPLOAD_BYTES): MiddlewareHandler {
  return async (c, next) => {
    // Cheap fast path: reject an oversized DECLARED length before reading.
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
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
            // Over the cap: stop immediately, do NOT buffer the excess.
            await reader.cancel().catch(() => {});
            return c.json({ error: { code: 'too_large', message: 'Request body too large' } }, 413);
          }
          chunks.push(value);
        }
      } catch {
        await reader.cancel().catch(() => {});
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
