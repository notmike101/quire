import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PasswordGate from '../src/components/PasswordGate.vue';
import ExpiredPage from '../src/components/ExpiredPage.vue';
import NotFoundPage from '../src/components/NotFoundPage.vue';
import ErrorPage from '../src/components/ErrorPage.vue';

describe('PasswordGate', () => {
  it('emits unlock with the typed password on submit', async () => {
    const w = mount(PasswordGate, { props: { error: '' } });
    await w.find('input[type="password"]').setValue('hunter2');
    await w.find('form').trigger('submit');
    expect(w.emitted('unlock')).toEqual([['hunter2']]);
  });

  it('shows the error message', () => {
    const w = mount(PasswordGate, { props: { error: 'Wrong password.' } });
    expect(w.text()).toContain('Wrong password.');
  });
});

describe('state pages', () => {
  it('expired page explains the expiration', () => {
    expect(mount(ExpiredPage).text()).toContain('expired');
  });

  it('not-found page mentions revocation', () => {
    expect(mount(NotFoundPage).text()).toContain('revoked');
  });

  it('error page shows the message', () => {
    expect(mount(ErrorPage, { props: { message: 'boom' } }).text()).toContain('boom');
  });
});
