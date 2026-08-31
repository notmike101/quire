# Codex Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Codex desktop and CLI tasks through Quire's existing CLI/server/viewer pipeline and expose the workflow as a native Codex `$share` skill.

**Architecture:** Read task metadata from Codex's read-only `state_5.sqlite`, then stream the selected task's canonical rollout JSONL into the existing `ShapedSession` contract. Keep the server and viewer unchanged; add only adapter selection, CLI UX, native plugin packaging, tests, and documentation.

**Tech Stack:** TypeScript ESM, Node.js 22+ (`node:sqlite`, `node:readline`, `node:fs`), Vitest, pnpm, Markdown Codex skills/plugins.

**Spec:** `docs/superpowers/specs/2026-08-31-codex-sharing-design.md`

## Global Constraints

- Open Codex databases and rollout files read-only; never modify Codex state.
- Exclude developer instructions, world/turn state, compaction, telemetry, and agent-to-agent traffic.
- Exclude child tasks from ordinary discovery but permit an explicit child-task ID.
- Do not fetch remote images or weaken the server-side ingestion redaction boundary.
- Reuse existing message, tool-input/output, and image limits; add no dependency.
- Keep ZCode and Claude Code behavior unchanged.
- After any `cli/src` change, rebuild `cli/dist` before testing the global binary.

---

### Task 1: Codex task discovery and current-task resolution

**Files:**
- Create: `cli/src/harness/codex.ts`
- Create: `cli/test/codex.test.ts`
- Modify: `cli/src/harness/types.ts:50-54`

**Interfaces:**
- Consumes: `HarnessAdapter`, `HarnessSessionInfo`, and `ShapedSession` from `cli/src/harness/types.ts`.
- Produces: `codexStateDbPath(): string`, `codexStoreUpdatedAt(dbPath: string): number | undefined`, and `makeCodexAdapter(dbPath?: string, env?: NodeJS.ProcessEnv, maxMessages?: number, maxImageBytes?: number): HarnessAdapter`.

- [ ] **Step 1: Write the discovery fixture and failing tests**

Use a temp directory, fixed epoch values, and `DatabaseSync` to create only the schema the adapter reads:

