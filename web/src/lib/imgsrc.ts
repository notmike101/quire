/**
 * The only image sources the viewer will render: base64 data URIs (the
 * embedded screenshots) and same-origin absolute paths. Anything else
 * (http(s) URLs, `javascript:`, `data:text/html`, `file://`) is dropped —
 * the server stores what it stores, but the browser must not fetch or
 * execute from an untrusted origin. Only concrete raster types are accepted
 * (not svg+xml, which can carry SMIL animation and is never a screenshot).
 */
export function isSafeImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  if (/^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,/i.test(src)) return true;
  // Round 2: the same-origin branch is restricted to /assets/ (the only
  // same-origin image tree the SPA uses). A generic `/` would let a shared
  // session emit a same-origin <img> to any internal path.
  if (!src.startsWith('/assets/')) return false;
  // Round 8 (D2): the prefix alone is not a boundary — `/assets/../api/...`
  // (and its %2e%2e / backslash variants) would traverse out of the image tree
  // to any same-origin path (the router normalizes dot-segments before
  // routing). Vite asset names are hashes and never contain these, so reject
  // any src with a dot sequence, a percent-encoded dot, a backslash, or a
  // control character.
  if (src.includes('..')) return false;
  if (/%2e/i.test(src)) return false;
  if (src.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(src)) return false;
  return true;
}
