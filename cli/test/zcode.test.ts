import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
// Regenerate into a temp path (not the committed fixture) so the repo fixture
// is never dirtied by a test run. The committed sample-session.sqlite is the
// canonical artifact; the SQLite header's file-change counter makes any
// in-place rewrite byte-different even with fixed timestamps (M24).
let tempDir: string;
let fixtureDb: string;
// A 1×1 red PNG, base64 — the image the fixture's Read-image attachment points at.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
// The on-disk file the fixture's markdown image link (m8) points at. Created in
// beforeAll after tempDir exists; the path is injected into the fixture via the
// MD_IMAGE_PATH env var so it resolves to a real, readable file on any platform.
let mdImageFile: string;
// The on-disk file the fixture's screenshot tool call (m9/p15) references.
let screenshotFile: string;
// The artifact dir we seed for the fixture's Read-image attachment. Only removed
// in afterAll if we created it (i.e. it didn't pre-exist on the dev machine).
let fixtureArtDir: string;
let createdFixtureArtDir = false;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'quire-zcode-fixture-'));
  fixtureDb = join(tempDir, 'sample-session.sqlite');
  // Seed the on-disk file the markdown image link (m8) references, then inject
  // its file:// URL into the fixture so the adapter can read it.
  mdImageFile = join(tempDir, 'md-image-fix.png');
  writeFileSync(mdImageFile, Buffer.from(PNG_1X1, 'base64'));
  process.env.MD_IMAGE_PATH = `file://${mdImageFile.replace(/\\/g, '/')}`;
  // The screenshot tool call's input.filename. The fixture session's working
  // dir is /tmp (POSIX), which doesn't exist on Windows. We create a temp
  // working dir, put the screenshot file there, and pass it to the adapter via
  // the workDirOverride parameter so the join resolves correctly on all
  // platforms.
  screenshotFile = join(tempDir, 'screenshot-fix.png');
  writeFileSync(screenshotFile, Buffer.from(PNG_1X1, 'base64'));
  process.env.SCREENSHOT_FILENAME = 'screenshot-fix.png';
  execFileSync(process.execPath, [join(dir, 'fixtures', 'make-fixture-db.mjs'), fixtureDb]);
  // Seed the artifact store the fixture's Read-image attachment references. The
  // adapter resolves ~/.zcode/cli/artifacts/<sessionId>/, so write there. The
  // fixture session id is 'sess_fixture'.
  fixtureArtDir = join(homedir(), '.zcode', 'cli', 'artifacts', 'sess_fixture');
  createdFixtureArtDir = !existsSync(fixtureArtDir);
  mkdirSync(fixtureArtDir, { recursive: true });
  writeFileSync(join(fixtureArtDir, 'abc123-media-1-tool-result-fix1.txt'), `data:image/png;base64,${PNG_1X1}`);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  // Remove the artifact dir only if we created it (don't clobber a real one).
  if (createdFixtureArtDir) rmSync(fixtureArtDir, { recursive: true, force: true });
});

