import { describe, test, expect } from 'vitest';
import { renderSpec } from '../src/codegen';
import {
  buildSession,
  sessionFromEvents,
  viewportsForSteps,
  type RawCaptureEvent,
  type RecordedStep,
  type RecordedTarget,
} from '../src/recording';
import { STEPS_LIMITS, parseSteps, sessionFromSteps, toStepsDocument, type PiwiSteps } from '../src/steps';

const ORIGIN = 'https://staging.acme.test';

function target(overrides: Partial<RecordedTarget> = {}): RecordedTarget {
  return {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Apply',
    testId: null,
    text: 'Apply',
    alternatives: [{ locator: `getByRole('button', { name: 'Apply' })`, method: 'getByRole', score: 90 }],
    ...overrides,
  };
}

function step(overrides: Partial<RecordedStep> = {}): RecordedStep {
  return {
    action: 'click',
    target: target(),
    value: null,
    redacted: false,
    pageUrl: `${ORIGIN}/cart`,
    timestamp: 1,
    ...overrides,
  };
}

function recording(): RecordedStep[] {
  return [
    step({ action: 'goto', target: null, value: `${ORIGIN}/cart?from=mail`, pageUrl: `${ORIGIN}/cart?from=mail` }),
    step({
      action: 'fill',
      value: 'SPRING10',
      target: target({
        role: 'textbox',
        accessibleName: 'Coupon',
        elementKey: 'e7',
        alternatives: [{ locator: `getByRole('textbox', { name: 'Coupon' })`, method: 'getByRole', score: 90 }],
      }),
    }),
    step(),
    step({
      action: 'assert',
      target: target({
        testId: 'cart-total',
        alternatives: [{ locator: `getByTestId('cart-total')`, method: 'getByTestId', score: 100 }],
      }),
      assertion: {
        matcher: 'toHaveText',
        expected: 'Total: 42',
        actual: 'Total: 40',
        negated: false,
        note: 'coupon ignored',
      },
    }),
  ];
}

describe('toStepsDocument / sessionFromSteps', () => {
  test('keeps the origin once and stores paths, without the recorder element keys', () => {
    const doc = toStepsDocument(buildSession(recording(), 100), { title: 'Coupon not applied', note: 'since Monday' });
    expect(doc).toMatchObject({
      v: 1,
      title: 'Coupon not applied',
      origin: ORIGIN,
      recordedAt: 100,
      note: 'since Monday',
    });
    expect(doc.steps[0]).toMatchObject({ value: '/cart?from=mail', pageUrl: '/cart?from=mail' });
    expect(doc.steps.every((s) => s.pageUrl.startsWith('/'))).toBe(true);
    expect(doc.steps[1]!.target).not.toHaveProperty('elementKey');
  });

  test('a document becomes a recording on its origin, or on another one', () => {
    const doc = toStepsDocument(buildSession(recording(), 100));
    const back = sessionFromSteps(doc);
    expect(back.startUrl).toBe(`${ORIGIN}/cart?from=mail`);
    expect(back.steps[2]!.pageUrl).toBe(`${ORIGIN}/cart`);
    const local = sessionFromSteps(doc, 'http://localhost:3000');
    expect(local.startUrl).toBe('http://localhost:3000/cart?from=mail');
    expect(local.steps.every((s) => s.pageUrl.startsWith('http://localhost:3000/'))).toBe(true);
  });

  test('a spec rendered from a document runs against baseURL', () => {
    const doc = toStepsDocument(buildSession(recording(), 100), { title: 'Coupon not applied' });
    const { code } = renderSpec(sessionFromSteps(doc), { title: doc.title!, urls: 'relative' });
    expect(code).toContain(`await page.goto('/cart?from=mail');`);
    expect(code).toContain(`await page.getByRole('textbox', { name: 'Coupon' }).fill('SPRING10');`);
    expect(code).toContain(
      `await expect(page.getByTestId('cart-total')).toHaveText('Total: 42'); // recorded: 'Total: 40'`,
    );
  });
});

