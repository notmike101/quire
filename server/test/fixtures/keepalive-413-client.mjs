// Keep-alive client for the body-limit 413 socket test.
//
// Runs in a SEPARATE process from the server (spawned by the vitest test).
// This is deliberate: the real client (Playwright's driver) is a separate
// process with its own event loop, so it reads the 413 response promptly even
// while the server is tearing down the connection. A same-process client shares
// the server's event loop, gets busy writing the body, and misses the 413
// before the server's RST discards it — a race that does not exist in reality.
//
// Usage: node keepalive-413-client.mjs <port>
// Prints a single JSON object with the results of two scenarios, run in
// sequence over ONE keep-alive agent (the pooling client the fix targets).
//
// Both use the DECLARED-LENGTH (fast) path — the shape the real clients use
// (the CLI chunks at 19 MB WITH content-length; Playwright sets content-length
// for a known-size body). The middleware rejects on the header before any body
// is read. `fast` sends NO body bytes, so the server's receive buffer is clean
// when it closes: the 413 flushes and the socket closes without a kernel RST.
// (A scenario that ALSO sends body bytes is racy — the client has pushed body
// bytes into the server's receive buffer by the time the server closes, so the
// kernel RSTs and discards the queued 413; that is standard TCP behavior, not
// a defect, and the streaming no-content-length path is racy for the same
// reason. Neither is exercised here.)
import http from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isFinite(port) || port <= 0) {
  console.error('usage: node keepalive-413-client.mjs <port>');
  process.exit(2);
}

const MB = 1024 * 1024;
// keepAlive: true is the point — this is the client shape that pools sockets.
const agent = new http.Agent({ keepAlive: true });

/** True if the socket closes within `ms` (already closed counts as true). */
function closesWithin(socket, ms) {
  return new Promise((resolve) => {
    if (!socket || socket.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function post(path, body, declaredLength) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (declaredLength !== undefined) headers['content-length'] = String(declaredLength);
    // Once the response has started, a socket error is expected teardown (the
    // server closes while we may still be writing body bytes) — only a failure
    // BEFORE the first response byte is a reject.
    let responseStarted = false;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent, headers }, (res) => {
      responseStarted = true;
      // Node nulls res.socket once the response completes — grab it now.
      const sock = res.socket;
      let text = '';
      // The server closes the connection while we may still be writing body
      // bytes; the resulting RST surfaces as an 'error' on res/socket a tick
      // AFTER we resolve. Without listeners it is an uncaught exception.
      res.on('error', () => {});
      sock?.on('error', () => {});
      res.on('data', (d) => (text += d));
      // Resolve when the RESPONSE is complete.
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, connection: res.headers.connection ?? null, body: text, socket: sock }),
      );
    });
    req.on('error', (err) => {
      if (!responseStarted) reject(err);
    });
    if (body) req.end(body);
    else req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent }, (res) => {
      const sock = res.socket;
      let text = '';
      res.on('error', () => {});
      sock?.on('error', () => {});
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, socket: sock }));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

const out = { fast: null, full: null, next: null };
try {
  // 1. FAST: declared 21 MB, nothing sent — the middleware rejects on the
  //    header alone and never reads the (absent) body. The socket is by
  //    definition dirty; the response MUST advertise Connection: close AND the
  //    socket must actually close promptly (a keep-alive advertisement here
  //    invites the pooled-socket reuse that causes "socket hang up").
  const fast = await post('/api/chats', undefined, 21 * MB);
  out.fast = { status: fast.status, connection: fast.connection, closedWithin2s: await closesWithin(fast.socket, 2000) };

  // 2. FULL: declared 21 MB AND the full body actually sent (the shape the
  //    e2e 413 test and a real over-cap client use). The server rejects on the
  //    header; unless it DRAINS the body first, the unread body bytes in the
  //    receive buffer make the kernel RST the close and discard the queued 413
  //    → the client sees a bare ECONNRESET instead of the 413.
  const full = await post('/api/chats', Buffer.alloc(21 * MB, 1), 21 * MB);
  out.full = { status: full.status, connection: full.connection };

  // 3. NEXT: regression guard — closing the dirty socket must not break
  //    subsequent traffic; the agent simply opens a fresh connection.
  const next = await get('/healthz');
  out.next = { status: next.status, body: next.body };
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}

agent.destroy();
console.log(JSON.stringify(out));
process.exit(0);
