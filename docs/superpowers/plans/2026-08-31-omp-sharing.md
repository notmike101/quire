# Oh My Pi Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace interactive, persisted OMP TUI `/share` with an exact-session Quire publish using strict redaction, no password, and no expiry.

**Architecture:** OMP's supported custom handler passes its temporary HTML export path to `quire publish <path> --harness omp --preset strict --yes`. A new CLI adapter extracts the bounded base64 `SessionData`, reconstructs only the selected branch, normalizes visible content into `ShapedSession`, and then reuses Quire's unchanged preview, chunking, upload, server-redaction, storage, and viewer pipeline.

**Tech Stack:** TypeScript ESM, Node.js 22+, Bun-compatible ESM handler, Vitest, tsup, pnpm, OMP v3 session export schema.

**Spec:** `docs/superpowers/specs/2026-08-31-omp-sharing-design.md`

## Global Constraints

- Support only interactive, persisted OMP TUI sessions; headless/ACP and `--no-session` remain OMP-native.
- `/share` always uses `--preset strict --yes` with no password or expiration flags.
- Parse the temporary HTML as bounded data; never execute scripts, load it in a browser, scrape rendered markup, or fetch remote content.
- Publish only the branch selected by `leafId`; omit abandoned branches and `subSessions`.
- Omit system prompts, tool definitions, initialization data, hidden/extension-private state, account pins, and bookkeeping entries.
- Restrict local image reads to the header `cwd` and `additionalDirectories`.
- Keep server ingestion redaction authoritative; do not add client-side redaction.
- Never overwrite or chain an existing OMP `share.ts`, `share.js`, or `share.mjs` handler.
- Add no runtime dependency.
- Keep ZCode, Claude Code, Codex, server, and viewer behavior unchanged.
- After any `cli/src` change, remove and rebuild `cli/dist` before testing the built binary.
- Update `.superpowers/omp-sharing-progress.md` after every task with commit, tests, decisions, and next action.

---

### Task 1: Parse bounded OMP exports and reconstruct the active branch

**Files:**
- Create: `cli/src/harness/omp.ts`
- Create: `cli/test/omp.test.ts`
- Modify: `cli/src/harness/types.ts:50-54`

**Interfaces:**
- Consumes: `HarnessAdapter`, `HarnessSessionInfo`, and `ShapedSession` from `cli/src/harness/types.ts`.
- Produces: `OMP_MAX_HTML_BYTES`, `OMP_MAX_SESSION_DATA_BYTES`, `extractOmpSessionData(html: string, options?: Pick<OmpAdapterOptions, 'maxHtmlBytes' | 'maxSessionDataBytes'>): OmpSessionData`, `activeOmpBranch(data: OmpSessionData): OmpEntry[]`, and `makeOmpAdapter(options?: OmpAdapterOptions): HarnessAdapter`.
- `OmpAdapterOptions` is `{ maxHtmlBytes?: number; maxSessionDataBytes?: number; maxMessages?: number; maxImageBytes?: number }` so tests can exercise limits without large fixtures.

- [ ] **Step 1: Add valid-export and branch fixtures in the failing adapter test**

Create fixture helpers directly in `cli/test/omp.test.ts`; use fixed timestamps and temporary files so no real OMP transcript can be committed:

```ts
interface TestEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

function ompHtml(data: unknown, attrs = 'id="session-data" type="application/json"'): string {
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  return `<!doctype html><script ${attrs}>${encoded}</script>`;
}

function writeExport(data: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quire-omp-'));
  const path = join(dir, 'current session.html');
  writeFileSync(path, ompHtml(data));
  return { dir, path };
}

const header = {
  type: 'session', version: 3, id: 'omp-session-1',
  timestamp: '2026-08-31T12:00:00.000Z', cwd: 'D:/workspace', title: 'OMP fixture',
};
const root: TestEntry = { type: 'message', id: 'root0001', parentId: null, timestamp: '2026-08-31T12:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'root' }] } };
const selected: TestEntry = { type: 'message', id: 'keep0001', parentId: 'root0001', timestamp: '2026-08-31T12:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'selected' }] } };
const abandoned: TestEntry = { type: 'message', id: 'drop0001', parentId: 'root0001', timestamp: '2026-08-31T12:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] } };
```

