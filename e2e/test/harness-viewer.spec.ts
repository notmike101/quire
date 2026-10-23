import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeClaudeCodeAdapter } from '../../cli/src/harness/claude-code.js';
import { makeCodexAdapter } from '../../cli/src/harness/codex.js';
import { makeOmpAdapter } from '../../cli/src/harness/omp.js';
import { createV2Share } from './helpers.js';

const timestamp = '2026-01-01T12:00:00.000Z';
const singletonOutput = '  <output data-kind="fixture">& not markup</output>\n    indented line  \n\n';
const finalText = 'Final answer stays visible. [Local source](file:///workspace/src/singleton.ts) and [Public docs](https://example.org/docs).';

/**
 * Write a Codex database and rollout, then load them through the real adapter.
 *
 * @param dir - Temporary directory receiving the synthetic Codex files.
 * @returns The normalized session with reasoning, singleton tools, and batched tools.
 */
async function codexSession(dir: string) {
  const dbPath = join(dir, 'state_5.sqlite');
  const rolloutPath = join(dir, 'rollout.jsonl');
  /**
   * Serialize one timestamped Codex response-item event.
   *
   * @param payload - Response item stored in the rollout.
   * @returns A JSON line for the synthetic rollout.
   */
  const event = (payload: Record<string, unknown>) => JSON.stringify({ timestamp, type: 'response_item', payload });
  /**
   * Serialize a Codex text message with role-appropriate content type.
   *
   * @param role - User or assistant role for the message.
   * @param text - Message text to include.
   * @returns A serialized response-item message event.
   */
  const message = (role: string, text: string) => event({
    type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  });
  /**
   * Serialize a Codex function call with JSON-encoded arguments.
   *
   * @param id - Call identifier linking the invocation to its result.
   * @param name - Tool name recorded in the invocation.
   * @param input - Arguments to encode in the call.
   * @returns A serialized function-call event.
   */
  const call = (id: string, name: string, input: object) => event({
    type: 'function_call', call_id: id, name, arguments: JSON.stringify(input),
  });
  /**
   * Serialize a Codex tool result while preserving output whitespace.
   *
   * @param id - Identifier of the invocation being answered.
   * @param output - Tool output text.
   * @param isError - Whether the tool invocation failed.
   * @returns A serialized function-call-output event.
   */
  const result = (id: string, output: string, isError = false) => event({
    type: 'function_call_output', call_id: id, output, is_error: isError,
  });
  writeFileSync(rolloutPath, [
    message('user', 'Inspect the synthetic files.'),
    event({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Consider the synthetic fixture carefully.' }] }),
    event({ type: 'reasoning', summary: [], encrypted_content: 'SYNTHETIC_ENCRYPTED_REASONING' }),
    message('assistant', 'Before singleton.'),
    call('single', 'workspace.read_file', { path: 'src/singleton.ts', i: 'Inspect singleton output' }),
    result('single', singletonOutput),
    message('assistant', 'Between singleton and batch.'),
    call('batch-read', 'workspace.read_file', { path: 'src/batch.ts' }),
    result('batch-read', 'Batch file contents'),
    call('batch-failed', 'exec_command', { cmd: 'npm run check' }),
    result('batch-failed', 'Error: Permission denied', true),
    message('assistant', 'After batch.'),
    message('user', 'Keep the final answer visible.'),
    message('assistant', finalText),
  ].join('\n') + '\n');

  const db = new DatabaseSync(dbPath);
  try {
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
    db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'codex-viewer', rolloutPath, 1_767_268_800, 1_767_268_800_000,
      'Codex adapter viewer', 'openai', 'synthetic-model', dir, null, null,
    );
  } finally {
    db.close();
  }
  return makeCodexAdapter(dbPath, {}).loadSession('codex-viewer');
}

/**
 * Write an OMP HTML export and load it through the real adapter.
 *
 * @param dir - Temporary directory receiving the synthetic export.
 * @returns The normalized session with reasoning, singleton tools, and batched tools.
 */
async function ompSession(dir: string) {
  const exportPath = join(dir, 'session.html');
  const entries: object[] = [];
  let parentId: string | null = null;
  /**
   * Append an OMP message and advance the session's parent-linked entry chain.
   *
   * @param role - Harness message role, including toolResult for tool responses.
   * @param content - Ordered text, thinking, or tool-call content blocks.
   * @param extra - Additional message fields such as model or result metadata.
   */
  const message = (role: string, content: object[], extra: Record<string, unknown> = {}) => {
    const id = `entry-${entries.length}`;
    entries.push({ type: 'message', id, parentId, timestamp, message: { role, content, ...extra } });
    parentId = id;
  };
  /**
   * Wrap text as an OMP content block.
   *
   * @param value - Text to preserve in the block.
   * @returns An OMP text block.
   */
  const text = (value: string) => ({ type: 'text', text: value });
  /**
   * Construct an OMP tool-call content block.
   *
   * @param id - Identifier linking the call to its result.
   * @param name - Harness tool name.
   * @param args - Tool input arguments.
   * @returns An OMP toolCall block.
   */
  const call = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });
  /**
   * Append an OMP tool-result message to the entry chain.
   *
   * @param toolCallId - Identifier of the invocation being answered.
   * @param toolName - Name of the tool that produced the result.
   * @param output - Tool output text to preserve.
   * @param isError - Whether the tool invocation failed.
   */
  const result = (toolCallId: string, toolName: string, output: string, isError = false) => {
    message('toolResult', [text(output)], { toolCallId, toolName, isError });
  };
  message('user', [text('Inspect the synthetic files.')]);
  message('assistant', [
    { type: 'thinking', thinking: 'Consider the synthetic fixture carefully.' },
    { type: 'thinking', thinking: '' },
    text('Before singleton.'),
    call('single', 'read', { path: 'src/singleton.ts', i: 'Inspect singleton output' }),
  ], { provider: 'synthetic-provider', model: 'synthetic-model' });
  result('single', 'read', singletonOutput);
  message('assistant', [
    text('Between singleton and batch.'),
    call('batch-read', 'read', { path: 'src/batch.ts' }),
    call('batch-failed', 'bash', { command: 'npm run check' }),
  ]);
  result('batch-read', 'read', 'Batch file contents');
  result('batch-failed', 'bash', 'Error: Permission denied', true);
  message('assistant', [text('After batch.')]);
  message('user', [text('Keep the final answer visible.')]);
  message('assistant', [text(finalText)]);
  const data = {
    header: { type: 'session', version: 3, id: 'omp-viewer', title: 'OMP adapter viewer', timestamp, cwd: dir },
    entries,
    leafId: parentId,
  };
  writeFileSync(exportPath, `<!doctype html><script id="session-data" type="application/json">${Buffer.from(JSON.stringify(data)).toString('base64')}</script>`);
  return makeOmpAdapter().loadSession(exportPath);
}

