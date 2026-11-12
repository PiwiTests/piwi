import { describe, expect, it } from 'vitest';
import {
  MARK_MERGE_PX,
  MAX_VIDEO_ACTIONS,
  actionLabel,
  actionsFromSteps,
  actionsFromTrace,
  keyLabel,
  markLabel,
  originAndPath,
  placeMarks,
  renderInternalSelector,
  timeActions,
  typedLabel,
  type RawAction,
  type VideoAction,
} from '#shared/video-actions';

const T0 = 1_700_000_000_000;

describe('keyLabel', () => {
  it('shows a named key and a combo as they are', () => {
    for (const key of [
      'Enter',
      'Tab',
      'Escape',
      'ArrowDown',
      'Backspace',
      'F5',
      'Control+A',
      'Shift+Tab',
      'Meta+Shift+K',
    ]) {
      expect(keyLabel(key)).toBe(key);
    }
  });

  it('hides a character behind Shift, Alt or AltGraph, which types text', () => {
    for (const key of ['Shift+P', 'Alt+1', 'AltGraph+q', 'Shift+Alt+z', 'Alt+é']) expect(keyLabel(key)).toBe('a key');
    expect(keyLabel('Control+Shift+P')).toBe('Control+Shift+P');
  });

  it('hides any single printable character', () => {
    for (const key of ['a', 'Z', '7', '@', ' ', '+']) expect(keyLabel(key)).toBe('a key');
  });

  it('hides what is no key or combo of keys', () => {
    for (const key of ['hunter2', 'Control+hunter2', 'Foo+A', '', undefined, 42, null])
      expect(keyLabel(key)).toBe('a key');
  });
});

describe('originAndPath', () => {
  it('drops credentials of a URL it cannot parse', () => {
    expect(originAndPath('http://user:SECRET@host:99999/p?token=x')).toBe('http://host:99999/p');
  });

  it('shows only the scheme of a URL that carries content', () => {
    expect(originAndPath('data:text/html,SECRET')).toBe('data:');
    expect(originAndPath('javascript:alert("SECRET")')).toBe('javascript:');
  });
});

describe('masking as the rest of the app does', () => {
  const contexts = [{ origin: 'library', wallTime: T0, monotonicTime: 5_000 }];
  const traced = (method: string, params: Record<string, unknown>) =>
    actionsFromTrace([{ apiName: `x.${method}`, class: 'Frame', method, startTime: 5_000, params }], contexts)![0]!
      .label;

  it('hides a token-shaped path segment of a navigation, in the trace and in the label', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij';
    const label = traced('goto', { url: `https://app.test/reset/${jwt}?x=1` });
    expect(label).toBe('Navigate to https://app.test/reset/<hidden>');
    expect(originAndPath(`https://app.test/reset/${jwt}`)).not.toContain('eyJ');
    expect(originAndPath('https://app.test/files/report-2024')).toBe('https://app.test/files/report-2024');
  });

  it('shows no count for a fill into a password field', () => {
    expect(traced('fill', { selector: 'internal:label="Password"i', value: 'hunter2hunter2' })).toBe(
      "Fill getByLabel('Password'): typed text",
    );
    expect(traced('fill', { selector: 'input[type=password]', value: 'hunter2hunter2' })).toBe(
      "Fill locator('input[type=password]'): typed text",
    );
  });

  it('shows no count for a fill into a card field', () => {
    expect(traced('fill', { selector: 'internal:label="Card number"i', value: '4242424242424242' })).toBe(
      "Fill getByLabel('Card number'): typed text",
    );
  });

  it('shows no count for a typing that names no field (keyboard.type)', () => {
    expect(traced('keyboardType', { text: 'hunter2' })).toBe('Type: typed text');
    expect(actionLabel({ kind: 'type', typedChars: 7 })).toBe('Type: typed text');
  });

  it('keeps the count for a field that holds no secret', () => {
    expect(traced('fill', { selector: 'internal:label="Email"i', value: 'ada@example.com' })).toBe(
      "Fill getByLabel('Email'): typed 15 chars",
    );
  });

  it('hides a credential a locator quotes', () => {
    const label = actionLabel({
      kind: 'click',
      locator: "getByText('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')",
    });
    expect(label).not.toContain('eyJhbGci');
  });

  it('drops the credentials of a protocol-relative URL', () => {
    expect(originAndPath('//user:pw@host.test/p?x=1')).toBe('//host.test/p');
    expect(traced('goto', { url: '//user:pw@host.test/p' })).toBe('Navigate to //host.test/p');
  });

  it('keeps about:blank whole', () => {
    expect(originAndPath('about:blank')).toBe('about:blank');
    expect(traced('goto', { url: 'about:blank' })).toBe('Navigate to about:blank');
    expect(originAndPath('data:text/html,SECRET')).toBe('data:');
  });
});