```ts
function makeStateDb(dir: string): { dbPath: string; parentRollout: string; childRollout: string } {
  const dbPath = join(dir, 'state_5.sqlite');
  const parentRollout = join(dir, 'parent.jsonl');
  const childRollout = join(dir, 'child.jsonl');
  writeFileSync(parentRollout, '');
  writeFileSync(childRollout, '');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table threads (
      id text primary key, rollout_path text not null, updated_at integer not null,
      updated_at_ms integer, title text not null, model_provider text not null,
      model text, cwd text not null, agent_role text, agent_path text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null, child_thread_id text primary key, status text not null
    );
  `);
  const insert = db.prepare(`insert into threads
    (id, rollout_path, updated_at, updated_at_ms, title, model_provider, model, cwd, agent_role, agent_path)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('parent-old', parentRollout, 1_700_000_000, 1_700_000_000_000, 'Old parent', 'openai', 'gpt-test', dir, null, null);
  insert.run('parent-new', parentRollout, 1_700_000_100, 1_700_000_100_000, 'New parent', 'openai', 'gpt-test', dir, null, null);
  insert.run('child', childRollout, 1_700_000_200, 1_700_000_200_000, 'Child', 'openai', 'gpt-test', dir, 'worker', '/root/child');
  db.prepare('insert into thread_spawn_edges values (?, ?, ?)').run('parent-new', 'child', 'completed');
  db.close();
  return { dbPath, parentRollout, childRollout };
}
```

Add tests asserting `listSessions()` returns `parent-new`, then `parent-old`, but not `child`; `resolveCurrent()` returns `CODEX_THREAD_ID`; an unknown environment ID rejects with `Codex task not found`; no environment signal falls back to `parent-new`; and `loadSession('child')` is allowed.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @quire/cli test -- codex.test.ts`

Expected: FAIL because `../src/harness/codex.js` does not exist and `'codex'` is not assignable to `HarnessAdapter.name`.

- [ ] **Step 3: Implement the read-only metadata adapter**

Start `cli/src/harness/codex.ts` with these concrete definitions:

```ts
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { HarnessAdapter, HarnessSessionInfo, ShapedSession } from './types.js';
import { MAX_SESSION_MESSAGES } from '../shape.js';
import { MAX_SESSION_IMAGE_BYTES } from '../image.js';

export function codexStateDbPath(): string {
  return join(homedir(), '.codex', 'state_5.sqlite');
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  title: string;
  model_provider: string;
  model: string | null;
  cwd: string;
  updated_at_ms: number | null;
  updated_at: number;
}
```

Open with `new DatabaseSync(dbPath, { readOnly: true })`. Query top-level tasks using:

```sql
select t.id, t.rollout_path, t.title, t.model_provider, t.model,
       t.updated_at_ms, t.updated_at
from threads t
where not exists (
  select 1 from thread_spawn_edges e where e.child_thread_id = t.id
)
order by coalesce(t.updated_at_ms, t.updated_at * 1000) desc
limit 50
```

Map invalid timestamps to epoch zero. Resolve `env.CODEX_THREAD_ID` exactly and fail if its row is absent. When no signal exists, use the first listed task or throw `no Codex tasks found`. Implement `loadSession()` initially by resolving any thread row and returning its metadata with an empty message array; Task 2 replaces that empty array with streamed shaping.

Implement `codexStoreUpdatedAt()` as a read-only `select max(coalesce(updated_at_ms, updated_at * 1000)) as updated_at from threads` query. Return `undefined` for a missing/unreadable database. This avoids relying on the main SQLite file's mtime while Codex writes through WAL.

Update the adapter name union:

```ts
name: 'zcode' | 'claude-code' | 'codex';
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @quire/cli test -- codex.test.ts && pnpm --filter @quire/cli typecheck`

Expected: PASS; discovery excludes the child while explicit loading succeeds.

- [ ] **Step 5: Commit the discovery slice**

```bash
git add cli/src/harness/codex.ts cli/src/harness/types.ts cli/test/codex.test.ts
git commit -m "feat(cli): discover Codex tasks"
```

---

### Task 2: Stream and shape Codex rollout content

**Files:**
- Modify: `cli/src/harness/codex.ts`
- Modify: `cli/test/codex.test.ts`

**Interfaces:**
- Consumes: `truncateInput`, `truncateOutput`, `extractSystemParts`, `extractReasoningParts`, `parseDataUri`, `fileToDataUri`, `mimeFromExtension`, and `ImageBudget`.
- Produces: `loadSession(id): Promise<ShapedSession>` containing user/assistant text, reasoning summaries, tool calls/results, and bounded images.

- [ ] **Step 1: Add a byte-stable rollout fixture and failing shaping test**

Write JSONL with `JSON.stringify(event)` and fixed timestamps. Cover these payloads in rollout order:

```ts
const events = [
  event('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden' }] }),
  event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
  event('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking' }] }),
  event('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'considered options' }], encrypted_content: 'hidden' }),
  event('response_item', { type: 'function_call', call_id: 'f1', name: 'read_file', namespace: 'workspace', arguments: '{"path":"README.md"}' }),
  event('response_item', { type: 'function_call_output', call_id: 'f1', output: 'file contents' }),
  event('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec_command', input: '{"cmd":"pwd"}', status: 'completed' }),
  event('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'D:/quire' }),
  event('response_item', { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'internal' }] }),
  event('response_item', { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'done' }] }),
];
```

Assert the shaped output contains `hello`, `checking`, the reasoning summary, two tools with matched truncated outputs, and `done`; assert it contains neither `hidden` nor `internal`. Add separate tests for a malformed line, the message cap warning, a base64 image data URI, a local file image confined to the task working directory when a safe root is available, and an ignored `https://` image URL.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm --filter @quire/cli test -- codex.test.ts`

Expected: FAIL because `loadSession()` returns no shaped messages.

- [ ] **Step 3: Implement streaming event normalization**

Use `createInterface({ input: createReadStream(row.rollout_path), crlfDelay: Infinity })`. Parse each line in `try/catch`; skip malformed records. Maintain `Map<string, ShapedPart>` for tool calls so output events update the matching part.

Use these exact mappings:

