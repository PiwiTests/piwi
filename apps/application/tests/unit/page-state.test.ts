import { describe, test, expect } from 'vitest';
import { renderAppStateMarkdown, type PageStateLike } from '#shared/page-state';
import { sanitizePageState } from '~~/server/utils/sanitize';

const failing: PageStateLike = {
  url: 'https://app.example.com/checkout',
  hash: '#payment',
  historyState: '{"step":2}',
  localStorage: [{ key: 'cart', length: 182 }],
  sessionStorage: [],
  cookies: [{ name: 'ab_variant', secure: true }],
};

const baseline: PageStateLike = {
  url: 'https://app.example.com/checkout',
  localStorage: [
    { key: 'cart', length: 175 },
    { key: 'theme', length: 5 },
  ],
  sessionStorage: [],
  cookies: [
    { name: 'sid', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'ab_variant', secure: true },
  ],
};

describe('renderAppStateMarkdown', () => {
  test('returns null without a captured state', () => {
    expect(renderAppStateMarkdown(null)).toBeNull();
  });

  test('renders the failing state without a baseline', () => {
    const md = renderAppStateMarkdown(failing)!;
    expect(md).toContain('- URL: https://app.example.com/checkout (hash #payment)');
    expect(md).toContain('cart (182 ch)');
    expect(md).toContain('- sessionStorage keys: empty');
    expect(md).toContain('ab_variant [Secure]');
    expect(md).not.toContain('Diff vs last pass');
  });

  test('diffs missing cookies and storage keys against the baseline', () => {
    const md = renderAppStateMarkdown(failing, baseline)!;
    expect(md).toContain('### Diff vs last pass');
    expect(md).toContain('- Cookies: missing sid');
    expect(md).toContain('- localStorage: missing theme');
  });

  test('states explicitly when nothing differs', () => {
    const md = renderAppStateMarkdown(baseline, baseline)!;
    expect(md).toContain('No differences');
  });

  test('says what the page was doing: focus with its caret, the mouse, a selection, indeterminate boxes', () => {
    const md = renderAppStateMarkdown({
      ...failing,
      focus: { element: { path: 'html:1/body:1/input:1', label: 'input#email' }, visible: true, selection: [4, 4] },
      hover: { path: 'html:1/body:1/button:1', label: 'button "Pay"' },
      selection: {
        start: { path: 'html:1/body:1/p:1', offset: 0 },
        end: { path: 'html:1/body:1/p:1', offset: 9 },
        length: 9,
      },
      indeterminate: [{ path: 'html:1/body:1/input:2', label: 'input[name="all"]' }],
    })!;
    expect(md).toContain('- Focused element: input#email (focus ring shown), caret at 4');
    expect(md).toContain('- Element under the mouse: button "Pay"');
    expect(md).toContain('- Text selected in the page: 9 characters');
    expect(md).toContain('- Indeterminate checkboxes: input[name="all"]');
  });
});

describe('sanitizePageState', () => {
  test('rejects non-object and url-less payloads', () => {
    expect(sanitizePageState(null)).toBeNull();
    expect(sanitizePageState('x')).toBeNull();
    expect(sanitizePageState({ localStorage: [] })).toBeNull();
  });

  test('whitelists fields and drops anything value-shaped', () => {
    const out = sanitizePageState({
      url: 'https://a.example.com/p?token=secret',
      hash: '#x',
      historyState: '{"a":1}',
      localStorage: [{ key: 'k', length: 3, value: 'LEAKED' }],
      sessionStorage: [],
      cookies: [{ name: 'sid', value: 'LEAKED-COOKIE', domain: 'a', path: '/', httpOnly: true, secure: false }],
      extraneous: 'nope',
    })!;
    expect(out.url).toBe('https://a.example.com/p');
    expect(JSON.stringify(out)).not.toContain('LEAKED');
    expect(JSON.stringify(out)).not.toContain('extraneous');
    expect((out.cookies as unknown[]).length).toBe(1);
  });

  test('keeps focus and hover by well-formed element path only', () => {
    const out = sanitizePageState({
      url: 'https://a.example.com/',
      focus: { element: { path: 'html:1/body:1/input:1', label: 'input#email' }, visible: true, value: 'LEAKED' },
      hover: { path: '<script>', label: 'x' },
    })!;
    expect(out.focus).toEqual({ element: { path: 'html:1/body:1/input:1', label: 'input#email' }, visible: true });
    expect(out).not.toHaveProperty('hover');
    expect(JSON.stringify(out)).not.toContain('LEAKED');
  });

  test('caps storage and cookie counts', () => {
    const out = sanitizePageState({
      url: 'https://a.example.com/',
      localStorage: Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, length: 1 })),
      cookies: Array.from({ length: 100 }, (_, i) => ({ name: `c${i}` })),
    })!;
    expect((out.localStorage as unknown[]).length).toBe(50);
    expect((out.cookies as unknown[]).length).toBe(30);
  });
});