Assert that a single valid script is decoded, harmless attribute order/whitespace variants work, and `activeOmpBranch({ header, entries: [root, abandoned, selected], leafId: 'keep0001' })` returns `[root, selected]`.

- [ ] **Step 2: Add fail-closed parser and graph tests**

Add table-driven assertions for:

```ts
const invalidHtml = [
  '<html></html>',
  '<script id="session-data" type="application/json">%%%not-base64%%%</script>',
  `${ompHtml({ header, entries: [], leafId: null })}${ompHtml({ header, entries: [], leafId: null })}`,
];
```

Also assert rejection for invalid JSON, encoded and decoded size overflow, non-array `entries`, missing/non-string header ID, missing leaf, duplicate entry IDs, a missing parent, and a two-node cycle. Error matches must identify OMP and the failure class without containing fixture message text.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm --filter @quire/cli test -- omp.test.ts`

Expected: FAIL because `../src/harness/omp.js` does not exist and `'omp'` is not assignable to `HarnessAdapter.name`.

- [ ] **Step 4: Implement the bounded extractor and graph walk**

Start `cli/src/harness/omp.ts` with focused structural types:

```ts
import { lstat, readFile } from 'node:fs/promises';
import type { HarnessAdapter, ShapedSession } from './types.js';
import { MAX_SESSION_MESSAGES } from '../shape.js';
import { MAX_SESSION_IMAGE_BYTES } from '../image.js';

export const OMP_MAX_HTML_BYTES = 32 * 1024 * 1024;
export const OMP_MAX_SESSION_DATA_BYTES = 20 * 1024 * 1024;

interface OmpHeader {
  type: 'session';
  id: string;
  timestamp?: string;
  cwd?: string;
  title?: string;
  additionalDirectories?: string[];
}

interface OmpEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

interface OmpSessionData {
  header: OmpHeader | null;
  entries: OmpEntry[];
  leafId: string | null;
}