```ts
if (payload.type === 'message' && payload.role === 'user') {
  pushMessage('user', contentParts(payload.content, imageBudget, taskRoot), timestamp);
} else if (payload.type === 'message' && payload.role === 'assistant') {
  pushMessage('assistant', contentParts(payload.content, imageBudget, taskRoot), timestamp);
} else if (payload.type === 'reasoning') {
  const text = summaryText(payload.summary);
  if (text) pushMessage('assistant', [{ type: 'reasoning', text }], timestamp);
} else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
  const part: ShapedPart = {
    type: 'tool', callID: payload.call_id,
    tool: payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name,
    status: payload.status, input: truncateInput(parseJsonOrString(payload.arguments ?? payload.input)),
  };
  pushMessage('assistant', [part], timestamp);
  if (payload.call_id) calls.set(payload.call_id, part);
} else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
  const part = calls.get(payload.call_id);
  if (part) part.output = truncateOutput(stringifyOutput(payload.output));
}
```

Only accept message roles `user` and `assistant`. Run text/tool collections through `extractReasoningParts(extractSystemParts(parts))`. Parse `input_image.image_url` with `parseDataUri`; for `file:` URLs use `fileURLToPath`, `mimeFromExtension`, and `fileToDataUri(..., taskRoot)`; ignore `http:` and `https:`. Emit a `tooLarge` placeholder when an otherwise valid image exceeds the per-image or remaining session budget.

`pushMessage` must ignore empty part arrays, enforce `MAX_SESSION_MESSAGES`, and print one warning. Continue scanning after the cap only so outputs can attach to already-kept tool calls.

- [ ] **Step 4: Run adapter tests and typecheck**

Run: `pnpm --filter @quire/cli test -- codex.test.ts && pnpm --filter @quire/cli typecheck`

Expected: PASS with no Vitest Errors section.

- [ ] **Step 5: Commit rollout shaping**

```bash
git add cli/src/harness/codex.ts cli/test/codex.test.ts
git commit -m "feat(cli): shape Codex rollouts"
```

---

### Task 3: Wire Codex into detection and publishing

**Files:**
- Modify: `cli/src/harness/detect.ts`
- Modify: `cli/src/commands/publish.ts:82-88`
- Modify: `cli/src/index.ts:5-10`
- Modify: `cli/test/detect.test.ts`
- Modify: `cli/test/publish.test.ts`

**Interfaces:**
- Consumes: `codexStateDbPath()` and `makeCodexAdapter()` from Task 1.
- Produces: `HarnessName = 'zcode' | 'claude-code' | 'codex'` and CLI acceptance of `--harness codex`.

- [ ] **Step 1: Write failing detection and CLI validation tests**

Extend path fixtures to `{ zcode, claudeCode, codex }`. Assert `CODEX_THREAD_ID` wins even if Claude/ZCode variables are present; assert newest-store fallback can select each of three stores using `codexStoreUpdatedAt()` for Codex and filesystem mtimes for the other stores; assert the no-store error names all three harnesses. Add a publish validation test asserting `--harness nope` reports `use zcode, claude-code, or codex`, and a CLI help assertion containing `zcode|claude-code|codex`.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @quire/cli test -- detect.test.ts publish.test.ts`

Expected: FAIL because `codex` is rejected and absent from detection/help.

- [ ] **Step 3: Implement three-way detection and adapter construction**

Use a record instead of nested conditionals for store fallback:

```ts
export type HarnessName = 'zcode' | 'claude-code' | 'codex';

if (env.CODEX_THREAD_ID) return 'codex';
if (env.CLAUDECODE) return 'claude-code';
if (env.ZCODE_APP_VERSION) return 'zcode';
const candidates = [
  { name: 'zcode' as const, updatedAt: mtimeIfExists(paths.zcode) },
  { name: 'claude-code' as const, updatedAt: mtimeIfExists(paths.claudeCode) },
  { name: 'codex' as const, updatedAt: codexStoreUpdatedAt(paths.codex) },
];
const newest = candidates
  .filter((x): x is { name: HarnessName; updatedAt: number } => x.updatedAt !== undefined)
  .sort((a, b) => b.updatedAt - a.updatedAt)[0];
if (newest) return newest.name;
```

Implement `makeAdapter` with a `switch` returning the three constructors. Update publish validation and usage text to list `zcode|claude-code|codex`.

- [ ] **Step 4: Run all CLI tests and typecheck**

Run: `pnpm --filter @quire/cli test && pnpm --filter @quire/cli typecheck`

Expected: PASS with all existing ZCode and Claude Code tests unchanged.

- [ ] **Step 5: Commit CLI integration**

```bash
git add cli/src/harness/detect.ts cli/src/commands/publish.ts cli/src/index.ts cli/test/detect.test.ts cli/test/publish.test.ts
git commit -m "feat(cli): publish Codex tasks"
```

---

### Task 4: Add the native Codex `$share` skill

**Files:**
- Create: `plugin/.codex-plugin/plugin.json`
- Create: `plugin/skills/share/SKILL.md`
- Modify: `plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: `quire publish --current --harness codex ... --yes` from Task 3.
- Produces: a Codex plugin exposing the `share` skill while retaining the existing `/share` command.