describe('renderInternalSelector chains', () => {
  it('splits a chain only outside quoted text', () => {
    expect(renderInternalSelector('internal:text="a >> b"i')).toBe("getByText('a >> b')");
    expect(renderInternalSelector('internal:role=list >> internal:text="a >> b"i')).toBe(
      "getByRole('list').getByText('a >> b')",
    );
  });
});

describe('typedLabel', () => {
  it('counts characters and never reads the text', () => {
    expect(typedLabel(17)).toBe('typed 17 chars');
    expect(typedLabel(1)).toBe('typed 1 char');
    expect(typedLabel(0)).toBe('typed 0 chars');
    expect(typedLabel(null)).toBe('typed text');
  });
});

describe('originAndPath', () => {
  it('drops the query string, the fragment and the credentials', () => {
    expect(originAndPath('https://user:pw@shop.example.com/cart/items?token=abc&x=1#frag')).toBe(
      'https://shop.example.com/cart/items',
    );
    expect(originAndPath('https://shop.example.com/?a=1')).toBe('https://shop.example.com');
    expect(originAndPath('http://localhost:3000/login#access_token=zzz')).toBe('http://localhost:3000/login');
  });

  it('cuts a relative path at its query string and its fragment', () => {
    expect(originAndPath('/login?next=/admin&t=1')).toBe('/login');
    expect(originAndPath('/a/b#c')).toBe('/a/b');
  });

  it('is null for no URL', () => {
    expect(originAndPath('')).toBeNull();
    expect(originAndPath(undefined)).toBeNull();
  });
});

describe('actionLabel', () => {
  const save = "getByRole('button', { name: 'Save' })";

  it('says the verb and the locator', () => {
    expect(actionLabel({ kind: 'click', locator: save })).toBe(`Click ${save}`);
    expect(actionLabel({ kind: 'dblclick', locator: save })).toBe(`Double click ${save}`);
    expect(actionLabel({ kind: 'hover', locator: save })).toBe(`Hover ${save}`);
    expect(actionLabel({ kind: 'check', locator: save })).toBe(`Check ${save}`);
    expect(actionLabel({ kind: 'uncheck', locator: save })).toBe(`Uncheck ${save}`);
    expect(actionLabel({ kind: 'click' })).toBe('Click');
  });

  it('says how much a fill or a typing wrote, not what', () => {
    expect(actionLabel({ kind: 'fill', locator: "getByLabel('Email')", typedChars: 17 })).toBe(
      "Fill getByLabel('Email'): typed 17 chars",
    );
    expect(actionLabel({ kind: 'type', locator: "getByLabel('Email')", typedChars: null })).toBe(
      "Type getByLabel('Email'): typed text",
    );
  });

  it('shows a navigation as its origin and path only', () => {
    expect(actionLabel({ kind: 'goto', url: 'https://shop.example.com/cart?coupon=SECRET#x' })).toBe(
      'Navigate to https://shop.example.com/cart',
    );
    expect(actionLabel({ kind: 'goto' })).toBe('Navigate');
  });

  it('shows a named key, hides a character, and names the field it went to', () => {
    expect(actionLabel({ kind: 'press', key: 'Enter' })).toBe('Press Enter');
    expect(actionLabel({ kind: 'press', key: 'p', locator: "getByLabel('Password')" })).toBe(
      "Press a key on getByLabel('Password')",
    );
  });

  it('shows no option of a selection', () => {
    expect(actionLabel({ kind: 'selectOption', locator: "getByLabel('Country')" })).toBe(
      "Select option getByLabel('Country')",
    );
  });
});

