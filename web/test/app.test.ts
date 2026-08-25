import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../src/App.vue';

describe('App shell', () => {
  it('mounts', () => {
    const wrapper = mount(App);
    expect(wrapper.text()).toContain('Quire');
  });
});