describe('parseSteps', () => {
  const valid = (): PiwiSteps => toStepsDocument(buildSession(recording(), 100), { title: 'Coupon' });

  test('reads a document back as it was written, from text or a value', () => {
    const doc = valid();
    expect(parseSteps(JSON.stringify(doc))).toEqual({ ok: true, steps: doc });
    expect(parseSteps(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, steps: doc });
  });

  test('reads a recording saved before the format existed', () => {
    const legacy = JSON.parse(JSON.stringify(buildSession(recording(), 5)));
    const result = parseSteps(legacy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps.origin).toBe(ORIGIN);
      expect(result.steps.steps[0]!.value).toBe('/cart?from=mail');
    }
  });

  test('turns the legacy assertVisible into an assert step', () => {
    const doc = valid();
    doc.steps.push({ ...doc.steps[2]!, action: 'assertVisible' });
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok && result.steps.steps[4]).toMatchObject({
      action: 'assert',
      assertion: { matcher: 'toBeVisible', expected: null },
    });
  });

  test('reads a hover step, which needs a target and keeps no value', () => {
    const doc = valid();
    doc.steps.push({ ...doc.steps[2]!, action: 'hover', value: 'x' });
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok && result.steps.steps[4]).toMatchObject({ action: 'hover', value: null });
    const bare = valid();
    bare.steps.push({ ...bare.steps[2]!, action: 'hover', target: null });
    expect(parseSteps(bare)).toEqual({ ok: false, errors: ['steps[4].target: is required on a hover step'] });
  });

  test('reads a drag, which needs where it drops, and a file choice, which keeps the names', () => {
    const doc = valid();
    const drop = target({ role: 'region', accessibleName: 'Done', elementKey: 'e9' });
    doc.steps.push({ ...doc.steps[2]!, action: 'dragTo', value: 'x', dropTarget: drop });
    doc.steps.push({ ...doc.steps[2]!, action: 'setInputFiles', value: 'invoice.pdf' });
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok && result.steps.steps[4]).toMatchObject({
      action: 'dragTo',
      value: null,
      dropTarget: { role: 'region', accessibleName: 'Done' },
    });
    expect(result.ok && result.steps.steps[5]).toMatchObject({ action: 'setInputFiles', value: 'invoice.pdf' });
    const bare = valid();
    bare.steps.push({ ...bare.steps[2]!, action: 'dragTo' });
    expect(parseSteps(bare)).toEqual({ ok: false, errors: ['steps[4].dropTarget: is required on a dragTo step'] });
  });

  test('reads a manual step, which needs a description and keeps no value', () => {
    const doc = valid();
    doc.steps.push({
      ...doc.steps[0]!,
      action: 'manual',
      target: null,
      value: 'x',
      manual: { description: 'Accept the cookie banner', location: 'tests/cart.spec.ts:12', call: 'Click' },
    });
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok && result.steps.steps[4]).toMatchObject({
      action: 'manual',
      value: null,
      manual: { description: 'Accept the cookie banner', location: 'tests/cart.spec.ts:12', call: 'Click' },
    });
    const bare = valid();
    bare.steps.push({ ...bare.steps[0]!, action: 'manual' });
    expect(parseSteps(bare)).toEqual({ ok: false, errors: ['steps[4].manual: is required on a manual step'] });
    const blank = valid();
    blank.steps.push({
      ...blank.steps[0]!,
      action: 'manual',
      manual: { description: ' ', location: null, call: null },
    });
    expect(parseSteps(blank)).toEqual({ ok: false, errors: ['steps[4].manual.description: must not be empty'] });
  });

  test('keeps a manual step’s instruction that checks, and leaves out one it does not know or that does not check', () => {
    const doc = valid();
    const manual = (instruction: unknown): RecordedStep => ({
      ...doc.steps[0]!,
      action: 'manual',
      target: null,
      manual: { description: 'Choose in `x` "fr"', location: null, call: null, instruction } as RecordedStep['manual'],
    });
    const select = { kind: 'selectOptions', locator: "getByLabel('Country')", options: ['fr', 2] };
    const check = { kind: 'expectURL', expected: '/cart' };
    doc.steps.push(
      manual(select),
      manual(check),
      manual({ kind: 'shakeTheDevice' }),
      manual({ kind: 'selectOptions', locator: "getByLabel('Country')", options: [] }),
      manual({ kind: 'mouseAt', x: '10', y: 20, call: 'Click' }),
    );
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    const manuals = result.ok ? result.steps.steps.slice(4).map((s) => s.manual) : [];
    expect(manuals.map((m) => m?.instruction ?? null)).toEqual([
      select,
      { kind: 'expectURL', expected: '/cart', received: null },
      null,
      null,
      null,
    ]);
    expect(manuals.every((m) => m?.description === 'Choose in `x` "fr"')).toBe(true);
  });

  test('reads the newer matchers, a count being a whole number', () => {
    const doc = valid();
    const check = (matcher: string, expected: string | null) => ({
      ...doc.steps[3]!,
      assertion: { matcher, expected, actual: null, negated: false, note: null },
    });
    doc.steps.push(
      check('toContainText', 'Saved') as never,
      check('toHaveCount', '3') as never,
      check('toBeChecked', 'ignored') as never,
    );
    const result = parseSteps(JSON.stringify(doc));
    expect(result.ok && result.steps.steps.slice(4).map((s) => [s.assertion!.matcher, s.assertion!.expected])).toEqual([
      ['toContainText', 'Saved'],
      ['toHaveCount', '3'],
      ['toBeChecked', null],
    ]);
    const notCount = valid();
    notCount.steps.push(check('toHaveCount', 'three') as never);
    expect(parseSteps(notCount)).toEqual({
      ok: false,
      errors: ['steps[4].assertion.expected: must be a whole number of elements on a toHaveCount assertion'],
    });
  });

  test('never keeps a redacted value', () => {
    const doc = valid();
    doc.steps[1] = { ...doc.steps[1]!, redacted: true, value: 'hunter2' };
    const result = parseSteps(doc);
    expect(result.ok && result.steps.steps[1]!.value).toBeNull();
  });

  test('re-renders every locator in canonical form', () => {
    const doc = valid();
    doc.steps[2]!.target!.alternatives = [{ locator: `getByRole("button", {name: "Apply"})`, method: 'x', score: 90 }];
    const result = parseSteps(doc);
    expect(result.ok && result.steps.steps[2]!.target!.alternatives[0]).toEqual({
      locator: `getByRole('button', { name: 'Apply' })`,
      method: 'getByRole',
      score: 90,
    });
  });

  test('writes version 2 only for a document that uses a manual step or a matcher version 2 added', () => {
    const doc = valid();
    expect(parseSteps(doc)).toMatchObject({ ok: true, steps: { v: 1 } });
    const manual = {
      action: 'manual',
      target: null,
      value: null,
      redacted: false,
      pageUrl: '/cart',
      timestamp: 3,
      manual: { description: 'Accept the cookie banner', location: null, call: null },
    };
    expect(parseSteps({ ...doc, v: 2, steps: [...doc.steps, manual] })).toMatchObject({ ok: true, steps: { v: 2 } });
    const counted = {
      ...manual,
      action: 'assert',
      manual: undefined,
      target: doc.steps[2]!.target,
      assertion: { matcher: 'toHaveCount', expected: '3', actual: null, negated: false, note: null },
    };
    expect(parseSteps({ ...doc, steps: [...doc.steps, counted] })).toMatchObject({ ok: true, steps: { v: 2 } });
    expect(parseSteps({ ...doc, v: 2 })).toMatchObject({ ok: true, steps: { v: 1 } });
  });

  test('refuses what is not a steps document', () => {
    expect(parseSteps('{')).toEqual({ ok: false, errors: ['not valid JSON'] });
    expect(parseSteps([])).toEqual({ ok: false, errors: ['a steps document must be a JSON object'] });
    expect(parseSteps({ v: 3, steps: [] })).toEqual({ ok: false, errors: ['v: this reads versions 1 to 2, not 3'] });
    expect(parseSteps({ v: 1, steps: 'x' })).toEqual({ ok: false, errors: ['steps: must be a list'] });
  });

  test('refuses a locator that is code, not a chain', () => {
    const doc = valid();
    doc.steps[2]!.target!.alternatives = [
      { locator: `getByRole('x')); require('fs').rmSync('/'); ((0`, method: 'x', score: 1 },
    ];
    expect(parseSteps(doc)).toEqual({
      ok: false,
      errors: ['steps[2].target.alternatives[0].locator: is not a Playwright locator chain'],
    });
  });

  test('refuses unknown actions, missing assertions and a value matcher without a value', () => {
    const doc = valid();
    (doc.steps[0] as { action: string }).action = 'eval';
    doc.steps[2] = { ...doc.steps[2]!, action: 'assert' };
    doc.steps[3]!.assertion = { ...doc.steps[3]!.assertion!, expected: null };
    const result = parseSteps(doc);
    expect(result).toEqual({
      ok: false,
      errors: [
        'steps[0].action: is not a known action',
        'steps[2].assertion: is required on an assert step',
        'steps[3].assertion.expected: is required',
      ],
    });
  });

  test('refuses an origin that is not a web origin', () => {
    const doc = { ...valid(), origin: 'javascript:alert(1)' };
    expect(parseSteps(doc)).toEqual({ ok: false, errors: ['origin: must be an http(s) origin'] });
  });

  test('enforces its limits', () => {
    const doc = valid();
    const tooMany = { ...doc, steps: Array.from({ length: STEPS_LIMITS.steps + 1 }, () => doc.steps[2]) };
    expect(parseSteps(tooMany)).toEqual({ ok: false, errors: [`steps: holds more than ${STEPS_LIMITS.steps}`] });
    const longValue = valid();
    longValue.steps[1]!.value = 'x'.repeat(STEPS_LIMITS.valueLength + 1);
    expect(parseSteps(longValue)).toEqual({
      ok: false,
      errors: [`steps[1].value: is longer than ${STEPS_LIMITS.valueLength} characters`],
    });
    const manyAlternatives = valid();
    manyAlternatives.steps[2]!.target!.alternatives = Array.from(
      { length: STEPS_LIMITS.alternatives + 1 },
      () => manyAlternatives.steps[2]!.target!.alternatives[0]!,
    );
    expect(parseSteps(manyAlternatives)).toEqual({
      ok: false,
      errors: [`steps[2].target.alternatives: holds more than ${STEPS_LIMITS.alternatives}`],
    });
  });
});