describe('renderInternalSelector', () => {
  it('reads the engines Playwright writes for the getBy methods', () => {
    expect(renderInternalSelector('internal:role=button[name="Save"i]')).toBe("getByRole('button', { name: 'Save' })");
    expect(renderInternalSelector('internal:role=button[name="Save"s]')).toBe(
      "getByRole('button', { name: 'Save', exact: true })",
    );
    expect(renderInternalSelector('internal:role=link')).toBe("getByRole('link')");
    expect(renderInternalSelector('internal:label="Email"i')).toBe("getByLabel('Email')");
    expect(renderInternalSelector('internal:text="Hello"s')).toBe("getByText('Hello', { exact: true })");
    expect(renderInternalSelector('internal:attr=[placeholder="Search"i]')).toBe("getByPlaceholder('Search')");
    expect(renderInternalSelector('internal:testid=[data-testid="save"s]')).toBe("getByTestId('save')");
  });

  it('chains the parts and reads nth', () => {
    expect(renderInternalSelector('internal:role=row >> internal:role=button[name="Edit"i] >> nth=0')).toBe(
      "getByRole('row').getByRole('button', { name: 'Edit' }).first()",
    );
  });

  it('reads a frame locator as the frame it enters', () => {
    expect(renderInternalSelector('iframe >> internal:control=enter-frame >> internal:label="Card"i')).toBe(
      "locator('iframe').contentFrame().getByLabel('Card')",
    );
    expect(renderInternalSelector('internal:role=button >> internal:control=enter-frame')).toBe(
      "getByRole('button').contentFrame()",
    );
  });

  it('reads the filters a locator narrows with', () => {
    expect(renderInternalSelector('li >> internal:has-text="abc"i')).toBe("locator('li').filter({ hasText: 'abc' })");
    expect(renderInternalSelector('li >> internal:has-text=/ab+c/i')).toBe(
      "locator('li').filter({ hasText: /ab+c/i })",
    );
    expect(renderInternalSelector('li >> internal:has-not-text="x"i')).toBe(
      "locator('li').filter({ hasNotText: 'x' })",
    );
    expect(renderInternalSelector(String.raw`li >> internal:has="internal:role=button[name=\"Go\"i]"`)).toBe(
      "locator('li').filter({ has: getByRole('button', { name: 'Go' }) })",
    );
    expect(renderInternalSelector('li >> visible=true')).toBe("locator('li').filter({ visible: true })");
  });

  it('keeps the options of getByRole besides its name', () => {
    expect(renderInternalSelector('internal:role=checkbox[name="Terms"i][checked=true]')).toBe(
      "getByRole('checkbox', { name: 'Terms', checked: true })",
    );
    expect(renderInternalSelector('internal:role=heading[level=2][include-hidden]')).toBe(
      "getByRole('heading', { level: 2, includeHidden: true })",
    );
    expect(renderInternalSelector('internal:role=button[disabled=false]')).toBe(
      "getByRole('button', { disabled: false })",
    );
  });

  it('shows an engine it does not know as a locator, readable', () => {
    expect(renderInternalSelector('internal:something=x')).toBe("locator('internal:something=x')");
  });

  it('keeps any other selector as a locator', () => {
    expect(renderInternalSelector('#save')).toBe("locator('#save')");
    expect(renderInternalSelector('')).toBeNull();
    expect(renderInternalSelector(undefined)).toBeNull();
  });
});

describe('actionsFromTrace', () => {
  const contexts = [{ origin: 'library', wallTime: T0, monotonicTime: 5_000 }];
  const call = (over: Record<string, unknown>) => ({
    apiName: 'locator.click',
    class: 'Frame',
    method: 'click',
    startTime: 5_000,
    ...over,
  });

  it('reads the actions, puts them on the wall clock and masks them', () => {
    const out = actionsFromTrace(
      [
        call({ apiName: 'page.goto', method: 'goto', params: { url: 'https://a.test/x?token=1' }, startTime: 5_100 }),
        call({
          apiName: 'locator.fill',
          method: 'fill',
          params: { selector: 'internal:label="Email"i', value: 'ada@example.com' },
          startTime: 5_400,
        }),
        call({ apiName: 'keyboard.press', method: 'press', params: { key: 'x' }, startTime: 5_500 }),
        call({
          params: { selector: 'internal:role=button[name="Save"i]' },
          startTime: 5_900,
          error: { message: 'timeout' },
        }),
      ],
      contexts,
    )!;
    expect(out.map((a) => [a.kind, a.epochMs, a.failed])).toEqual([
      ['goto', T0 + 100, false],
      ['fill', T0 + 400, false],
      ['press', T0 + 500, false],
      ['click', T0 + 900, true],
    ]);
    expect(out.map((a) => a.label)).toEqual([
      'Navigate to https://a.test/x',
      "Fill getByLabel('Email'): typed 15 chars",
      'Press a key',
      "Click getByRole('button', { name: 'Save' })",
    ]);
    expect(JSON.stringify(out)).not.toContain('ada@example.com');
    expect(JSON.stringify(out)).not.toContain('token');
  });

  it('never carries the options of a selection or the text of a typing', () => {
    const out = actionsFromTrace(
      [
        call({
          apiName: 'locator.selectOption',
          method: 'selectOption',
          params: { selector: 'internal:label="Country"i', options: [{ valueOrLabel: 'Secretland' }] },
        }),
        call({ apiName: 'locator.pressSequentially', method: 'type', params: { selector: '#note', text: '1234' } }),
      ],
      contexts,
    )!;
    expect(out.map((a) => a.label)).toEqual([
      "Select option getByLabel('Country')",
      "Type locator('#note'): typed 4 chars",
    ]);
  });

  it('reads a setChecked by its checked param and leaves the other calls out', () => {
    const out = actionsFromTrace(
      [
        call({ apiName: 'locator.setChecked', method: 'setChecked', params: { selector: '#a', checked: false } }),
        call({ apiName: 'locator.setChecked', method: 'setChecked', params: { selector: '#a', checked: true } }),
        call({ apiName: 'expect.toBeVisible', method: 'expect' }),
        call({ apiName: 'page.waitForTimeout', method: 'waitForTimeout' }),
        call({ apiName: 'Test.step', class: 'Test', method: 'step' }),
      ],
      contexts,
    )!;
    expect(out.map((a) => a.kind)).toEqual(['uncheck', 'check']);
  });

  it('is null when the trace has no clock anchor', () => {
    expect(actionsFromTrace([call({})], [{ origin: 'library' }])).toBeNull();
    expect(actionsFromTrace([call({})], [])).toBeNull();
  });
});

