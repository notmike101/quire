import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { makeDb, migrateDb } from './db/client.js';
import { cleanupStaleV2Uploads, cleanupExpiredV2 } from './db/cleanup.js';
import { serve } from '@hono/node-server';

// Round 6: bound the number of concurrent connections. The bodyLimit middleware
// buffers each in-flight request body in memory up to MAX_UPLOAD_BYTES (20 MB),
// so with no connection cap an attacker who opens many concurrent connections
// and streams/hangs large bodies can exhaust memory (N × 20 MB) or file
// descriptors. A personal session-sharing tool has low traffic; 128 concurrent
// connections is generous and bounds worst-case buffered memory to ~2.5 GB while
// still protecting against fd exhaustion and event-loop saturation. Beyond the
// cap, new connections wait in the OS accept backlog (or are refused if it
// fills) rather than being processed.
const MAX_CONNECTIONS = 128;

const config = loadConfig();
const db = makeDb(config.databaseUrl);
await migrateDb(db);
// Hourly: reclaim rows from v2 uploads that died mid-flight (state
// "uploading", older than 24h; complete shares are left alone). Also
// hard-delete expired v2 shares (the public route 410s them from expiry;
// this reclaims the rows). Run once at startup and then hourly; a cleanup
// failure must not take the server down. The SQL is static (no bound
// parameters), so an error message cannot carry user content.
const runCleanup = () =>
  Promise.all([cleanupStaleV2Uploads(db), cleanupExpiredV2(db)]).catch((e) =>
    console.error('cleanup failed:', e instanceof Error ? e.message : e),
  );
await runCleanup();
const cleanupTimer = setInterval(runCleanup, 60 * 60 * 1000);
cleanupTimer.unref?.();
const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port });
server.maxConnections = MAX_CONNECTIONS;
console.log(`quire server listening on :${config.port}`);