describe('viewports', () => {
  function sized(timestamp: number, width: number, height: number): RawCaptureEvent {
    return {
      kind: 'viewport',
      target: null,
      value: null,
      checked: null,
      inputType: null,
      isPasswordField: false,
      pageUrl: `${ORIGIN}/cart`,
      timestamp,
      viewport: { width, height },
    };
  }
  const timed = (): RecordedStep[] => recording().map((s, i) => ({ ...s, timestamp: 10 * (i + 1) }));

  test('places each size on the first step recorded at or after it, the last of several and no repeat', () => {
    const steps = timed();
    const events = [
      sized(5, 1280, 800),
      sized(12, 1280, 800),
      sized(21, 600, 800),
      sized(25, 390, 844),
      sized(99, 800, 600),
    ];
    expect(viewportsForSteps(steps, events)).toEqual([
      { step: 0, width: 1280, height: 800 },
      { step: 2, width: 390, height: 844 },
    ]);
  });

  test('keeps the browser zoom with a size when it was not 100%, and a zoom change as a change', () => {
    const steps = timed();
    const zoomed = (timestamp: number, zoom: number) => ({
      ...sized(timestamp, 1024, 640),
      viewport: { width: 1024, height: 640, zoom },
    });
    expect(viewportsForSteps(steps, [zoomed(5, 1.25), zoomed(15, 1), zoomed(25, 1)])).toEqual([
      { step: 0, width: 1024, height: 640, zoom: 1.25 },
      { step: 1, width: 1024, height: 640 },
    ]);
    const doc = toStepsDocument({
      ...buildSession(recording(), 100),
      viewports: [{ step: 0, width: 1024, height: 640, zoom: 1.25 }],
    });
    const parsed = parseSteps(JSON.stringify(doc));
    expect(parsed.ok && parsed.steps.viewports).toEqual([{ step: 0, width: 1024, height: 640, zoom: 1.25 }]);
    expect(parseSteps({ ...doc, viewports: [{ step: 0, width: 10, height: 10, zoom: 9 }] })).toEqual({
      ok: false,
      errors: ['viewports[0].zoom: must be a zoom factor from 0.25 to 5'],
    });
    // The size already holds the zoom: the spec sets it as it is.
    expect(renderSpec(sessionFromSteps(doc)).code).toContain(
      'await page.setViewportSize({ width: 1024, height: 640 });',
    );
  });

  test('a session from events keeps them, and none when the recording took no size', () => {
    const navigate = { ...sized(10, 0, 0), kind: 'navigate' as const, viewport: undefined, value: `${ORIGIN}/cart` };
    const events = [sized(9, 1280, 800), navigate];
    expect(sessionFromEvents(events, 1).viewports).toEqual([{ step: 0, width: 1280, height: 800 }]);
    expect(sessionFromEvents([navigate], 1)).not.toHaveProperty('viewports');
  });

  test('travel through a steps document, and a spec sets them before the steps they start at', () => {
    const viewports = [
      { step: 0, width: 1280, height: 800 },
      { step: 2, width: 390, height: 844 },
    ];
    const doc = toStepsDocument({ ...buildSession(recording(), 100), viewports });
    expect(doc.viewports).toEqual(viewports);
    const parsed = parseSteps(JSON.stringify(doc));
    expect(parsed.ok && parsed.steps.viewports).toEqual(viewports);
    const { code, stepLines } = renderSpec(sessionFromSteps(doc), { urls: 'relative' });
    const lines = code.split('\n');
    expect(lines.filter((l) => l.includes('setViewportSize'))).toEqual([
      '  await page.setViewportSize({ width: 1280, height: 800 });',
      '  await page.setViewportSize({ width: 390, height: 844 });',
    ]);
    expect(lines.findIndex((l) => l.includes('width: 1280'))).toBeLessThan(lines.findIndex((l) => l.includes('goto')));
    expect(lines[stepLines[2]! - 2]).toContain('width: 390');
    expect(lines[stepLines[2]! - 1]).toContain(`getByRole('button', { name: 'Apply' }).click()`);
  });

  test('a document without them reads as before, and one with wrong ones is refused', () => {
    const doc = toStepsDocument(buildSession(recording(), 100));
    expect(doc).not.toHaveProperty('viewports');
    const bad = (viewports: unknown) => parseSteps({ ...doc, viewports });
    expect(bad([{ step: 9, width: 10, height: 10 }])).toEqual({
      ok: false,
      errors: ['viewports[0].step: must be the index of a step'],
    });
    expect(bad([{ step: 0, width: 0, height: 10 }])).toEqual({
      ok: false,
      errors: [`viewports[0].width: must be a whole number of pixels from 1 to ${STEPS_LIMITS.viewportSize}`],
    });
    expect(
      bad([
        { step: 1, width: 10, height: 10 },
        { step: 1, width: 20, height: 10 },
      ]),
    ).toEqual({ ok: false, errors: ['viewports[1].step: must come after the step before it'] });
    expect(bad('wide')).toEqual({ ok: false, errors: ['viewports: must be a list'] });
  });
});
