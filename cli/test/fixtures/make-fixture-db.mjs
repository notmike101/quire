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
// A harness-injected user message the model sees but the user never typed
// (visibility: "model-only"). The adapter must drop it entirely.
insMsg.run('m5', 'sess_fixture', JSON.stringify({ role: 'user', metadata: { visibility: 'model-only', source: 'todo_reminder' } }), 5);
// A harness-injected compaction/continuation summary: re-injected as a USER
// message tagged with a top-level `summary` field (NO metadata/visibility,
// unlike model-only context). The adapter must drop it — it is not something
// the user typed. The `summary` field is the structural discriminator.
insMsg.run('m6', 'sess_fixture', JSON.stringify({ role: 'user', summary: { kind: 'compaction', tokens: 1234 } }), 6);
// A REAL user message that merely QUOTES the continuation phrase. It has NO
// `summary` field, so the adapter must KEEP it — proving the drop is driven by
// the structural marker, not by matching the phrase in the text.
insMsg.run('m7', 'sess_fixture', JSON.stringify({ role: 'user' }), 7);
const insPart = db.prepare('insert into part (id, message_id, session_id, data, sequence) values (?,?,?,?,?)');
insPart.run('p1', 'm1', 'sess_fixture', JSON.stringify({ type: 'text', text: 'hello world' }), 1);
insPart.run('p2', 'm2', 'sess_fixture', JSON.stringify({ type: 'text', text: 'hi there' }), 1);
insPart.run('p3', 'm2', 'sess_fixture', JSON.stringify({ type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'completed', input: { command: 'ls' }, output: 'x'.repeat(30_000) } }), 2);
insPart.run('p4', 'm2', 'sess_fixture', JSON.stringify({ type: 'reasoning', text: 'thinking out loud' }), 3);
insPart.run('p5', 'm2', 'sess_fixture', JSON.stringify({ type: 'step-start' }), 4);
insPart.run('p6', 'm2', 'sess_fixture', JSON.stringify({ type: 'compaction' }), 5);
// A text part carrying a literal think block (reasoning model emitting its
// thinking inline). The adapter must split it into a `reasoning` part. The
// tag strings use the concatenation form so the literal markup is never
// mangled by any tool that strips HTML-ish tags from file contents.
const T_OPEN = '<' + 'think' + '>';
const T_CLOSE = '<' + '/' + 'think' + '>';
insPart.run('p8', 'm2', 'sess_fixture', JSON.stringify({ type: 'text', text: T_OPEN + '\nLet me check the file.\n' + T_CLOSE + '\nNow let me read it.' }), 6);
insPart.run('p9', 'm2', 'sess_fixture', JSON.stringify({ type: 'text', text: T_OPEN + '  \n\n  ' + T_CLOSE + '\n\nSure, here is the final answer.' }), 7);
// A harness-injected goal-continuation reminder: the whole user message is a
// <system-reminder> block, which the adapter must split into a `system` part.
insPart.run('p7', 'm4', 'sess_fixture', JSON.stringify({ type: 'text', text: '<system-reminder>\nContinue working toward the active session goal.\n\n<untrusted_objective>\nmake the thing\n</untrusted_objective>\n</system-reminder>' }), 1);
// Part for the model-only message — must be dropped along with its message.
insPart.run('p10', 'm5', 'sess_fixture', JSON.stringify({ type: 'text', text: "The TodoWrite tool hasn't been used recently." }), 1);
// Part for the continuation summary (m6) — leading phrase, no metadata. Must
// be dropped along with its message.
insPart.run('p12', 'm6', 'sess_fixture', JSON.stringify({ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n1. Primary Request and Intent: make the cactus.' }), 1);
// Part for the real user message (m7) that QUOTES the phrase with text before
// it — must be KEPT as a normal user message.
insPart.run('p13', 'm7', 'sess_fixture', JSON.stringify({ type: 'text', text: 'I saw a message starting with "This session is being continued from a previous conversation" that I did not type. Please check.' }), 1);
// A Read tool call on an image file. ZCode stores the viewed image as a data-URI
// artifact referenced by state.attachments[]. The adapter must emit an `image`
// part after the tool part. The artifact itself is created by the test (in a temp
// artifacts dir), not here — the fixture only carries the attachment reference.
insPart.run('p11', 'm2', 'sess_fixture', JSON.stringify({
  type: 'tool',
  callID: 'c2',
  tool: 'Read',
  state: {
    status: 'completed',
    input: { file_path: '/tmp/shot.png' },
    output: '[Attached image/png: Read image]',
    attachments: [{
      type: 'file',
      mime: 'image/png',
      filename: 'Read image',
      url: 'zcode-artifact://sess_fixture/tool-result-fix1',
      metadata: { sizeBytes: 68, storageKind: 'artifact' },
    }],
  },
}), 8);
db.close();
console.log(`fixture db written to ${dbPath}`);
