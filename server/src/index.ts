import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { makeDb, migrateDb } from './db/client.js';
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
const app = createApp({ db, config });
const server = serve({ fetch: app.fetch, port: config.port });
server.maxConnections = MAX_CONNECTIONS;
console.log(`quire server listening on :${config.port}`);