describe('zcode adapter', () => {
  it('lists non-subagent sessions, newest first', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const sessions = await makeZcodeAdapter(fixtureDb).listSessions();
    expect(sessions.map((s) => s.id)).toEqual(['sess_fixture', 'sess_older']);
    expect(sessions[0]!.title).toBe('Fixture Session');
    expect(sessions.every((s) => s.isSubagent === false)).toBe(true);
  });

  it('resolveCurrent returns the most recently updated session', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const current = await makeZcodeAdapter(fixtureDb).resolveCurrent();
    expect(current.id).toBe('sess_fixture');
  });

  it('loadSession shapes parts, drops noise, truncates tool output', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    expect(s.title).toBe('Fixture Session');
    expect(s.model).toBe('test-model');
    expect(s.provider).toBe('test-provider');
    expect(s.messages).toHaveLength(6); // system + model-only + continuation dropped
    expect(s.messages[0]!.role).toBe('user');
    expect(s.messages[0]!.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    const assistant = s.messages[1]!;
    // p2 text, p3 tool, p4 reasoning, p8 think-block text (split), p9 empty
    // think-block text (dropped to a text fallback), p11 Read-image tool (with
    // the image attached to the tool part, not a separate part).
    expect(assistant.parts.map((p) => p.type)).toEqual([
      'text', 'tool', 'reasoning', 'reasoning', 'text', 'text', 'tool',
    ]);
    const tool = assistant.parts[1]!;
    expect(tool.tool).toBe('Bash');
    expect(tool.callID).toBe('c1');
    expect(tool.input).toEqual({ command: 'ls' });
    expect(tool.output!).toContain('[truncated');
    // p8: a non-empty think block becomes a reasoning part, the trailing text
    // stays a text part.
    expect(assistant.parts[3]!.type).toBe('reasoning');
    expect(assistant.parts[3]!.text).toBe('\nLet me check the file.\n');
    expect(assistant.parts[4]!.type).toBe('text');
    expect(assistant.parts[4]!.text).toBe('\nNow let me read it.');
    // p9: an empty think block is dropped; the trailing text segment is kept.
    expect(assistant.parts[5]!.type).toBe('text');
    expect(assistant.parts[5]!.text).toBe('\n\nSure, here is the final answer.');
  });

  it('splits a pure <system-reminder> user message into a system part', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    const reminderMsg = s.messages[2]!;
    expect(reminderMsg.role).toBe('user');
    expect(reminderMsg.parts).toHaveLength(1);
    expect(reminderMsg.parts[0]!.type).toBe('system');
    // The nested <untrusted_objective> stays inside the system block content.
    expect(reminderMsg.parts[0]!.text).toContain('active session goal');
    expect(reminderMsg.parts[0]!.text).toContain('<untrusted_objective>');
    expect(reminderMsg.parts[0]!.text).toContain('make the thing');
  });

  it('drops harness-injected model-only user messages', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    // The fixture has 7 user/assistant messages: m1 (real user), m2 (assistant),
    // m4 (real user w/ system reminder), m5 (model-only todo nudge), m6
    // (continuation summary, no metadata), m7 (real user quoting the phrase).
    // m3 is a system message (skipped); m5 and m6 are dropped → 6 messages.
    expect(s.messages).toHaveLength(6);
    // No message may carry the model-only todo-nudge text.
    const allText = s.messages.flatMap((m) => m.parts)
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string');
    expect(allText.some((p) => p.text.includes('TodoWrite'))).toBe(false);
  });

  it('drops a continuation summary (summary field) but keeps a user message that quotes the phrase', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    const allText = s.messages.flatMap((m) => m.parts)
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string');
    // The harness-injected continuation summary (m6, tagged with a `summary`
    // field) must be dropped entirely.
    expect(allText.some((p) => p.text.startsWith('This session is being continued'))).toBe(false);
    // A REAL user message that merely quotes the phrase (m7, NO `summary` field)
    // must be kept verbatim — proving the drop is driven by the structural
    // marker, not by matching the phrase in the text.
    expect(allText.some((p) => p.text.includes('I did not type'))).toBe(true);
  });

  it('loadSession throws for an unknown id', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    await expect(makeZcodeAdapter(fixtureDb).loadSession('sess_nope')).rejects.toThrow(/not found/);
  });

  it('attaches a Read-image to the tool part (rendered inside the tool card)', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    const assistant = s.messages[1]!;
    // The Read-image tool part has the image attached to it (not a separate part).
    const toolIdx = assistant.parts.findIndex((p) => p.type === 'tool' && p.callID === 'c2');
    expect(toolIdx).toBeGreaterThan(-1);
    const tool = assistant.parts[toolIdx]!;
    expect(tool.type).toBe('tool');
    expect(tool.output).toBe('[Attached image/png: Read image]');
    // The image is attached to the tool part, not emitted as a separate part.
    expect(tool.images).toHaveLength(1);
    const img = tool.images![0]!;
    expect(img.mime).toBe('image/png');
    expect(img.src).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(img.bytes).toBe(Buffer.byteLength(PNG_1X1, 'base64'));
  });

  it('attaches a screenshot image to the tool part (rendered inside the tool card)', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    // Pass tempDir as the workDirOverride so the screenshot file (in tempDir)
    // resolves correctly regardless of the fixture session's /tmp working dir.
    const s = await makeZcodeAdapter(fixtureDb, tempDir).loadSession('sess_fixture');
    // m9 (index 5 of 6): a screenshot tool call. The messages are:
    // [0]=m1(user), [1]=m2(assistant), [2]=m4(user), [3]=m7(user),
    // [4]=m8(assistant), [5]=m9(assistant).
    const msg = s.messages[5]!;
    expect(msg.role).toBe('assistant');
    expect(msg.parts.map((p) => p.type)).toEqual(['tool']);
    const tool = msg.parts[0]!;
    expect(tool.type).toBe('tool');
    expect(tool.tool).toBe('mcp__playwright__browser_take_screenshot');
    expect(tool.callID).toBe('c3');
    // The screenshot image is attached to the tool part, not a separate part.
    expect(tool.images).toHaveLength(1);
    const img = tool.images![0]!;
    expect(img.mime).toBe('image/png');
    expect(img.src).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(img.alt).toBe('screenshot-fix.png');
    expect(img.bytes).toBe(Buffer.byteLength(PNG_1X1, 'base64'));
  });

  it('embeds a markdown image link in a text part as an image part', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    // m8 (index 4 of 6): an assistant text message with a ![alt](file://…)
    // link. The adapter reads the on-disk file and emits an image part after the
    // link-stripped text. m9 (the screenshot tool call) follows it.
    const msg = s.messages[4]!;
    expect(msg.role).toBe('assistant');
    expect(msg.parts.map((p) => p.type)).toEqual(['text', 'image']);
    // The text keeps the alt text but the file:// link is replaced by it.
    expect(msg.parts[0]!.type).toBe('text');
    expect(msg.parts[0]!.text).toBe('Here is the result:\n\n![my screenshot]\n\nDone.');
    expect(msg.parts[0]!.text).not.toContain('file://');
    // The image part carries the embedded data URI of the seeded file.
    const img = msg.parts[1]!;
    expect(img.type).toBe('image');
    expect(img.mime).toBe('image/png');
    expect(img.src).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(img.alt).toBe('my screenshot');
    expect(img.bytes).toBe(Buffer.byteLength(PNG_1X1, 'base64'));
  });

  it('emits a tooLarge image part when the artifact exceeds the cap', async () => {
    // Write an oversized artifact (just over MAX_IMAGE_BYTES) for a second
    // attachment id, then point a fresh part at it via a temp DB.
    const { MAX_IMAGE_BYTES } = await import('../src/image.js');
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const bigToolResultId = 'tool-result-big1';
    const bigArtifact = join(fixtureArtDir, `def456-media-1-${bigToolResultId}.txt`);
    // A data URI whose decoded payload is MAX_IMAGE_BYTES + 1.
    const payload = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    writeFileSync(bigArtifact, `data:image/png;base64,${payload.toString('base64')}`);
    try {
      // Build a one-off DB with a single Read-image part referencing the big artifact.
      const { DatabaseSync } = await import('node:sqlite');
      const oneOffDb = join(tempDir, 'big-image.sqlite');
      const db = new DatabaseSync(oneOffDb);
      db.exec(`
        create table session (id text primary key, title text, directory text, time_created integer, time_updated integer, task_type text, share_url text);
        create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text, sequence integer);
        create table part (id text primary key, message_id text, session_id text, data text, sequence integer);
      `);
      db.prepare('insert into session values (?,?,?,?,?,?,?)').run('sess_big', 'Big', '/tmp', 0, 0, 'interactive', null);
      db.prepare('insert into message (id, session_id, data, sequence) values (?,?,?,?)').run('mb', 'sess_big', JSON.stringify({ role: 'assistant' }), 1);
      db.prepare('insert into part values (?,?,?,?,?)').run('pb', 'mb', 'sess_big', JSON.stringify({
        type: 'tool', callID: 'cb', tool: 'Read',
        state: { status: 'completed', input: { file_path: '/tmp/big.png' }, output: '[Attached image/png: Read image]',
          attachments: [{ type: 'file', mime: 'image/png', filename: 'Read image', url: `zcode-artifact://sess_big/${bigToolResultId}`, metadata: { sizeBytes: MAX_IMAGE_BYTES + 1 } }] },
      }), 1);
      db.close();
      const s = await makeZcodeAdapter(oneOffDb).loadSession('sess_big');
      const tool = s.messages[0]!.parts.find((p) => p.type === 'tool')!;
      expect(tool.images).toHaveLength(1);
      const img = tool.images![0]!;
      expect(img.tooLarge).toBe(true);
      expect(img.src).toBeUndefined();
      expect(img.bytes).toBe(MAX_IMAGE_BYTES + 1);
    } finally {
      rmSync(bigArtifact, { force: true });
    }
  });
});
