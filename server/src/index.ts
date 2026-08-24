import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { serve } from '@hono/node-server';

const config = loadConfig();
const app = createApp(null, config);
serve({ fetch: app.fetch, port: config.port });
console.log(`quire server listening on :${config.port}`);