describe('actionsFromSteps', () => {
  const step = (over: Record<string, unknown>) => ({ category: 'action', startTime: T0 + 100, ...over });

  it('reads the actions of a step list, in time order, and leaves the rest out', () => {
    const out = actionsFromSteps([
      step({ title: 'Create page', category: 'other', startTime: T0 }),
      step({
        title: 'Navigate to "https://shop.test/login?next=%2Fhome#a"',
        category: 'navigation',
        startTime: T0 + 300,
      }),
      step({ title: `Fill "ada@example.com" getByLabel('Email')`, category: 'input', startTime: T0 + 500 }),
      step({ title: `Click getByRole('button', { name: 'Sign in' })`, startTime: T0 + 900, failed: true }),
      step({ title: `Expect "toBeVisible" getByText('Welcome')`, category: 'assertion', startTime: T0 + 1_200 }),
      step({ title: 'Before Hooks', category: 'hook', startTime: T0 }),
      step({ title: 'Fill the form', category: 'test.step', startTime: T0 + 450 }),
    ]);
    expect(out.map((a) => [a.kind, a.epochMs, a.failed])).toEqual([
      ['goto', T0 + 300, false],
      ['fill', T0 + 500, false],
      ['click', T0 + 900, true],
    ]);
    expect(out.map((a) => a.label)).toEqual([
      'Navigate to https://shop.test/login',
      "Fill getByLabel('Email'): typed 15 chars",
      "Click getByRole('button', { name: 'Sign in' })",
    ]);
  });

  it('counts the characters from the 1.63 layout, with the chain in the params', () => {
    const [fill] = actionsFromSteps([
      step({ title: 'Fill "hunter2"', params: { locator: "getByLabel('Nickname')" }, category: 'input' }),
    ]);
    expect(fill!.label).toBe("Fill getByLabel('Nickname'): typed 7 chars");
    const [secret] = actionsFromSteps([
      step({ title: 'Fill "hunter2"', params: { locator: "getByLabel('Password')" }, category: 'input' }),
    ]);
    expect(secret!.label).toBe("Fill getByLabel('Password'): typed text");
  });

  it('counts a value from the params first, and says no count for a hidden or cut one', () => {
    const [byParam] = actionsFromSteps([
      step({ title: 'Fill "<hidden>"', params: { locator: "getByLabel('Nickname')", value: '123456' } }),
    ]);
    expect(byParam!.label).toBe("Fill getByLabel('Nickname'): typed 6 chars");
    const [hidden] = actionsFromSteps([step({ title: 'Fill "<hidden>" getByLabel(\'Nickname\')' })]);
    expect(hidden!.label).toBe("Fill getByLabel('Nickname'): typed text");
    const [cut] = actionsFromSteps([
      step({ title: 'Fill "abc"', params: { locator: "getByLabel('Nickname')", value: `${'x'.repeat(199)}…` } }),
    ]);
    expect(cut!.label).toBe("Fill getByLabel('Nickname'): typed text");
  });

  it('reads a bare Fill, Type or Insert title, with the locator and the value in the params', () => {
    const out = actionsFromSteps([
      step({ title: 'Fill', params: { locator: "getByLabel('Nickname')", value: 'hunter2' }, startTime: T0 + 1 }),
      step({ title: 'Type', params: { locator: "getByLabel('Nickname')", text: 'abc' }, startTime: T0 + 2 }),
      step({ title: 'Insert', params: { locator: "getByLabel('Nickname')", text: 'ab' }, startTime: T0 + 3 }),
      step({ title: 'Insert "xy"', params: { locator: "getByLabel('Nickname')" }, startTime: T0 + 4 }),
      step({ title: 'Fill', params: { locator: "getByLabel('Password')", value: 'hunter2' }, startTime: T0 + 5 }),
      step({ title: 'Type', params: { value: 'hunter2' }, startTime: T0 + 6 }),
    ]);
    expect(out.map((a) => [a.kind, a.label])).toEqual([
      ['fill', "Fill getByLabel('Nickname'): typed 7 chars"],
      ['type', "Type getByLabel('Nickname'): typed 3 chars"],
      ['type', "Type getByLabel('Nickname'): typed 2 chars"],
      ['type', "Type getByLabel('Nickname'): typed 2 chars"],
      ['fill', "Fill getByLabel('Password'): typed text"],
      ['type', 'Type: typed text'],
    ]);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('shows a named key, and hides a character, a typed value and an option', () => {
    const out = actionsFromSteps([
      step({ title: 'Press "Enter" getByLabel(\'Search\')', startTime: T0 + 1 }),
      step({ title: 'Press "q"', startTime: T0 + 2 }),
      step({ title: 'Press "Control+A"', params: { key: 'Control+A' }, startTime: T0 + 3 }),
      step({ title: 'Select option "Secretland" getByLabel(\'Country\')', startTime: T0 + 4 }),
      step({ title: "Check getByLabel('Terms')", startTime: T0 + 5 }),
      step({ title: "Uncheck getByLabel('News')", startTime: T0 + 6 }),
      step({ title: "Hover getByText('Menu')", startTime: T0 + 7 }),
      step({ title: "Double click getByText('Row')", startTime: T0 + 8 }),
    ]);
    expect(out.map((a) => a.label)).toEqual([
      "Press Enter on getByLabel('Search')",
      'Press a key',
      'Press Control+A',
      "Select option getByLabel('Country')",
      "Check getByLabel('Terms')",
      "Uncheck getByLabel('News')",
      "Hover getByText('Menu')",
      "Double click getByText('Row')",
    ]);
    expect(JSON.stringify(out)).not.toContain('Secretland');
  });

  it('leaves out a step with no start time, the capture, and a non-list', () => {
    expect(actionsFromSteps([{ title: 'Click', category: 'action' }])).toEqual([]);
    expect(actionsFromSteps([step({ title: 'Attach "piwi-capture"' })])).toEqual([]);
    expect(actionsFromSteps(null)).toEqual([]);
    expect(actionsFromSteps('no')).toEqual([]);
  });
});

describe('timeActions', () => {
  const raw = (offsets: number[]): RawAction[] =>
    offsets.map((o) => ({ kind: 'click', epochMs: T0 + o, label: 'Click', failed: false }));

  it('puts each action at its start in the video, from the end of Create page', () => {
    const timed = timeActions(raw([200, 400]), { startedAtMs: T0, durationMs: 1000, createPageEndMs: T0 + 155 })!;
    expect(timed.timing).toBe('create-page');
    expect(timed.actions.map((a) => a.atMs)).toEqual([100, 300]);
  });

  it('anchors on the start of the test without a Create page step', () => {
    const timed = timeActions(raw([200]), { startedAtMs: T0, durationMs: 1000, createPageEndMs: null })!;
    expect(timed.timing).toBe('start');
    expect(timed.actions[0]!.atMs).toBe(200);
  });

  it('keeps an action before the first frame as a negative time, for the lane to flag', () => {
    const timed = timeActions(raw([-50]), { startedAtMs: T0, durationMs: 1000, createPageEndMs: null })!;
    expect(timed.actions[0]!.atMs).toBe(-50);
  });

  it('caps the actions and says how many there were', () => {
    const many = raw(Array.from({ length: MAX_VIDEO_ACTIONS + 20 }, (_, i) => i));
    const timed = timeActions(many, { startedAtMs: T0, durationMs: 1000, createPageEndMs: null })!;
    expect(timed.actions).toHaveLength(MAX_VIDEO_ACTIONS);
    expect(timed.total).toBe(MAX_VIDEO_ACTIONS + 20);
    expect(timed.capped).toBe(true);
    expect(timeActions(raw([1]), { startedAtMs: T0, durationMs: 1000, createPageEndMs: null })!.capped).toBe(false);
  });

  it('is null when the test has no start time', () => {
    expect(timeActions(raw([1]), { startedAtMs: null, durationMs: 1000, createPageEndMs: null })).toBeNull();
  });
});

describe('placeMarks', () => {
  const act = (atMs: number, over: Partial<VideoAction> = {}): VideoAction => ({
    kind: 'click',
    atMs,
    label: `Click @${atMs}`,
    failed: false,
    ...over,
  });

  it('places each action by its time on the lane', () => {
    const marks = placeMarks([act(0), act(5_000), act(10_000)], 10_000, 1000);
    expect(marks.map((m) => m.position)).toEqual([0, 0.5, 1]);
    expect(marks.map(markLabel)).toEqual(['Click @0', 'Click @5000', 'Click @10000']);
  });

  it('holds an action outside the video to its edge and flags it, never drops it', () => {
    const marks = placeMarks([act(-300), act(4_000), act(12_000)], 10_000, 1000);
    expect(marks.map((m) => [m.atMs, m.clamped])).toEqual([
      [0, true],
      [4_000, false],
      [10_000, true],
    ]);
    expect(marks.flatMap((m) => m.actions)).toHaveLength(3);
  });

  it('merges the actions closer than the gap into one counted mark', () => {
    // 1000 px for 10 s: 10 ms is 1 px.
    const marks = placeMarks([act(1_000), act(1_020), act(1_040), act(1_050), act(3_000)], 10_000, 1000);
    expect(marks).toHaveLength(2);
    expect(marks[0]!.actions).toHaveLength(4);
    expect(markLabel(marks[0]!)).toBe('4 actions');
    expect(marks[0]!.atMs).toBe(1_000);
    expect(marks[1]!.actions).toHaveLength(1);
  });

  it('keeps two actions the gap apart as two marks', () => {
    const gapMs = (MARK_MERGE_PX / 1000) * 10_000;
    expect(placeMarks([act(1_000), act(1_000 + gapMs)], 10_000, 1000)).toHaveLength(2);
    expect(placeMarks([act(1_000), act(1_000 + gapMs - 1)], 10_000, 1000)).toHaveLength(1);
  });

  it('keeps the centers of two marks at least a hit area apart, so no mark covers its neighbour', () => {
    // 300 px for 3 s: 10 ms is 1 px; an action every 55 ms.
    const actions = Array.from({ length: 60 }, (_, i) => act(i * 55));
    const marks = placeMarks(actions, 3_000, 300);
    expect(marks.length).toBeGreaterThan(1);
    for (let i = 1; i < marks.length; i++)
      expect((marks[i]!.position - marks[i - 1]!.position) * 300).toBeGreaterThanOrEqual(MARK_MERGE_PX);
    expect(MARK_MERGE_PX).toBeGreaterThanOrEqual(26);
  });

  it('flags a merged mark as outside the video only when every one of its actions is', () => {
    // Two actions before the first frame merge at the left edge; one just inside it, merged with one outside, is not.
    const [outside] = placeMarks([act(-500), act(-100)], 10_000, 1000);
    expect(outside!.clamped).toBe(true);
    const [partly] = placeMarks([act(-100), act(50)], 10_000, 1000);
    expect(partly!.actions).toHaveLength(2);
    expect(partly!.clamped).toBe(false);
  });

  it('turns a merged mark red when one of its actions failed, and keeps the order', () => {
    const [mark] = placeMarks([act(500), act(510, { failed: true }), act(505)], 10_000, 1000);
    expect(mark!.failed).toBe(true);
    expect(mark!.actions.map((a) => a.atMs)).toEqual([500, 505, 510]);
  });

  it('merges more as the lane narrows', () => {
    const actions = [act(1_000), act(2_000), act(3_000)];
    expect(placeMarks(actions, 10_000, 1000)).toHaveLength(3);
    expect(placeMarks(actions, 10_000, 20)).toHaveLength(1);
  });

  it('is empty for no actions or a lane with no span', () => {
    expect(placeMarks([], 10_000, 1000)).toEqual([]);
    expect(placeMarks([act(1)], 0, 1000)).toEqual([]);
  });
});