/**
 * Write a Claude Code transcript and load it through the real adapter.
 *
 * @param dir - Temporary directory receiving the synthetic JSONL transcript.
 * @returns The normalized session with reasoning, singleton tools, and batched tools.
 */
async function claudeCodeSession(dir: string) {
  const sessionPath = join(dir, 'claude-viewer.jsonl');
  const events: object[] = [{ type: 'summary', summary: 'Claude Code adapter viewer' }];
  /**
   * Append a Claude Code message to the synthetic transcript.
   *
   * @param role - Message role used for both the event and its message body.
   * @param content - Plain message text or ordered harness content blocks.
   */
  const message = (role: string, content: string | object[]) => {
    events.push({ type: role, timestamp, message: { role, content, model: 'synthetic-model' } });
  };
  /**
   * Wrap text as a Claude Code content block.
   *
   * @param value - Text to preserve in the block.
   * @returns A Claude Code text block.
   */
  const text = (value: string) => ({ type: 'text', text: value });
  /**
   * Construct a Claude Code tool-use content block.
   *
   * @param id - Identifier linking the invocation to its result.
   * @param name - Harness tool name.
   * @param input - Tool input arguments.
   * @returns A Claude Code tool_use block.
   */
  const call = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
  /**
   * Construct a Claude Code tool-result content block.
   *
   * @param tool_use_id - Identifier of the invocation being answered.
   * @param content - Tool output text to preserve.
   * @param is_error - Whether the tool invocation failed.
   * @returns A Claude Code tool_result block.
   */
  const result = (tool_use_id: string, content: string, is_error = false) => ({ type: 'tool_result', tool_use_id, content, is_error });
  message('user', 'Inspect the synthetic files.');
  message('assistant', [
    { type: 'thinking', thinking: 'Consider the synthetic fixture carefully.' },
    { type: 'thinking', thinking: '' },
    text('Before singleton.'),
    call('single', 'Read', { file_path: 'src/singleton.ts', i: 'Inspect singleton output' }),
  ]);
  message('user', [result('single', singletonOutput)]);
  message('assistant', [
    text('Between singleton and batch.'),
    call('batch-read', 'Read', { file_path: 'src/batch.ts' }),
    call('batch-failed', 'Bash', { command: 'npm run check' }),
  ]);
  message('user', [
    result('batch-read', 'Batch file contents'),
    result('batch-failed', '  Error: Permission denied\n    diagnostic details  \n\n', true),
  ]);
  message('assistant', [text('After batch.')]);
  message('user', 'Keep the final answer visible.');
  message('assistant', [text(finalText)]);
  writeFileSync(sessionPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return makeClaudeCodeAdapter(dir).loadSession('claude-viewer');
}

for (const [harness, loadSession] of [['Codex', codexSession], ['OMP', ompSession], ['Claude Code', claudeCodeSession]] as const) {
  test(`${harness} adapter output survives sealed ingestion and keeps activity disclosures local`, async ({ page, request }) => {
    const dir = mkdtempSync(join(tmpdir(), 'quire-harness-viewer-'));
    try {
      const session = await loadSession(dir);
      const { url } = await createV2Share(request, { session });
      await page.goto(url);
      await expect(page.getByRole('heading', { name: `${harness} adapter viewer` })).toBeVisible();

      const singleton = page.getByRole('button', { name: /Inspect singleton output.*src\/singleton\.ts/ });
      const group = page.locator('.tool-group');
      await expect(singleton).toBeVisible();
      await expect(singleton).toHaveAttribute('aria-expanded', 'false');
      await expect(singleton).not.toContainText('Failed');
      await expect(group.getByRole('button', { name: /Inspect singleton output/ })).toHaveCount(0);
      await expect(group).toHaveCount(1);
      const groupButton = group.getByRole('button');
      await expect(groupButton).toHaveAttribute('aria-expanded', 'false');
      await expect(groupButton).toContainText('2 calls');
      await expect(groupButton).toContainText('src/batch.ts');
      await expect(groupButton).toContainText('npm run check');
      await expect(groupButton).toContainText('1 failed');
      await expect(groupButton).toContainText('Error: Permission denied');
      await expect(page.locator('pre')).toHaveCount(0);

      for (const boundary of ['Before singleton.', 'Between singleton and batch.', 'After batch.', 'Keep the final answer visible.']) {
        await expect(page.getByText(boundary, { exact: true })).toBeVisible();
      }
      await expect(page.getByText('Final answer stays visible.', { exact: false })).toBeVisible();
      const transcript = await page.locator('main').innerText();
      expect(transcript).toMatch(/Before singleton\.[\s\S]*Inspect singleton output[\s\S]*Between singleton and batch\.[\s\S]*2 calls[\s\S]*After batch\.[\s\S]*Keep the final answer visible\.[\s\S]*Final answer stays visible\./);
      await expect(page.getByText('Final answer stays visible.', { exact: false })).toContainText('Local source');
      await expect(page.getByRole('link', { name: 'Local source', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Public docs', exact: true })).toHaveAttribute('href', 'https://example.org/docs');

      await expect(page.getByText(/thinking…/)).toHaveCount(2);
      const thinking = page.getByRole('button', { name: /thinking/ });
      await expect(thinking).toHaveCount(1);
      await expect(page.getByText('Consider the synthetic fixture carefully.', { exact: true })).toHaveCount(0);
      await expect(page.getByText('SYNTHETIC_ENCRYPTED_REASONING', { exact: false })).toHaveCount(0);
      await thinking.click();
      await expect(page.getByText('Consider the synthetic fixture carefully.', { exact: true })).toBeVisible();

      await singleton.click();
      const output = page.locator('pre').filter({ hasText: '<output data-kind="fixture">' });
      await expect(output).toBeVisible();
      await expect.poll(() => output.textContent()).toBe('  <output data-kind="fixture">& not markup</output>\n    indented line  \n\n');
      await expect(page.locator('output[data-kind="fixture"]')).toHaveCount(0);
      await expect(groupButton).toHaveAttribute('aria-expanded', 'false');
      await singleton.click();

      await groupButton.click();
      const batchRead = group.getByRole('button', { name: /^Read file (?:workspace\.read_file|read|Read) · src\/batch\.ts$/ });
      const batchFailure = group.getByRole('button', { name: /Run command.*npm run check.*Failed/ });
      await expect(batchRead).toHaveAttribute('aria-expanded', 'false');
      await expect(batchFailure).toHaveAttribute('aria-expanded', 'false');
      await expect(batchRead).not.toContainText('Failed');
      await expect(batchFailure.getByText('Failed', { exact: true })).toBeVisible();
      await expect(batchFailure.getByText('Error: Permission denied', { exact: true })).toBeVisible();
      await expect(group.locator('pre')).toHaveCount(0);
      await expect(page.getByText('Final answer stays visible.', { exact: false })).toBeVisible();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
