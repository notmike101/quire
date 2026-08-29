/**
 * The only image sources the viewer will render: base64 data URIs (the
 * embedded screenshots) and same-origin absolute paths. Anything else
 * (http(s) URLs, `javascript:`, `data:text/html`, `file://`) is dropped —
 * the server stores what it stores, but the browser must not fetch or
 * execute from an untrusted origin.
 */
export function isSafeImageSrc(src: string | undefined): boolean {
  if (!src) return false;
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(src) || src.startsWith('/');
}