export interface OmpAdapterOptions {
  maxHtmlBytes?: number;
  maxSessionDataBytes?: number;
  maxMessages?: number;
  maxImageBytes?: number;
}
```

Use one global case-insensitive script-tag scan, parse attributes without executing HTML, and require exactly one tag with exact `id`/`type` values. Before `Buffer.from(body, 'base64')`, require compact body text to match `/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`. Check `Buffer.byteLength(html)` and decoded buffer length against injected limits. Parse JSON, validate required shapes, and never include payload values in errors.

Implement `activeOmpBranch()` with a `Map<string, OmpEntry>` and `Set<string>` cycle detector. For `leafId === null` with zero entries return `[]`; otherwise require the leaf and every parent, then reverse the collected chain.

Implement the initial adapter methods:

```ts
return {
  name: 'omp',
  async listSessions() { return []; },
  async resolveCurrent() {
    throw new Error('OMP --current is unsupported; run /share in OMP so it can supply the exact export path');
  },
  async loadSession(exportPath: string): Promise<ShapedSession> {
    const stat = await lstat(exportPath);
    if (!stat.isFile() || stat.size > maxHtmlBytes) throw new Error('invalid OMP export file');
    const data = extractOmpSessionData(await readFile(exportPath, 'utf8'), limits);
    const branch = activeOmpBranch(data);
    return { sessionId: data.header!.id, title: data.header!.title ?? data.header!.id, messages: shapeBranch(branch, data.header!, limits) };
  },
};
```

For this task define `shapeBranch()` to return `[]`; Task 2 replaces it. Use `lstat`, not `stat`, and reject symbolic links so a replaced temporary path cannot redirect Quire to an unrelated file.

Update `HarnessAdapter.name` to include `'omp'`.

- [ ] **Step 5: Run focused verification**

Run: `pnpm --filter @quire/cli test -- omp.test.ts`

Run: `pnpm --filter @quire/cli typecheck`

Expected: PASS; no Vitest Errors section.

- [ ] **Step 6: Update handoff log and commit**

Record the commit, exact commands/results, any OMP schema observation, and Task 2 as next in `.superpowers/omp-sharing-progress.md`.

```bash
git add cli/src/harness/omp.ts cli/src/harness/types.ts cli/test/omp.test.ts
git commit -m "feat(cli): parse OMP session exports"
```

---

### Task 2: Shape visible OMP conversation content

**Files:**
- Modify: `cli/src/harness/omp.ts`
- Modify: `cli/src/image.ts`
- Modify: `cli/src/harness/zcode.ts`
- Modify: `cli/test/omp.test.ts`
- Modify: `cli/test/image.test.ts`
- Modify: `cli/test/zcode.test.ts`

**Interfaces:**
- Consumes: the validated active branch from Task 1; `truncateInput`, `truncateOutput`, and `MAX_SESSION_MESSAGES` from `cli/src/shape.ts`; `fileToDataUri`, image MIME helpers, and image limits from `cli/src/image.ts`.
- Produces: `shapeOmpBranch(branch: OmpEntry[], header: OmpHeader, options: Required<Pick<OmpAdapterOptions, 'maxMessages' | 'maxImageBytes'>>): ShapedMessage[]` and shared `embedLocalMarkdownImages(text: string, roots: string[], budget: ImageBudget): { text: string; images: ShapedPart[] }` in `cli/src/image.ts`.

- [ ] **Step 1: Add a comprehensive failing shaping fixture**

Build one active branch containing fixed entries for:

```ts
const visibleEntries = [
  entry('message', 'u1', null, { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  entry('message', 'a1', 'u1', { message: { role: 'assistant', provider: 'anthropic', model: 'claude-test', content: [
    { type: 'thinking', thinking: 'considered options' },
    { type: 'text', text: 'checking' },
    { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
  ] } }),
  entry('message', 't1', 'a1', { message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'file contents' }] } }),
  entry('custom_message', 'c1', 't1', { display: true, customType: 'notice', content: 'Visible notice' }),
  entry('reset_boundary', 'r1', 'c1', {}),
  entry('message', 'a2', 'r1', { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
];
```

The canonical OMP fields are fixed here: text is `{ type: 'text', text }`, thinking is `{ type: 'thinking', thinking }`, a call is `{ type: 'toolCall', id, name, arguments }`, an image is `{ type: 'image', data, mimeType }`, and a tool-result message is `{ role: 'toolResult', toolCallId, toolName, content, isError, timestamp }`. Assert ordered user text, reasoning, assistant text, paired tool output, visible system notice, reset notice, and final text. Assert session `model === 'claude-test'` and `provider === 'anthropic'` are derived only from retained ordinary messages.

- [ ] **Step 2: Add exclusion and limit tests**

Add entries for `session_init`, hidden `custom_message`, `custom`, `credential_pin`, `model_change`, `thinking_level_change`, `service_tier_change`, `mode_change`, `label`, `title_change`, `ttsr_injection`, `compaction`, and `branch_summary`; give each a unique sentinel secret and assert none appears in serialized output.

Also assert:

- exported top-level `systemPrompt`, `tools`, and `subSessions` sentinels are absent;
- an orphan tool result is absent and an incomplete tool call remains;
- inputs and outputs use existing truncation helpers;
- reaching an injected two-message cap keeps only two shaped messages and emits one content-free warning;
- OMP `{ type: 'image', data, mimeType }` blocks obey per-image and cumulative budgets;
- `https:` images are never fetched;
- markdown image links inside `cwd` and `additionalDirectories` may embed;
- traversal, symlink, and out-of-root image paths are not opened; and
- malformed individual content parts are skipped without failing the whole valid export.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm --filter @quire/cli test -- omp.test.ts`

Expected: FAIL because Task 1 returns an empty message array.

- [ ] **Step 4: Implement minimal message normalization**

Use structural checks, never substring classification. Map only:

```ts
switch (entry.type) {
  case 'message':
    // Accept message roles user, assistant, and toolResult only.
    break;
  case 'custom_message':
    // Keep only display === true as a system part.
    break;
  case 'reset_boundary':
    // Emit { role: 'assistant', parts: [{ type: 'system', text: 'Conversation cleared' }] }.
    break;
  default:
    // Omit all bookkeeping and extension-private entries.
}
```

For assistant content, keep source order and create tool parts as:

```ts
const tool: ShapedPart = {
  type: 'tool',
  callID: content.id,
  tool: content.name,
  status: content.status,
  input: truncateInput(content.arguments ?? content.input),
};
```

Store retained calls in `Map<string, ShapedPart>`; a later `toolResult` updates only its matching retained part with `truncateOutput(textResult(content))`. Do not create a separate viewer message for a paired result.

Map `thinking` to `reasoning`, ordinary text to `text`, and OMP's base64 `image.data` plus `image.mimeType` to `image`. Reject unsupported MIME types before decoding and apply the existing per-image/session budgets.

Move ZCode's existing local-markdown image resolution into `embedLocalMarkdownImages()` in `cli/src/image.ts`, preserving its current behavior and tests. The helper accepts explicit workspace roots, tries relative paths against each root, accepts absolute/file URLs only when contained by at least one root, and delegates byte/MIME enforcement to `fileToDataUri()`. Use it from both ZCode (with its single work directory) and OMP (with normalized `cwd` plus `additionalDirectories`). Leave remote schemes untouched and never call `fetch`.

Stop adding new messages at `maxMessages`, write exactly one warning to stderr, and continue scanning only so results can attach to already-retained calls. Derive model/provider from the first retained ordinary message carrying non-empty strings. Leave the header as the sole source for ID/title.

- [ ] **Step 5: Run adapter regression verification**

Run: `pnpm --filter @quire/cli test -- omp.test.ts image.test.ts zcode.test.ts shape.test.ts system.test.ts`

Run: `pnpm --filter @quire/cli typecheck`

Expected: PASS; no Vitest Errors section.

- [ ] **Step 6: Update handoff log and commit**

Record exact retained/omitted OMP types, tests, commit, and Task 3 as next.

```bash
git add cli/src/harness/omp.ts cli/src/image.ts cli/src/harness/zcode.ts cli/test/omp.test.ts cli/test/image.test.ts cli/test/zcode.test.ts
git commit -m "feat(cli): shape OMP conversations"
```

---

### Task 3: Wire exact-path OMP publishing into the CLI

**Files:**
- Modify: `cli/src/harness/detect.ts`
- Modify: `cli/src/commands/publish.ts:59-88`
- Modify: `cli/src/index.ts:4-13`
- Modify: `cli/test/detect.test.ts`
- Modify: `cli/test/publish.test.ts`

**Interfaces:**
- Consumes: `makeOmpAdapter()` from Task 1.
- Produces: `HarnessName = 'zcode' | 'claude-code' | 'codex' | 'omp'`, CLI acceptance of `--harness omp`, and preservation of detailed adapter errors for explicit paths.

- [ ] **Step 1: Write failing selection, validation, and process tests**

Add assertions that:

- `makeAdapter('omp').name === 'omp'`;
- no existing environment or store fallback auto-detects OMP;
- unknown-harness errors and usage show `zcode|claude-code|codex|omp`;
- `publish --current --harness omp --yes` emits the actionable unsupported-current error;
- `publish <valid-export.html> --harness omp --preset strict --yes` reaches the mock preview/create endpoints and sends the shaped OMP session; and
- malformed OMP input reports its specific fail-closed diagnostic, not generic `session not found` and not fixture content.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @quire/cli test -- detect.test.ts publish.test.ts omp.test.ts`

Expected: FAIL because `omp` is absent from CLI validation, adapter construction, and usage.

- [ ] **Step 3: Implement CLI wiring without auto-detection**

Update the unions, validation, usage, and `makeAdapter` switch:

```ts
export type HarnessName = 'zcode' | 'claude-code' | 'codex' | 'omp';

export function makeAdapter(name: HarnessName): HarnessAdapter {
  switch (name) {
    case 'zcode': return makeZcodeAdapter();
    case 'claude-code': return makeClaudeCodeAdapter();
    case 'codex': return makeCodexAdapter();
    case 'omp': return makeOmpAdapter();
  }
}
```

Do not add OMP to `defaultStorePaths()` or the recency candidates.

Fix `resolveSession()` so direct-load errors remain actionable. Replace the blanket catch with an OMP-safe propagation rule by adding an optional adapter capability rather than checking names:

```ts
export interface HarnessAdapter {
  name: 'zcode' | 'claude-code' | 'codex' | 'omp';
  preserveDirectLoadError?: boolean;
  // existing methods
}
```

Set `preserveDirectLoadError: true` on the OMP adapter. In `resolveSession`, rethrow the caught `Error` for adapters with that capability; retain the current generic `session not found: <id>` behavior for the other adapters. This prevents raw OMP HTML content from appearing while preserving specific parser diagnostics.

- [ ] **Step 4: Run all CLI tests and typecheck**

Run: `pnpm --filter @quire/cli test`

Run: `pnpm --filter @quire/cli typecheck`

Expected: PASS; existing three-harness detection order is unchanged.

- [ ] **Step 5: Update handoff log and commit**

Record the unchanged auto-detection behavior, process-test evidence, commit, and Task 4 as next.

```bash
git add cli/src/harness/detect.ts cli/src/harness/types.ts cli/src/commands/publish.ts cli/src/index.ts cli/test/detect.test.ts cli/test/publish.test.ts
git commit -m "feat(cli): publish OMP session exports"
```

---

### Task 4: Add the shell-free OMP custom-share handler

**Files:**
- Create: `cli/src/omp-share-handler.ts`
- Create: `cli/test/omp-share-handler.test.ts`

**Interfaces:**
- Produces: `OMP_SHARE_HANDLER_SOURCE: string`, the exact ESM source installed by Task 5.
- Installed source exports `runQuire(htmlPath: string, bun?: BunLike): Promise<{ url: string; message: string }>` for deterministic tests and default-exports `(htmlPath: string) => runQuire(htmlPath)` for OMP.

- [ ] **Step 1: Write failing behavior and injection-safety tests**

Write `OMP_SHARE_HANDLER_SOURCE` to a temporary `share.mjs`, import it with a cache-busting query, and inject a fake Bun-like runtime:

```ts
const calls: unknown[] = [];
const fakeBun = {
  spawn(options: { cmd: string[]; stdout: string; stderr: string }) {
    calls.push(options);
    return {
      stdout: new Response('Published: https://quire.test/chats/token\nMessages: 3 · Stored: 42 bytes · Redactions: 1 generic-secret').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    };
  },
};
```

Call `runQuire('D:/tmp/a path & $(bad).html', fakeBun)` and assert the command is exactly:

```ts
[
  process.platform === 'win32' ? 'quire.cmd' : 'quire',
  'publish', 'D:/tmp/a path & $(bad).html',
  '--harness', 'omp', '--preset', 'strict', '--yes',
]
```

Assert `shell` is absent, the result URL is exact, and the message contains only the final `Messages:` line.

- [ ] **Step 2: Add handler failure tests**

Cover zero and multiple `Published:` lines, nonzero exit with bounded stderr, spawn failure, missing Bun runtime, and timeout. Inject a short timeout into the named function or exported helper for tests; assert timeout calls `kill()` and every error is concise. Include a fake stderr containing a transcript sentinel and assert the handler never returns that captured content to OMP.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm --filter @quire/cli test -- omp-share-handler.test.ts`

Expected: FAIL because `OMP_SHARE_HANDLER_SOURCE` does not exist.

- [ ] **Step 4: Implement the Bun handler source**

Keep the installed source dependency-free. Use `Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })`, `Response(stream).text()`, and `Promise.race` with a five-minute timeout. Parse lines structurally:

```js
const published = stdout.split(/\r?\n/).filter(line => line.startsWith('Published: '));
if (published.length !== 1) throw new Error('Quire did not return exactly one published URL');
const url = published[0].slice('Published: '.length).trim();
if (!/^https?:\/\//.test(url)) throw new Error('Quire returned an invalid published URL');
const summary = stdout.split(/\r?\n/).find(line => line.startsWith('Messages: ')) ?? 'Session published by Quire';
return { url, message: summary };
```

On nonzero exit, report `Quire publish failed (exit N). Check QUIRE_SERVER_URL and QUIRE_API_KEY.` Do not return raw stderr to OMP; stderr exists only to distinguish missing executable/spawn failures during local debugging without transcript leakage.

- [ ] **Step 5: Run handler tests and typecheck**

Run: `pnpm --filter @quire/cli test -- omp-share-handler.test.ts`

Run: `pnpm --filter @quire/cli typecheck`

Expected: PASS in Node tests using the injected Bun-like runtime.

- [ ] **Step 6: Update handoff log and commit**

Record handler contract, cross-platform command vector, tests, commit, and Task 5 as next.

```bash
git add cli/src/omp-share-handler.ts cli/test/omp-share-handler.test.ts
git commit -m "feat(cli): add OMP share handler"
```

---

### Task 5: Install the OMP handler safely with `quire setup omp`

**Files:**
- Modify: `cli/src/commands/setup.ts`
- Modify: `cli/src/index.ts`
- Create: `cli/test/setup.test.ts`

**Interfaces:**
- Consumes: `OMP_SHARE_HANDLER_SOURCE` from Task 4.
- Produces: `ompAgentDir(env?: NodeJS.ProcessEnv, home?: string): string`, `installOmpShareHandler(options?: InstallOmpOptions): Promise<{ path: string; unchanged: boolean }>`, and `runSetup(positionals?: string[]): Promise<void>`.
- `InstallOmpOptions` is `{ env?: NodeJS.ProcessEnv; home?: string; source?: string }` for deterministic filesystem tests.

- [ ] **Step 1: Write failing installer tests**

Use a new temporary home for every case. Assert:

- default destination is `<home>/.omp/agent/share.mjs`;
- `PI_CODING_AGENT_DIR` is used as the agent directory itself;
- a missing directory is created;
- installed bytes exactly equal `OMP_SHARE_HANDLER_SOURCE`;
- re-running with identical bytes returns `unchanged: true`;
- existing `share.ts`, `share.js`, or different `share.mjs` rejects and remains byte-identical;
- no same-directory `.tmp` file remains after success or injected rename failure; and
- output never contains handler contents.

- [ ] **Step 2: Add process-level setup tests**

Run the TypeScript CLI with a temporary `HOME`/`USERPROFILE` and assert `quire setup omp` installs and prints the final path plus `strict redaction, no password, no expiry`. Assert plain `quire setup` retains its existing key-generation instructions, and `quire setup unknown` exits nonzero with usage.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm --filter @quire/cli test -- setup.test.ts`

Expected: FAIL because setup ignores positionals and no installer exists.

- [ ] **Step 4: Implement collision-safe atomic installation**

Resolve the directory as:

```ts
export function ompAgentDir(env = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent');
}
```

Check `share.ts`, then `share.js`, then `share.mjs`. If `share.mjs` exists and its bytes equal the bundled source, return idempotent success; every other existing candidate is a conflict. Create the directory, write a uniquely named file in that same directory with mode `0o600`, then rename it to `share.mjs`. Remove only that verified temporary file in `catch/finally`; never remove a user handler.

Change index dispatch to `await runSetup(rest)` for `setup`. Reject more than one positional or any value except `omp`. Keep the current zero-positional server setup byte-for-byte except for signature changes.

- [ ] **Step 5: Run CLI regression verification**

Run: `pnpm --filter @quire/cli test`

Run: `pnpm --filter @quire/cli typecheck`

Expected: PASS; setup key generation and every existing command remain unchanged.

- [ ] **Step 6: Update handoff log and commit**

Record install destinations, collision/idempotency evidence, commit, and Task 6 as next.

```bash
git add cli/src/commands/setup.ts cli/src/index.ts cli/test/setup.test.ts
git commit -m "feat(cli): install OMP share integration"
```

---

### Task 6: Document, rebuild, and verify the complete integration

**Files:**
- Modify: `README.md`
- Modify: `plugin/README.md`
- Modify: `AGENTS.md`
- Update while executing: `.superpowers/omp-sharing-progress.md` (untracked handoff log)

**Interfaces:**
- Consumes: completed OMP adapter, handler, installer, and CLI wiring.
- Produces: operator documentation, rebuilt CLI artifact, complete verification evidence, and a resumable final handoff.

- [ ] **Step 1: Update documentation with exact support boundaries**

Document:

```text
quire setup omp
```

Explain that restarting/reloading OMP makes interactive persisted-session `/share` publish through Quire with strict redaction, no password, and no expiry. State that advanced options require exporting a session and running `quire publish <export.html> --harness omp` with the desired Quire flags. State that headless/ACP and `--no-session` remain OMP-native.

Document collision refusal and recovery: rename or remove only the Quire-installed `share.mjs`, then restart/reload OMP. Warn that OMP does not fall back when an installed custom handler fails. Add OMP's HTML `SessionData` and supported custom-handler seam to `AGENTS.md` operational guidance.

- [ ] **Step 2: Run focused package verification**

Run: `pnpm --filter @quire/cli test`

Run: `pnpm --filter @quire/plugin test`

Run: `pnpm --filter @quire/cli typecheck`

Expected: all exit 0 with no Vitest Errors section.

- [ ] **Step 3: Rebuild and smoke-test the actual CLI artifact**

Remove only the resolved `D:\quire\cli\dist` directory after verifying it is inside `D:\quire\cli`, then run:

```powershell
pnpm --filter @quire/cli build
node cli/dist/index.js
node cli/dist/index.js setup omp
```

For the installer smoke test set `HOME`, `USERPROFILE`, and `PI_CODING_AGENT_DIR` to a fresh temporary directory. Expected: help exits 2 and lists `omp`; setup exits 0 and writes an importable `share.mjs` whose bytes match the bundled source. Do not touch the user's real OMP directory.

- [ ] **Step 4: Inspect package publication contents**

Run `pnpm --filter @quire/cli pack --pack-destination <temporary-directory>` and list the archive. Expected: the bundled `dist/index.js` contains `OMP_SHARE_HANDLER_SOURCE`, and installation works from the unpacked package without a separate handler asset or `package.json` file-list change.

- [ ] **Step 5: Run the repository green gate**

Run each command separately and record exit status plus any Vitest Errors section:

```text
pnpm db:test:up
pnpm typecheck
pnpm --filter @quire/cli test
pnpm --filter @quire/server test
pnpm --filter @quire/web test
pnpm --filter @quire/plugin test
pnpm --filter @quire/cli build
pnpm --filter @quire/server build
pnpm --filter @quire/web build
pnpm --filter @quire/e2e test
pnpm db:test:down
```

Expected: every command exits 0. Always run `db:test:down` after the gate. If the documented E2E lazy-load test fails once, rerun that test in isolation and record both results; treat any isolated reproduction as a regression.

- [ ] **Step 6: Perform live synthetic OMP-handler verification**

Create a synthetic OMP HTML export in a temporary directory and a disposable local Quire server/test database using the `AGENTS.md` local-inspect workflow. Install the handler into a temporary OMP agent directory, invoke its named `runQuire` with the synthetic path, and verify:

- the returned URL loads;
- only the selected branch appears;
- the raw secret fixture is absent and the server reports its redaction;
- internal/system/subagent sentinels are absent; and
- no files outside the temporary roots changed.

This is synthetic verification; never publish a real user OMP transcript.

- [ ] **Step 7: Update final handoff log and commit documentation**

Record current HEAD, every task/commit, exact focused and green-gate results, package inspection, synthetic verification URL/token status, working-tree status, known limitations, and the next integration action. Commit tracked documentation only:

```bash
git add README.md plugin/README.md AGENTS.md
git commit -m "docs: document OMP sharing"
```

- [ ] **Step 8: Review final diff and repository state**

Run:

```text
git status --short
git diff <design-parent-commit>..HEAD --check
git diff <design-parent-commit>..HEAD --stat
```

Expected: no whitespace errors; only the pre-existing `.audit5/` and intentionally untracked `.superpowers/` scratch files remain untracked. Confirm no real `*.html`, `*.jsonl`, credentials, temporary handler, package archive, or test database is staged.
