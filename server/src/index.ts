import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { makeDb, migrateDb } from './db/client.js';
import { serve } from '@hono/node-server';

const config = loadConfig();
const db = makeDb(config.databaseUrl);
await migrateDb(db);
const app = createApp(db, config);
serve({ fetch: app.fetch, port: config.port });
console.log(`quire server listening on :${config.port}`);
