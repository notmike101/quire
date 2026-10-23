import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ReasoningBlock from '../src/components/ReasoningBlock.vue';
import CodeBlock from '../src/components/CodeBlock.vue';

describe('ReasoningBlock details', () => {
  it.each(['', ' \t\n  '])('keeps empty thinking visible without a disclosure for %j', (text) => {
    const w = mount(ReasoningBlock, { props: { text } });
    expect(w.isVisible()).toBe(true);
    expect(w.text()).toContain('thinking…');
    expect(w.find('button').exists()).toBe(false);
    expect(w.find('.whitespace-pre-wrap').exists()).toBe(false);
    w.unmount();
  });

  it('opens and closes the actual nonempty reasoning body', async () => {
    const text = '  Compare both options.\n    Keep the original indentation.\n';
    const w = mount(ReasoningBlock, { props: { text } });
    expect(w.find('.whitespace-pre-wrap').exists()).toBe(false);
    await w.get('button').trigger('click');
    expect(w.get('.whitespace-pre-wrap').element.textContent).toBe(text);
    await w.get('button').trigger('click');
    expect(w.find('.whitespace-pre-wrap').exists()).toBe(false);
    expect(w.text()).toContain('thinking…');
    w.unmount();
  });

  it('makes reasoning expandable when initially empty content arrives', async () => {
    const w = mount(ReasoningBlock, { props: { text: '' } });
    expect(w.find('button').exists()).toBe(false);
    await w.setProps({ text: 'New reasoning content' });
    expect(w.find('.whitespace-pre-wrap').exists()).toBe(false);
    await w.get('button').trigger('click');
    expect(w.get('.whitespace-pre-wrap').element.textContent).toBe('New reasoning content');
    w.unmount();
  });
});

describe('CodeBlock text fidelity', () => {
  it.each([
    { name: 'empty output', code: '' },
    { name: 'unindented output', code: 'plain output' },
    { name: 'legitimate leading spaces', code: '      intentional indentation' },
    { name: 'multiline indentation', code: 'first\n  second\n\tthird\n    fourth' },
    { name: 'angle brackets and boundary newlines', code: '\n<node>\n  <child>& value</child>\n</node>\n\n' },
  ])('preserves $name exactly in the preformatted output', ({ code }) => {
    const w = mount(CodeBlock, { props: { code } });
    expect(w.get('pre').element.textContent).toBe(code);
    w.unmount();
  });
});
