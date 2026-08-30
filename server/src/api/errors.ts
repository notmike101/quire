import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Round 6: the handler previously logged the WHOLE error object
// (console.error('unhandled error:', err)), which dumps the stack plus every
// enumerable property. Two problems:
//   1. Log injection — an attacker who can influence an error's message (a
//      malformed body that a parser echoes back, a crafted value that surfaces
//      in an exception) could embed newlines / ANSI escapes to forge log lines
//      or clear the terminal.
//   2. Secret leakage — dumping the full object can carry untrusted fragments
//      (a parser/DB error that echoes input) into the log, violating the
//      "no secrets in logs" invariant.
// Fix: log only the error name plus a sanitized, length-bounded message.
// Control characters (incl. \n, \r, ESC) are replaced so the line cannot be
// forged or used as a terminal escape, and the message is truncated so a
// pathological error cannot bloat the log. The full object (stack + properties)
// is never dumped.
const LOG_MAX_LEN = 500;
function sanitizeForLog(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  const stripped = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return stripped.length > LOG_MAX_LEN ? stripped.slice(0, LOG_MAX_LEN) + '…' : stripped;
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http', message: err.message } }, err.status);
  }
  // Server-side log only. Never include request bodies, tokens, or secrets.
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : err;
  // Round 9 (B-F4): postgres.js errors embed the FULL SQL text AND the bound
  // parameters in err.message ("Failed query: ... params: ..."). A bound
  // parameter can be a password, a token, or the transcript itself — logging
  // it violates the "no secrets in logs" invariant. For those errors log only
  // the SQLSTATE code; the query text and parameters are omitted.
  let logged: string;
  if (err instanceof Error && /failed query/i.test(err.message)) {
    const code = (err as { code?: string }).code ?? 'unknown';
    logged = `Failed query (SQLSTATE ${code}; query text and parameters omitted)`;
  } else {
    logged = sanitizeForLog(message);
  }
  console.error('unhandled error:', name, logged);
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
};
