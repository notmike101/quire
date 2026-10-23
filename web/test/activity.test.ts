import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AssistantMessage from '../src/components/AssistantMessage.vue';
import ToolCard from '../src/components/ToolCard.vue';
import SystemNotice from '../src/components/SystemNotice.vue';
import type { ShareMessage, SharePart } from '../src/api';

const read: SharePart = { type: 'tool', tool: 'read', status: 'completed', input: { path: 'web/src/App.vue:80-100', i: 'Reading viewer component' }, output: 'private full source' };
const failed: SharePart = { type: 'tool', tool: 'functions.exec_command', status: 'error', input: { cmd: 'pnpm typecheck' }, output: 'Cannot find module @quire/protocol\nFull diagnostic details' };
const message = (parts: SharePart[]): ShareMessage => ({ chunkSeq: 0, seq: 1, role: 'assistant', time: null, parts });

describe('activity panels', () => {
  it('collapses a consecutive run while exposing its targets and failures', async () => {
    const w = mount(AssistantMessage, { props: { message: message([read, failed]) } });
    await flushPromises();
    const group = w.find('.tool-group');
    expect(group.exists()).toBe(true);
    expect(group.text()).toContain('2 calls');
    expect(group.text()).toContain('1 failed');
    expect(group.text()).toContain('App.vue');
    expect(group.text()).toContain('Cannot find module');
    expect(w.findAllComponents(ToolCard)).toHaveLength(0);
    await group.find('button').trigger('click');
    expect(w.findAllComponents(ToolCard)).toHaveLength(2);
    expect(w.text()).not.toContain('private full source');
    expect(w.text()).not.toContain('completed');
    await w.findComponent(ToolCard).find('button').trigger('click');
    expect(w.text()).toContain('private full source');
    w.unmount();
  });

  it('reveals singleton tool output with one disclosure', async () => {
    const w = mount(AssistantMessage, { props: { message: message([read]) } });
    await vi.waitFor(() => expect(w.findAllComponents(ToolCard)).toHaveLength(1));
    expect(w.findAll('[aria-expanded]')).toHaveLength(1);
    expect(w.text()).not.toContain('private full source');
    await w.findComponent(ToolCard).find('button').trigger('click');
    expect(w.text()).toContain('private full source');
    w.unmount();
  });

  it.each<SharePart>([
    { type: 'text', text: 'Visible explanation' },
    { type: 'system', text: 'Harness reminder' },
    { type: 'reasoning', text: 'Reasoning summary' },
    { type: 'image', src: 'data:image/png;base64,AAA' },
  ])('does not group across $type content', async (boundary) => {
    const w = mount(AssistantMessage, { props: { message: message([read, boundary, failed]) } });
    await vi.waitFor(() => expect(w.findAllComponents(ToolCard)).toHaveLength(2));
    expect(w.find('.tool-group').exists()).toBe(false);
    w.unmount();
  });

  it('preserves opened output and individual disclosure choices as calls arrive', async () => {
    const w = mount(AssistantMessage, { props: { message: message([read]) } });
    await flushPromises();
    await w.findComponent(ToolCard).find('button').trigger('click');
    expect(w.text()).toContain('private full source');
    await w.setProps({ message: message([read, failed]) });
    await flushPromises();
    expect(w.findAll('.tool-group')).toHaveLength(1);
    expect(w.findAllComponents(ToolCard)).toHaveLength(2);
    expect(w.find('.tool-group').text()).toContain('1 failed');
    expect(w.text()).toContain('private full source');
    expect(w.findAllComponents(ToolCard)[0]!.find('button').attributes('aria-expanded')).toBe('true');
    expect(w.findAllComponents(ToolCard)[1]!.find('button').attributes('aria-expanded')).toBe('false');

    await w.find('.tool-group > button').trigger('click');
    expect(w.text()).not.toContain('private full source');
    await w.find('.tool-group > button').trigger('click');
    expect(w.text()).toContain('private full source');

    await w.findAllComponents(ToolCard)[0]!.find('button').trigger('click');
    await w.findAllComponents(ToolCard)[1]!.find('button').trigger('click');
    await w.find('.tool-group > button').trigger('click');
    await w.find('.tool-group > button').trigger('click');
    expect(w.text()).not.toContain('private full source');
    expect(w.text()).toContain('Full diagnostic details');
    w.unmount();
  });

  it('shows a failed Codex envelope instead of success-sounding wrapper text', async () => {
    const output = JSON.stringify([
      { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: '{"chunk_id":"abc","wall_time_seconds":0.1,"exit_code":1,"output":"Permission denied"}' },
    ]);
    const w = mount(AssistantMessage, { props: { message: message([{ ...failed, output }]) } });
    await vi.waitFor(() => expect(w.findAllComponents(ToolCard)).toHaveLength(1));
    expect(w.findComponent(ToolCard).find('button').text()).toContain('Permission denied');
    expect(w.findComponent(ToolCard).find('button').text()).not.toContain('Script completed');
    w.unmount();
  });
});

describe('collapsed activity context', () => {
  it.each([
    [{ type: 'tool', tool: 'functions.read_file', input: { file_path: 'web/src/App.vue', offset: 80, limit: 21 } }, ['web/src/App.vue', '80', '100']],
    [{ type: 'tool', tool: 'functions.exec_command', input: { cmd: 'pnpm typecheck', workdir: 'web' } }, ['pnpm typecheck', 'web']],
    [{ type: 'tool', tool: 'grep', input: { pattern: 'ToolCard', path: 'web/src' } }, ['ToolCard', 'web/src']],
    [{ type: 'tool', tool: 'functions.apply_patch', input: '*** Begin Patch\n*** Update File: web/src/App.vue\n@@\n-old\n+new\n*** End Patch' }, ['web/src/App.vue']],
    [{ type: 'tool', tool: 'unknown', input: { i: 'Inspecting the viewer' } }, ['Inspecting the viewer']],
  ] as [SharePart, string[]][])('summarizes %o without expanding', (part, targets) => {
    const w = mount(ToolCard, { props: { part } });
    for (const target of targets) expect(w.find('button').text()).toContain(target);
    expect(w.find('button').attributes('aria-expanded')).toBe('false');
    w.unmount();
  });

  it.each([
    '{"output":"Permission denied","metadata":{"exit_code":1}}',
    'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 1\nFinal output:\nPermission denied',
  ])('shows the command diagnostic rather than its result envelope', (output) => {
    const w = mount(ToolCard, { props: { part: { ...failed, output } } });
    expect(w.find('button').text()).toContain('Permission denied');
    expect(w.find('button').text()).not.toContain('metadata');
    expect(w.find('button').text()).not.toContain('Chunk ID');
    w.unmount();
  });

  it('previews a reminder without exposing its whole body', async () => {
    const text = '<system-reminder>\nKeep working until verification passes.\n' + 'Detailed instructions. '.repeat(30) + '\n</system-reminder>';
    const w = mount(SystemNotice, { props: { text } });
    expect(w.find('button').text()).toContain('Keep working until verification passes.');
    expect(w.find('button').text()).not.toContain('<system-reminder>');
    expect(w.text()).not.toContain(text);
    await w.find('button').trigger('click');
    expect(w.text()).toContain(text);
    w.unmount();
  });
});