- [ ] **Step 1: Write failing plugin artifact tests**

Assert the manifest has `name`, `version`, `description`, and `skills: './skills/'`. Assert `skills/share/SKILL.md` has YAML frontmatter with `name: share` and a description, contains `quire publish --current`, `--harness codex`, and `--yes`, does not contain `quire publish --current $ARGUMENTS`, and preserves the existing prohibition on `--preset none` and `--confirm-raw`.

- [ ] **Step 2: Run the plugin test and verify failure**

Run: `pnpm --filter @quire/plugin test`

Expected: FAIL because the Codex manifest and skill do not exist.

- [ ] **Step 3: Add the manifest and skill**

Create the manifest:

```json
{
  "name": "quire",
  "version": "0.1.0",
  "description": "Share AI coding sessions as expiring, password-protected web links via the Quire CLI",
  "skills": "./skills/"
}
```

Create `SKILL.md` with concise frontmatter and the same flag inference rules as `plugin/commands/share.md`. The execution instruction must force:

```text
quire publish --current --harness codex <inferred flags> --yes
```

Tell the agent to report the URL, generated password, expiry, and redaction summary; stop with the existing install guidance when `quire` is absent.

- [ ] **Step 4: Run plugin tests and typecheck**

Run: `pnpm --filter @quire/plugin test`

Expected: PASS.

- [ ] **Step 5: Commit the Codex skill**

```bash
git add plugin/.codex-plugin/plugin.json plugin/skills/share/SKILL.md plugin/test/plugin.test.ts
git commit -m "feat(plugin): add Codex share skill"
```

---

### Task 5: Document, rebuild, and verify the complete feature

**Files:**
- Modify: `README.md`
- Modify: `plugin/README.md`
- Modify: `AGENTS.md`
- Modify while executing: `.superpowers/codex-sharing-progress.md` (untracked handoff log)

**Interfaces:**
- Consumes: completed CLI adapter/integration and native skill from Tasks 1-4.
- Produces: user/agent documentation and verified rebuilt CLI output.

- [ ] **Step 1: Update documentation and operational guidance**

Change harness lists to `ZCode, Claude Code, Codex`; document `quire publish --current --harness codex`; document installing/invoking `$share`; state that top-level Codex tasks are listed normally and child tasks require an explicit ID. In `AGENTS.md`, add Codex to the package overview and record `~/.codex/state_5.sqlite` plus rollout JSONL as the read-only source.

- [ ] **Step 2: Run focused package verification**

Run:

```bash
pnpm --filter @quire/cli test
pnpm --filter @quire/plugin test
pnpm --filter @quire/cli typecheck
```

Expected: all commands exit 0 and Vitest prints no Errors section.

- [ ] **Step 3: Rebuild the CLI and smoke-test the built binary**

Remove only `D:\quire\cli\dist`, rebuild, and invoke the built help path:

```powershell
Remove-Item -LiteralPath 'D:\quire\cli\dist' -Recurse -Force
pnpm --filter @quire/cli build
node cli/dist/index.js
```

Expected: build exits 0; the final command exits 2 and prints usage containing `zcode|claude-code|codex`.

- [ ] **Step 4: Run the repository green gate**

Start the test database, then run the exact gate from `AGENTS.md`:

```bash
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

Expected: every command exits 0. If the known E2E lazy-load timing test fails once, rerun it in isolation and record both results; do not dismiss any reproducible failure.

- [ ] **Step 5: Update the handoff log and commit documentation**

Record the current commit, completed tasks, exact commands/results, working-tree status, and next action in `.superpowers/codex-sharing-progress.md`, then commit tracked documentation:

```bash
git add README.md plugin/README.md AGENTS.md
git commit -m "docs: document Codex sharing"
```

- [ ] **Step 6: Review the final diff**

Run:

```bash
git status --short
git diff HEAD~5..HEAD --check
git diff HEAD~5..HEAD --stat
```

Expected: only the pre-existing `.audit5/` and the intentionally untracked `.superpowers/` scratch files remain untracked; no whitespace errors are reported.
