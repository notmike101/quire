// Builds a synthetic ZCode session store. Output path: argv[2], default
// cli/test/fixtures/sample-session.sqlite (keeps the repo fixture reproducible).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? join(dir, 'sample-session.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`
  create table if not exists session (id text primary key, title text, directory text, time_created integer, time_updated integer, task_type text, share_url text);
  create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text, sequence integer);
  create table if not exists part (id text primary key, message_id text, session_id text, data text, sequence integer);
`);
db.exec('delete from part; delete from message; delete from session;');
// Fixed epoch (2026-08-20T00:00:00Z) so the committed fixture is byte-stable
// across `pnpm test` runs (M24: Date.now() dirtied the tree every run).
const now = 1787232000000;
const insSession = db.prepare('insert into session (id, title, directory, time_created, time_updated, task_type, share_url) values (?,?,?,?,?,?,?)');
insSession.run('sess_fixture', 'Fixture Session', '/tmp', now - 3600_000, now, 'interactive', null);
insSession.run('sess_older', 'Older Session', '/tmp', now - 7200_000, now - 1800_000, 'interactive', null);
insSession.run('sess_sub', 'Subagent Session', '/tmp', now, now, 'subagent_child', null);
const insMsg = db.prepare('insert into message (id, session_id, data, sequence) values (?,?,?,?)');
insMsg.run('m1', 'sess_fixture', JSON.stringify({ role: 'user' }), 1);
insMsg.run('m2', 'sess_fixture', JSON.stringify({ role: 'assistant', modelID: 'test-model', providerID: 'test-provider' }), 2);
insMsg.run('m3', 'sess_fixture', JSON.stringify({ role: 'system' }), 3);
insMsg.run('m4', 'sess_fixture', JSON.stringify({ role: 'user' }), 4);
const insPart = db.prepare('insert into part (id, message_id, session_id, data, sequence) values (?,?,?,?,?)');
insPart.run('p1', 'm1', 'sess_fixture', JSON.stringify({ type: 'text', text: 'hello world' }), 1);
insPart.run('p2', 'm2', 'sess_fixture', JSON.stringify({ type: 'text', text: 'hi there' }), 1);
insPart.run('p3', 'm2', 'sess_fixture', JSON.stringify({ type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'completed', input: { command: 'ls' }, output: 'x'.repeat(30_000) } }), 2);
insPart.run('p4', 'm2', 'sess_fixture', JSON.stringify({ type: 'reasoning', text: 'thinking out loud' }), 3);
insPart.run('p5', 'm2', 'sess_fixture', JSON.stringify({ type: 'step-start' }), 4);
insPart.run('p6', 'm2', 'sess_fixture', JSON.stringify({ type: 'compaction' }), 5);
// A harness-injected goal-continuation reminder: the whole user message is a
// <system-reminder> block, which the adapter must split into a `system` part.
insPart.run('p7', 'm4', 'sess_fixture', JSON.stringify({ type: 'text', text: '<system-reminder>\nContinue working toward the active session goal.\n\n<untrusted_objective>\nmake the thing\n</untrusted_objective>\n</system-reminder>' }), 1);
db.close();
console.log(`fixture db written to ${dbPath}`);
