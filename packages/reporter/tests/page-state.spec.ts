import { describe, it, expect } from 'vitest';
import { buildPageState, type RawPageState } from '../src/internal/capture/capture-fixtures.js';

function raw(overrides: Partial<RawPageState> = {}): RawPageState {
  return {
    url: 'https://app.example.com/checkout?step=2',
    hash: '#payment',
    historyState: '{"step":2}',
    localStorage: [{ key: 'cart', length: 120 }],
    sessionStorage: [],
    ...overrides,
  };
}

describe('buildPageState', () => {
  it('keeps url/hash/history and storage keys with lengths', () => {
    const state = buildPageState(raw(), null);
    expect(state.url).toBe('https://app.example.com/checkout?step=2');
    expect(state.hash).toBe('#payment');
    expect(state.historyState).toBe('{"step":2}');
    expect(state.localStorage).toEqual([{ key: 'cart', length: 120 }]);
    expect(state.cookies).toEqual([]);
  });

  it('never includes cookie values, only names and flags', () => {
    const state = buildPageState(raw(), [
      {
        name: 'session',
        value: 'SUPER-SECRET-SESSION-TOKEN',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: 1750000000,
      },
    ]);
    expect(state.cookies).toEqual([
      {
        name: 'session',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: 1750000000,
      },
    ]);
    expect(JSON.stringify(state)).not.toContain('SUPER-SECRET-SESSION-TOKEN');
  });

  it('masks token-shaped strings in history state', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const state = buildPageState(raw({ historyState: `{"token":"${jwt}"}` }), null);
    expect(state.historyState).toContain('[masked]');
    expect(state.historyState).not.toContain(jwt);
  });

  it('caps history state length', () => {
    const state = buildPageState(raw({ historyState: JSON.stringify({ blob: 'y'.repeat(5000) }) }), null);
    expect(state.historyState!.length).toBeLessThanOrEqual(2049);
    expect(state.historyState!.endsWith('…')).toBe(true);
  });

  it('caps storage entry counts and key lengths', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({ key: `k${i}`.padEnd(300, 'x'), length: i }));
    const state = buildPageState(raw({ localStorage: entries }), null);
    expect(state.localStorage).toHaveLength(50);
    expect(state.localStorage[0]!.key.length).toBeLessThanOrEqual(200);
  });

  it('caps the cookie count', () => {
    const cookies = Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, domain: 'd', path: '/' }));
    const state = buildPageState(raw(), cookies);
    expect(state.cookies).toHaveLength(30);
  });

  it('adds what the page was doing, keeping only well-formed element paths', () => {
    const state = buildPageState(raw(), null, {
      focus: { element: { path: 'html:1/body:1/input:1', label: 'input#email' }, visible: true },
      hover: { path: 'body > li', label: 'li' },
    });
    expect(state.focus).toEqual({ element: { path: 'html:1/body:1/input:1', label: 'input#email' }, visible: true });
    expect(state.hover).toBeUndefined();
    expect(buildPageState(raw(), null, null)).not.toHaveProperty('focus');
  });
});
