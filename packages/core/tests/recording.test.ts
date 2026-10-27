import { describe, test, expect } from 'vitest';
import {
  ASSERTION_MATCHERS,
  buildSession,
  normalizeSteps,
  parseCaptureEvent,
  viewportsForSteps,
  type RawCaptureEvent,
  type RecordedTarget,
} from '../src/recording';

function target(overrides: Partial<RecordedTarget> = {}): RecordedTarget {
  return {
    tagName: 'input',
    role: 'textbox',
    accessibleName: 'Username',
    testId: null,
    text: null,
    alternatives: [{ locator: `getByRole('textbox', { name: 'Username' })`, method: 'getByRole', score: 90 }],
    ...overrides,
  };
}

function ev(overrides: Partial<RawCaptureEvent>): RawCaptureEvent {
  return {
    kind: 'click',
    target: null,
    value: null,
    checked: null,
    inputType: null,
    isPasswordField: false,
    pageUrl: 'https://x.test/',
    timestamp: 0,
    ...overrides,
  };
}

describe('normalizeSteps', () => {
  test('a double click replaces the two clicks the browser sent before it', () => {
    const row = target({ tagName: 'tr', role: 'row', accessibleName: 'Invoice 42' });
    const steps = normalizeSteps([
      ev({ kind: 'click', target: row, timestamp: 1 }),
      ev({ kind: 'click', target: row, timestamp: 2 }),
      ev({ kind: 'dblclick', target: row, timestamp: 3 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['dblclick']);
  });

  test('a file choice becomes setInputFiles with the names, and a drop becomes dragTo', () => {
    const file = target({ tagName: 'input', role: 'button', accessibleName: 'Invoice' });
    const card = target({ tagName: 'div', role: 'listitem', accessibleName: 'Card', text: '  Card   one ' });
    const column = target({ tagName: 'section', role: 'region', accessibleName: 'Done', text: 'Done  ' });
    const steps = normalizeSteps([
      ev({ kind: 'files', target: file, value: 'a.pdf\nb.pdf', timestamp: 1 }),
      ev({ kind: 'drop', target: card, dropTarget: column, timestamp: 2 }),
      ev({ kind: 'drop', target: card, dropTarget: null, timestamp: 3 }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: 'setInputFiles', value: 'a.pdf\nb.pdf' });
    expect(steps[1]).toMatchObject({ action: 'dragTo', target: { text: 'Card one' }, dropTarget: { text: 'Done' } });
  });

  test('coalesces an input burst on the same field into one fill with the last value', () => {
    const usernameField = target();
    const steps = normalizeSteps([
      ev({ kind: 'input', target: usernameField, value: 'a', timestamp: 1 }),
      ev({ kind: 'input', target: usernameField, value: 'al', timestamp: 2 }),
      ev({ kind: 'input', target: usernameField, value: 'alice', timestamp: 3 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: 'fill', value: 'alice' });
  });

  test('two unlabelled fields stay two fills — neither value is lost to the other', () => {
    // Same tag, same role, no name, no test id, and no locator alternative
    // either: a bare role anchor needs the role to be document-unique, which it
    // is not with two of them. The recorder's own per-element key is the only
    // thing telling these apart.
    const bare = { tagName: 'input', role: 'textbox', accessibleName: null, testId: null, text: null };
    const first = target({ ...bare, alternatives: [], elementKey: 'e1' });
    const second = target({ ...bare, alternatives: [], elementKey: 'e2' });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: first, value: 'alice', timestamp: 1 }),
      ev({ kind: 'input', target: second, value: 'smith', timestamp: 2 }),
    ]);
    expect(steps.map((s) => s.value)).toEqual(['alice', 'smith']);
  });

  test('a burst on one field still coalesces when the element key repeats', () => {
    const field = target({ alternatives: [], elementKey: 'e1' });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: field, value: 'a', timestamp: 1 }),
      ev({ kind: 'input', target: field, value: 'alice', timestamp: 2 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ value: 'alice' });
  });

  test('two distinct fields are told apart by their best locator when no element key exists', () => {
    const first = target({
      accessibleName: null,
      alternatives: [{ locator: `locator('#a')`, method: 'locator', score: 40 }],
    });
    const second = target({
      accessibleName: null,
      alternatives: [{ locator: `locator('#b')`, method: 'locator', score: 40 }],
    });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: first, value: 'alice', timestamp: 1 }),
      ev({ kind: 'input', target: second, value: 'smith', timestamp: 2 }),
    ]);
    expect(steps.map((s) => s.value)).toEqual(['alice', 'smith']);
  });

  test('Enter on a button drops the browser’s synthetic click that follows it', () => {
    const button = target({ tagName: 'button', role: 'button', accessibleName: 'Log in', elementKey: 'e9' });
    const steps = normalizeSteps([
      ev({ kind: 'keydown', target: button, value: 'Enter', timestamp: 10 }),
      ev({ kind: 'click', target: button, timestamp: 12 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['press']);
  });

  test('a click on a different element after Enter is still recorded', () => {
    const field = target({ elementKey: 'e1' });
    const button = target({ tagName: 'button', role: 'button', accessibleName: 'Log in', elementKey: 'e2' });
    const steps = normalizeSteps([
      ev({ kind: 'keydown', target: field, value: 'Enter', timestamp: 10 }),
      ev({ kind: 'click', target: button, timestamp: 12 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['press', 'click']);
  });

  test('a deliberate click on the same element well after Enter is still recorded', () => {
    const button = target({ tagName: 'button', role: 'button', accessibleName: 'Log in', elementKey: 'e9' });
    const steps = normalizeSteps([
      ev({ kind: 'keydown', target: button, value: 'Enter', timestamp: 10 }),
      ev({ kind: 'click', target: button, timestamp: 3000 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['press', 'click']);
  });

  test('a click on a different target flushes the pending fill first', () => {
    const usernameField = target();
    const button = target({ tagName: 'button', role: 'button', accessibleName: 'Submit' });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: usernameField, value: 'alice', timestamp: 1 }),
      ev({ kind: 'click', target: button, timestamp: 2 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['fill', 'click']);
  });

  test('password fields are never captured — redacted with a null value', () => {
    const passwordField = target({ role: 'textbox', accessibleName: 'Password' });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: passwordField, value: 'hunter2', isPasswordField: true, timestamp: 1 }),
    ]);
    expect(steps[0]).toMatchObject({ action: 'fill', value: null, redacted: true });
  });

  test('checkbox change becomes check/uncheck, not a raw click', () => {
    const checkbox = target({ tagName: 'input', role: 'checkbox', accessibleName: 'Agree' });
    const steps = normalizeSteps([
      ev({ kind: 'click', target: checkbox, inputType: 'checkbox', timestamp: 1 }),
      ev({ kind: 'change', target: checkbox, inputType: 'checkbox', checked: true, timestamp: 2 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('check');
  });

  test('unchecking emits uncheck', () => {
    const checkbox = target({ role: 'checkbox' });
    const steps = normalizeSteps([
      ev({ kind: 'change', target: checkbox, inputType: 'checkbox', checked: false, timestamp: 1 }),
    ]);
    expect(steps[0]!.action).toBe('uncheck');
  });

  test('select change becomes selectOption', () => {
    const select = target({ tagName: 'select', role: 'combobox', accessibleName: 'Country' });
    const steps = normalizeSteps([
      ev({ kind: 'change', target: select, inputType: 'select', value: 'FR', timestamp: 1 }),
    ]);
    expect(steps[0]).toMatchObject({ action: 'selectOption', value: 'FR' });
  });

  test('Enter commits a pending fill and becomes a press step, not a click', () => {
    const field = target();
    const steps = normalizeSteps([
      ev({ kind: 'input', target: field, value: 'alice', timestamp: 1 }),
      ev({ kind: 'keydown', target: field, value: 'Enter', timestamp: 2 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['fill', 'press']);
    expect(steps[1]).toMatchObject({ value: 'Enter' });
  });

  test('keys that only move between fields are ignored', () => {
    const field = target();
    const steps = normalizeSteps([
      ev({ kind: 'keydown', target: field, value: 'Tab', timestamp: 1 }),
      ev({ kind: 'keydown', target: field, value: 'PageDown', timestamp: 2 }),
    ]);
    expect(steps).toHaveLength(0);
  });

  test('a page’s shortcuts become presses: a combination, or a single character', () => {
    const steps = normalizeSteps([
      ev({ kind: 'keydown', target: null, value: 'ControlOrMeta+k', timestamp: 1 }),
      ev({ kind: 'keydown', target: null, value: '?', timestamp: 2 }),
      ev({ kind: 'keydown', target: null, value: 'Shift+Tab', timestamp: 3 }),
    ]);
    expect(steps.map((s) => s.value)).toEqual(['ControlOrMeta+k', '?', 'Shift+Tab']);
  });

  test('Escape and the arrow keys become presses, after the fill they end', () => {
    const field = target({ tagName: 'input', role: 'combobox' });
    const steps = normalizeSteps([
      ev({ kind: 'input', target: field, value: 'fr', timestamp: 1 }),
      ev({ kind: 'keydown', target: field, value: 'ArrowDown', timestamp: 2 }),
      ev({ kind: 'keydown', target: field, value: 'Escape', timestamp: 3 }),
    ]);
    expect(steps.map((s) => [s.action, s.value])).toEqual([
      ['fill', 'fr'],
      ['press', 'ArrowDown'],
      ['press', 'Escape'],
    ]);
  });

  test('only the first navigation becomes a goto — later ones are implied by what caused them', () => {
    const steps = normalizeSteps([
      ev({ kind: 'navigate', value: 'https://x.test/', timestamp: 1 }),
      ev({ kind: 'click', target: target({ tagName: 'a', role: 'link' }), timestamp: 2 }),
      ev({ kind: 'navigate', value: 'https://x.test/next', timestamp: 3 }),
      ev({ kind: 'click', target: target({ tagName: 'button', role: 'button' }), timestamp: 4 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['goto', 'click', 'click']);
    expect(steps[0]).toMatchObject({ value: 'https://x.test/' });
  });

  test('a page the person reached through the history or by reloading is a goto of its own', () => {
    const link = target({ tagName: 'a', role: 'link' });
    const steps = normalizeSteps([
      ev({ kind: 'navigate', value: 'https://x.test/codes', timestamp: 1 }),
      ev({ kind: 'click', target: link, timestamp: 2 }),
      ev({ kind: 'navigate', value: 'https://x.test/codes/404', timestamp: 3 }),
      ev({ kind: 'navigate', value: 'https://x.test/codes', navigation: 'history', timestamp: 4 }),
      ev({ kind: 'navigate', value: 'https://x.test/codes', navigation: 'reload', timestamp: 5 }),
      ev({ kind: 'click', target: link, timestamp: 6 }),
    ]);
    expect(steps.map((s) => [s.action, s.value, s.pageUrl])).toEqual([
      ['goto', 'https://x.test/codes', 'https://x.test/codes'],
      ['click', null, 'https://x.test/'],
      ['goto', 'https://x.test/codes', 'https://x.test/codes'],
      ['goto', 'https://x.test/codes', 'https://x.test/codes'],
      ['click', null, 'https://x.test/'],
    ]);
  });

  test('long text is normalized and truncated on the target', () => {
    const long = 'x'.repeat(200);
    const steps = normalizeSteps([ev({ kind: 'click', target: target({ text: `  ${long}  ` }), timestamp: 1 })]);
    expect(steps[0]!.target!.text).toHaveLength(120);
  });

  test('an assert event becomes an assert step where it was added, after the fill in progress', () => {
    const coupon = target({ accessibleName: 'Coupon' });
    const total = target({
      tagName: 'p',
      role: null,
      accessibleName: null,
      testId: 'cart-total',
      alternatives: [{ locator: `getByTestId('cart-total')`, method: 'getByTestId', score: 100 }],
    });
    const assertion = {
      matcher: 'toHaveText' as const,
      expected: 'Total: 42',
      actual: 'Total: 40',
      negated: false,
      note: 'coupon ignored',
    };
    const steps = normalizeSteps([
      ev({ kind: 'navigate', value: 'https://x.test/cart', timestamp: 1 }),
      ev({ kind: 'input', target: coupon, value: 'SPRING', timestamp: 2 }),
      ev({ kind: 'input', target: coupon, value: 'SPRING10', timestamp: 3 }),
      ev({ kind: 'assert', target: total, assertion, pageUrl: 'https://x.test/cart', timestamp: 4 }),
      ev({ kind: 'click', target: target({ accessibleName: 'Apply' }), timestamp: 5 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['goto', 'fill', 'assert', 'click']);
    expect(steps[1]).toMatchObject({ value: 'SPRING10' });
    expect(steps[2]).toMatchObject({ target: { testId: 'cart-total' }, value: null, assertion });
  });

  test('a toHaveURL assert has no target, and an assert event without an assertion is dropped', () => {
    const steps = normalizeSteps([
      ev({
        kind: 'assert',
        target: target(),
        assertion: { matcher: 'toHaveURL', expected: '/thanks', actual: '/cart', negated: false, note: null },
        timestamp: 1,
      }),
      ev({ kind: 'assert', target: target(), timestamp: 2 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: 'assert', target: null, assertion: { matcher: 'toHaveURL' } });
  });
});

describe('normalizeSteps — hover', () => {
  const row = target({ tagName: 'tr', role: 'row', accessibleName: 'Invoice 42', alternatives: [] });
  const del = target({ tagName: 'button', role: 'button', accessibleName: 'Delete' });

  test('keeps a hover before the click it reveals', () => {
    const steps = normalizeSteps([
      ev({ kind: 'hover', target: row, timestamp: 1 }),
      ev({ kind: 'click', target: del, timestamp: 1 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['hover', 'click']);
    expect(steps[0]).toMatchObject({ target: { accessibleName: 'Invoice 42' }, value: null });
  });

  test('commits a fill in progress first, and drops a repeated hover on the same element', () => {
    const steps = normalizeSteps([
      ev({ kind: 'input', target: target(), value: 'a', timestamp: 1 }),
      ev({ kind: 'hover', target: row, timestamp: 2 }),
      ev({ kind: 'hover', target: row, timestamp: 3 }),
      ev({ kind: 'click', target: del, timestamp: 3 }),
      ev({ kind: 'hover', target: row, timestamp: 4 }),
      ev({ kind: 'click', target: del, timestamp: 4 }),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['fill', 'hover', 'click', 'hover', 'click']);
  });

  test('drops a hover with no target', () => {
    expect(normalizeSteps([ev({ kind: 'hover', target: null })])).toEqual([]);
  });
});

describe('buildSession', () => {
  test('startUrl comes from the first goto step when present', () => {
    const steps = normalizeSteps([
      ev({ kind: 'navigate', value: 'https://x.test/start', timestamp: 1 }),
      ev({ kind: 'click', target: target(), timestamp: 2 }),
    ]);
    const session = buildSession(steps, 1000);
    expect(session.startUrl).toBe('https://x.test/start');
    expect(session.startedAt).toBe(1000);
  });

  test('falls back to the first step pageUrl when there is no goto', () => {
    const steps = normalizeSteps([
      ev({ kind: 'click', target: target(), pageUrl: 'https://x.test/no-goto', timestamp: 1 }),
    ]);
    const session = buildSession(steps, 0);
    expect(session.startUrl).toBe('https://x.test/no-goto');
  });
});

describe('parseCaptureEvent', () => {
  const button = target({
    tagName: 'button',
    role: 'button',
    accessibleName: 'Pay',
    testId: 'pay',
    text: 'Pay',
    alternatives: [
      { locator: `getByTestId('pay')`, method: 'getByTestId', score: 100 },
      { locator: `getByRole('button', { name: 'Pay' })`, method: 'getByRole', score: 90 },
    ],
    elementKey: 'k1-3',
  });
  const click = ev({ kind: 'click', target: button, pageUrl: 'https://x.test/cart', timestamp: 1700000000000 });

  test('an event the recorder sends comes back as it was', () => {
    expect(parseCaptureEvent(click)).toEqual(click);
    const assert = ev({
      kind: 'assert',
      target: button,
      assertion: { matcher: 'toHaveText', expected: 'Total: 42', actual: 'Total: 40', negated: true, note: 'coupon' },
    });
    expect(parseCaptureEvent(assert)).toEqual(assert);
    const drop = ev({ kind: 'drop', target: button, dropTarget: target() });
    expect(parseCaptureEvent(drop)).toEqual(drop);
    const viewport = ev({ kind: 'viewport', viewport: { width: 1280, height: 720, zoom: 1.25 } });
    expect(parseCaptureEvent(viewport)).toEqual(viewport);
    const input = ev({ kind: 'change', target: target(), value: 'FR', checked: false, inputType: 'select' });
    expect(parseCaptureEvent(input)).toEqual(input);
    const back = ev({
      kind: 'navigate',
      value: 'https://x.test/cart',
      pageUrl: 'https://x.test/cart',
      navigation: 'history',
    });
    expect(parseCaptureEvent(back)).toEqual(back);
  });

  test('a navigation’s cause is one it knows, on a navigate event only', () => {
    expect(parseCaptureEvent(ev({ kind: 'navigate', value: 'https://x.test/', navigation: 'typed' as never }))).toEqual(
      ev({ kind: 'navigate', value: 'https://x.test/' }),
    );
    expect(parseCaptureEvent(ev({ kind: 'click', navigation: 'reload' }))).toEqual(ev({ kind: 'click' }));
  });

  test('a navigation’s cause is kept only to the http(s) address the event was sent from', () => {
    for (const [value, pageUrl] of [
      ['https://elsewhere.test/', 'https://x.test/'],
      ['javascript:alert(1)', 'javascript:alert(1)'],
      ['file:///etc/passwd', 'file:///etc/passwd'],
    ]) {
      expect(parseCaptureEvent(ev({ kind: 'navigate', value, pageUrl, navigation: 'reload' }))).toEqual(
        ev({ kind: 'navigate', value, pageUrl }),
      );
    }
  });

  test('every kind the recorder sends is known, and nothing else', () => {
    const kinds = [
      'click',
      'dblclick',
      'hover',
      'input',
      'change',
      'files',
      'drop',
      'keydown',
      'navigate',
      'assert',
      'viewport',
    ] as const;
    for (const kind of kinds) expect(parseCaptureEvent({ ...click, kind })?.kind, kind).toBe(kind);
    for (const kind of ['scroll', 'Click', '', null, 1, undefined]) {
      expect(parseCaptureEvent({ ...click, kind }), String(kind)).toBeNull();
    }
  });

  test('anything but an object is refused', () => {
    for (const value of [null, undefined, 'click', 42, true, [click]]) {
      expect(parseCaptureEvent(value), JSON.stringify(value)).toBeNull();
    }
  });

  test('a page URL string and a finite timestamp are required', () => {
    const { pageUrl: _pageUrl, ...noUrl } = click;
    const { timestamp: _timestamp, ...noTime } = click;
    expect(parseCaptureEvent(noUrl)).toBeNull();
    expect(parseCaptureEvent(noTime)).toBeNull();
    for (const pageUrl of [null, 42, { href: 'https://x.test/' }]) {
      expect(parseCaptureEvent({ ...click, pageUrl }), String(pageUrl)).toBeNull();
    }
    for (const timestamp of [null, '1700000000000', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(parseCaptureEvent({ ...click, timestamp }), String(timestamp)).toBeNull();
    }
    expect(parseCaptureEvent({ ...click, pageUrl: '', timestamp: -1 })).toMatchObject({ pageUrl: '', timestamp: -1 });
  });

  test('strings are cut to their limits', () => {
    const long = (n: number) => 'x'.repeat(n + 5);
    const parsed = parseCaptureEvent({
      ...click,
      target: {
        ...button,
        tagName: long(64),
        role: long(500),
        accessibleName: long(500),
        testId: long(500),
        text: long(500),
        elementKey: long(128),
      },
      value: long(100_000),
      inputType: long(32),
      pageUrl: `https://x.test/${long(4096)}`,
    })!;
    expect(parsed.target).toMatchObject({
      tagName: 'x'.repeat(64),
      role: 'x'.repeat(500),
      accessibleName: 'x'.repeat(500),
      testId: 'x'.repeat(500),
      text: 'x'.repeat(500),
      elementKey: 'x'.repeat(128),
    });
    expect(parsed.value).toHaveLength(100_000);
    expect(parsed.inputType).toBe('x'.repeat(32));
    expect(parsed.pageUrl).toHaveLength(4096);
    expect(parsed.pageUrl.startsWith('https://x.test/xxx')).toBe(true);
    const assertion = parseCaptureEvent({
      ...click,
      kind: 'assert',
      assertion: { matcher: 'toHaveText', expected: long(2000), actual: long(2000), negated: false, note: long(500) },
    })!.assertion!;
    expect([assertion.expected!.length, assertion.actual!.length, assertion.note!.length]).toEqual([2000, 2000, 500]);
  });

  test('a string at its limit is kept whole', () => {
    const parsed = parseCaptureEvent({ ...click, value: 'v'.repeat(100_000), inputType: 'i'.repeat(32) })!;
    expect(parsed.value).toBe('v'.repeat(100_000));
    expect(parsed.inputType).toBe('i'.repeat(32));
  });

  test('a field of another type becomes null, and isPasswordField false unless it is true', () => {
    const parsed = parseCaptureEvent({ ...click, value: 42, checked: 'true', inputType: 7, isPasswordField: 'true' });
    expect(parsed).toMatchObject({ value: null, checked: null, inputType: null, isPasswordField: false });
    expect(parseCaptureEvent({ ...click, isPasswordField: 1 })!.isPasswordField).toBe(false);
    expect(parseCaptureEvent({ ...click, checked: true })!.checked).toBe(true);
    const { value: _value, checked: _checked, inputType: _inputType, isPasswordField: _password, ...bare } = click;
    expect(parseCaptureEvent(bare)).toMatchObject({
      value: null,
      checked: null,
      inputType: null,
      isPasswordField: false,
    });
  });

  test('a target is rebuilt from its own fields; anything but an object is no target', () => {
    for (const value of [undefined, null, 'button', 42, [button]]) {
      expect(parseCaptureEvent({ ...click, target: value })!.target, JSON.stringify(value)).toBeNull();
    }
    const parsed = parseCaptureEvent({
      ...click,
      target: { tagName: 5, role: ['button'], accessibleName: null, testId: false, text: {}, elementKey: 9 },
    })!;
    expect(parsed.target).toEqual({
      tagName: '',
      role: null,
      accessibleName: null,
      testId: null,
      text: null,
      alternatives: [],
    });
  });

  test('a target keeps at most 10 alternatives, the ones that parse', () => {
    const alt = (i: number) => ({ locator: `getByTestId('t${i}')`, method: 'getByTestId', score: 100 - i });
    const twelve = Array.from({ length: 12 }, (_, i) => alt(i));
    expect(parseCaptureEvent({ ...click, target: { ...button, alternatives: twelve } })!.target!.alternatives).toEqual(
      twelve.slice(0, 10),
    );
    const refused = [
      null,
      'getByTestId("t")',
      { locator: 'x'.repeat(2001), method: 'locator', score: 1 },
      { locator: `getByTestId('t')`, method: 'm'.repeat(65), score: 1 },
      { locator: `getByTestId('t')`, method: 'getByTestId', score: Number.NaN },
      { locator: `getByTestId('t')`, method: 'getByTestId', score: Number.POSITIVE_INFINITY },
      { locator: `getByTestId('t')`, method: 'getByTestId', score: '90' },
      { locator: `getByTestId('t')`, method: 'getByTestId' },
      { locator: 42, method: 'getByTestId', score: 1 },
      { method: 'getByTestId', score: 1 },
    ];
    const atLimit = { locator: 'x'.repeat(2000), method: 'm'.repeat(64), score: -3.5 };
    const parsed = parseCaptureEvent({
      ...click,
      target: { ...button, alternatives: [...refused, { ...alt(0), extra: true }, atLimit, ...twelve] },
    })!;
    expect(parsed.target!.alternatives).toEqual([alt(0), atLimit, ...twelve.slice(0, 8)]);
    expect(parseCaptureEvent({ ...click, target: { ...button, alternatives: 'many' } })!.target!.alternatives).toEqual(
      [],
    );
  });

  test('an assertion needs a known matcher, or the event is refused', () => {
    const assert = (assertion: unknown) => parseCaptureEvent({ ...click, kind: 'assert', assertion });
    expect(assert({ matcher: 'toBeFunny', expected: null, actual: null, negated: false, note: null })).toBeNull();
    expect(assert({ expected: 'x' })).toBeNull();
    expect(assert('toHaveText')).toBeNull();
    expect(assert([{ matcher: 'toHaveText' }])).toBeNull();
    expect(assert({ matcher: 'toHaveURL' })!.assertion).toEqual({
      matcher: 'toHaveURL',
      expected: null,
      actual: null,
      negated: false,
      note: null,
    });
    expect(assert({ matcher: 'toBeVisible', expected: 3, actual: {}, negated: 'yes', note: [] })!.assertion).toEqual({
      matcher: 'toBeVisible',
      expected: null,
      actual: null,
      negated: false,
      note: null,
    });
    for (const matcher of ASSERTION_MATCHERS) expect(assert({ matcher })!.assertion!.matcher).toBe(matcher);
    expect(assert(null)).not.toHaveProperty('assertion');
    expect(parseCaptureEvent(click)).not.toHaveProperty('assertion');
  });

  test('a viewport needs a finite size from 1 to 10,000, and a zoom from 0.25 to 5 when it has one', () => {
    const viewport = (value: unknown) => parseCaptureEvent({ ...click, kind: 'viewport', viewport: value })?.viewport;
    expect(viewport({ width: 1, height: 10_000 })).toEqual({ width: 1, height: 10_000 });
    expect(viewport({ width: 1280.5, height: 720, zoom: 0.25 })).toEqual({ width: 1280.5, height: 720, zoom: 0.25 });
    expect(viewport({ width: 1280, height: 720, zoom: 5 })).toEqual({ width: 1280, height: 720, zoom: 5 });
    expect(viewport({ width: 1280, height: 720, zoom: null })).toEqual({ width: 1280, height: 720 });
    const outOfBounds = [
      { width: 0, height: 720 },
      { width: 1280, height: 10_001 },
      { width: -5, height: 720 },
      { width: Number.NaN, height: 720 },
      { width: Number.POSITIVE_INFINITY, height: 720 },
      { width: '1280', height: 720 },
      { width: 1280 },
      { width: 1280, height: 720, zoom: 0.2 },
      { width: 1280, height: 720, zoom: 5.5 },
      { width: 1280, height: 720, zoom: '2' },
      [1280, 720],
      'large',
      null,
    ];
    for (const value of outOfBounds) {
      expect(viewport(value), JSON.stringify(value)).toBeUndefined();
      expect(parseCaptureEvent({ ...click, kind: 'viewport', viewport: value }), JSON.stringify(value)).not.toBeNull();
    }
  });

  test('a drop target goes through the same target parser', () => {
    expect(parseCaptureEvent({ ...click, kind: 'drop', dropTarget: { ...button, extra: 1 } })!.dropTarget).toEqual(
      button,
    );
    expect(parseCaptureEvent({ ...click, kind: 'drop', dropTarget: 'column' })!.dropTarget).toBeNull();
    expect(parseCaptureEvent({ ...click, kind: 'drop', dropTarget: null })!.dropTarget).toBeNull();
    expect(parseCaptureEvent(click)).not.toHaveProperty('dropTarget');
  });

  test('view and every unknown field are left out', () => {
    const parsed = parseCaptureEvent({
      ...click,
      view: { id: 'v1', box: { x: 0, y: 0, width: 10, height: 10 } },
      script: 'alert(1)',
      target: {
        ...button,
        frame: 'iframe',
        alternatives: [{ locator: `getByTestId('pay')`, method: 'getByTestId', score: 100, pickedByUser: true }],
      },
      assertion: undefined,
    })!;
    expect(parsed).toEqual({
      ...click,
      target: { ...button, alternatives: [{ locator: `getByTestId('pay')`, method: 'getByTestId', score: 100 }] },
    });
    expect(Object.keys(parsed).sort()).toEqual(
      ['checked', 'inputType', 'isPasswordField', 'kind', 'pageUrl', 'target', 'timestamp', 'value'].sort(),
    );
  });

  test('a password field’s value is never kept', () => {
    const parsed = parseCaptureEvent(ev({ kind: 'input', target: target(), value: 'hunter2', isPasswordField: true }));
    expect(parsed).toMatchObject({ value: null, isPasswordField: true });
  });

  test('the events it returns become the same steps as the recorder’s own', () => {
    const coupon = target({ accessibleName: 'Coupon', elementKey: 'k1-1' });
    const events = [
      ev({ kind: 'viewport', viewport: { width: 1280, height: 720 }, timestamp: 1 }),
      ev({ kind: 'navigate', value: 'https://x.test/cart', timestamp: 2 }),
      ev({ kind: 'input', target: coupon, value: 'SPR', timestamp: 3 }),
      ev({ kind: 'input', target: coupon, value: 'SPRING10', timestamp: 4 }),
      ev({ kind: 'keydown', target: coupon, value: 'Enter', timestamp: 5 }),
      ev({ kind: 'click', target: button, timestamp: 6 }),
    ];
    const parsed = events.map((e) => parseCaptureEvent(JSON.parse(JSON.stringify(e)))!);
    expect(normalizeSteps(parsed)).toEqual(normalizeSteps(events));
    expect(viewportsForSteps(normalizeSteps(parsed), parsed)).toEqual([{ step: 0, width: 1280, height: 720 }]);
  });
});
