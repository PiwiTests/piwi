import { describe, expect, test } from 'vitest';
import { isElementPath, sanitizePageInteraction } from '../src/page-interaction';

describe('isElementPath', () => {
  test('accepts tag:position steps, with | stepping into a shadow root', () => {
    expect(isElementPath('html:1/body:1/form:1/input:2')).toBe(true);
    expect(isElementPath('html:1/body:1/x-card:1|button:1')).toBe(true);
    expect(isElementPath('html:1/body:1/svg:1/foreignObject:1')).toBe(true);
  });

  test('rejects anything else', () => {
    for (const path of ['', 'html', 'html:0', 'html:1/', 'html:1//body:1', '|button:1', 'div:1 > p:2', 42, null]) {
      expect(isElementPath(path)).toBe(false);
    }
    expect(isElementPath(`html:1${'/div:1'.repeat(400)}`)).toBe(false);
  });
});

describe('sanitizePageInteraction', () => {
  const ref = (path: string, label = 'x') => ({ path, label });

  test('keeps a well-formed record', () => {
    const raw = {
      focus: { element: ref('html:1/body:1/input:1', 'input#email'), visible: true, selection: [2, 5] },
      hover: ref('html:1/body:1/nav:1/li:1', 'li#products'),
      selection: {
        start: { path: 'html:1/body:1/p:1', offset: 3 },
        end: { path: 'html:1/body:1/p:2', offset: 0 },
        length: 12,
      },
      indeterminate: [ref('html:1/body:1/input:3')],
    };
    expect(sanitizePageInteraction(raw)).toEqual(raw);
  });

  test('drops the malformed parts and caps labels and the indeterminate list', () => {
    const out = sanitizePageInteraction({
      focus: { element: ref('div > p'), visible: true },
      hover: ref('html:1/body:1/a:1', 'a'.repeat(500)),
      selection: {
        start: { path: 'html:1/body:1/p:1', offset: -1 },
        end: { path: 'html:1/body:1/p:1', offset: 2 },
        length: 2,
      },
      indeterminate: Array.from({ length: 50 }, (_, i) => ref(`html:1/body:1/input:${i + 1}`)),
      value: 'hunter2',
    });
    expect(out.focus).toBeUndefined();
    expect(out.selection).toBeUndefined();
    expect(out.hover!.label).toHaveLength(120);
    expect(out.indeterminate).toHaveLength(20);
    expect(out).not.toHaveProperty('value');
  });

  test('keeps a focus without a usable field selection', () => {
    expect(
      sanitizePageInteraction({ focus: { element: ref('html:1/body:1/button:1'), visible: 'yes', selection: [5, 2] } }),
    ).toEqual({ focus: { element: ref('html:1/body:1/button:1'), visible: false } });
  });

  test('is empty for anything but an object', () => {
    expect(sanitizePageInteraction(null)).toEqual({});
    expect(sanitizePageInteraction('focus')).toEqual({});
  });
});
