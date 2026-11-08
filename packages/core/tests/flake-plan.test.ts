import { describe, expect, test } from 'vitest';
import {
  FlakePlanError,
  describeFlakeArm,
  describeFlakeCondition,
  flakeErrorSignature,
  flakeTestMatches,
  parseFlakePlan,
  parseFlakePlanText,
} from '../src/flake-plan';

const base = {
  version: 1,
  experimentId: 'exp-1',
  test: { file: 'tests/checkout.spec.ts', title: 'pays with a saved card', suite: ['checkout'], project: 'chromium' },
  arm: { id: 'arm-1', conditions: [] as unknown[] },
  errorSignatures: ['Error: expect(locator).toHaveText(expected) failed'],
};

function withConditions(...conditions: unknown[]) {
  return { ...base, arm: { id: 'arm-1', conditions } };
}

describe('parseFlakePlan', () => {
  test('reads a control arm and fills defaults', () => {
    const plan = parseFlakePlan({ ...base, arm: { id: 'control' }, errorSignatures: undefined });
    expect(plan.arm).toEqual({ id: 'control', conditions: [] });
    expect(plan.errorSignatures).toEqual([]);
    expect(plan.test.project).toBe('chromium');
  });

  test('reads every condition kind', () => {
    const plan = parseFlakePlan(
      withConditions(
        { kind: 'delay', route: 'GET /api/cart/:id', ms: 1800, match: 2 },
        { kind: 'delay', route: 'GET /api/cart', ms: 1800 },
        { kind: 'fail', route: 'POST /api/orders', status: 503 },
        { kind: 'fail', route: 'POST /api/orders', abort: true, match: 'all' },
        { kind: 'cpu', rate: 4 },
        { kind: 'network', latencyMs: 400, downKbps: 1600, upKbps: 750 },
        { kind: 'timezone', timeZone: 'America/Argentina/Buenos_Aires' },
        { kind: 'timezone', timeZone: 'Etc/GMT+3' },
        { kind: 'locale', locale: 'zh-Hant-TW' },
        { kind: 'alongside', test: { file: 'tests/admin.spec.ts', title: 'resets catalog' } },
        { kind: 'after', test: { file: 'tests/admin.spec.ts', title: 'resets catalog', suite: ['admin'] } },
        { kind: 'project', name: 'webkit' },
      ),
    );
    expect(plan.arm.conditions).toEqual([
      { kind: 'delay', route: 'GET /api/cart/:id', ms: 1800, match: 2 },
      { kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' },
      { kind: 'fail', route: 'POST /api/orders', status: 503, match: 'all' },
      { kind: 'fail', route: 'POST /api/orders', abort: true, match: 'all' },
      { kind: 'cpu', rate: 4 },
      { kind: 'network', latencyMs: 400, downKbps: 1600, upKbps: 750 },
      { kind: 'timezone', timeZone: 'America/Argentina/Buenos_Aires' },
      { kind: 'timezone', timeZone: 'Etc/GMT+3' },
      { kind: 'locale', locale: 'zh-Hant-TW' },
      { kind: 'alongside', test: { file: 'tests/admin.spec.ts', title: 'resets catalog', suite: [] } },
      { kind: 'after', test: { file: 'tests/admin.spec.ts', title: 'resets catalog', suite: ['admin'] } },
      { kind: 'project', name: 'webkit' },
    ]);
  });

  test('a missing project reads as null', () => {
    const { project: _project, ...test } = base.test;
    expect(parseFlakePlan({ ...base, test }).test.project).toBeNull();
  });

  test('rejects an unknown condition kind by name', () => {
    expect(() => parseFlakePlan(withConditions({ kind: 'memory', mb: 512 }))).toThrow(FlakePlanError);
    expect(() => parseFlakePlan(withConditions({ kind: 'memory', mb: 512 }))).toThrow(
      /conditions\[0\]\.kind "memory" is not a condition this version knows \(delay, fail, cpu/,
    );
  });

  test.each([
    ['a non-object plan', 'nope', /must be a JSON object/],
    ['another version', { ...base, version: 2 }, /version must be 1/],
    ['no experiment id', { ...base, experimentId: '' }, /experimentId must be a non-empty string/],
    ['no test title', { ...base, test: { ...base.test, title: undefined } }, /plan\.test\.title/],
    ['a bad suite', { ...base, test: { ...base.test, suite: [1] } }, /plan\.test\.suite must be a list of strings/],
    ['conditions not a list', { ...base, arm: { id: 'a', conditions: {} } }, /conditions must be a list/],
    ['a route without a method', withConditions({ kind: 'delay', route: '/api/cart', ms: 10 }), /method and a path/],
    ['a negative delay', withConditions({ kind: 'delay', route: 'GET /a', ms: -1 }), /\.ms must be a number/],
    ['an ordinal of 0', withConditions({ kind: 'delay', route: 'GET /a', ms: 1, match: 0 }), /match must be "all"/],
    ['a fractional status', withConditions({ kind: 'fail', route: 'GET /a', status: 500.5 }), /status must be a whole/],
    ['a status out of range', withConditions({ kind: 'fail', route: 'GET /a', status: 42 }), /status must be a number/],
    ['status and abort', withConditions({ kind: 'fail', route: 'GET /a', status: 500, abort: true }), /choose one/],
    ['a CPU rate below 1', withConditions({ kind: 'cpu', rate: 0.5 }), /rate must be a number from 1/],
    ['a network without throughput', withConditions({ kind: 'network', latencyMs: 10 }), /downKbps/],
    ['a time zone with a space', withConditions({ kind: 'timezone', timeZone: 'Europe/Paris x' }), /look like/],
    ['an unknown time zone', withConditions({ kind: 'timezone', timeZone: 'Mars/Base' }), /not a time zone/],
    ['a time zone too long', withConditions({ kind: 'timezone', timeZone: `A${'b'.repeat(64)}` }), /look like/],
    ['a time zone missing', withConditions({ kind: 'timezone' }), /timeZone must be a non-empty string/],
    ['a locale with an underscore', withConditions({ kind: 'locale', locale: 'fr_FR' }), /locale must look like/],
    ['a locale too long', withConditions({ kind: 'locale', locale: `en${'-abcdefgh'.repeat(4)}` }), /look like/],
    ['an alongside without a test', withConditions({ kind: 'alongside' }), /\.test must be an object/],
    ['an unnamed project', withConditions({ kind: 'project', name: ' ' }), /name must be a non-empty string/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseFlakePlan(value)).toThrow(message);
  });

  test('reports invalid JSON as a plan error', () => {
    expect(() => parseFlakePlanText('{')).toThrow(/Invalid flake plan: not valid JSON/);
    expect(parseFlakePlanText(JSON.stringify(base)).experimentId).toBe('exp-1');
  });
});

describe('flakeTestMatches', () => {
  const ref = { file: 'tests/checkout.spec.ts', title: 'pays', suite: ['checkout'] };

  test('matches on file and title, and on the suite when both have one', () => {
    expect(flakeTestMatches(ref, { file: 'tests/checkout.spec.ts', title: 'pays', suite: ['checkout'] })).toBe(true);
    expect(flakeTestMatches(ref, { file: 'tests/checkout.spec.ts', title: 'pays' })).toBe(true);
    expect(flakeTestMatches(ref, { file: 'tests/checkout.spec.ts', title: 'pays', suite: ['guest'] })).toBe(false);
    expect(
      flakeTestMatches({ ...ref, suite: [] }, { file: 'tests/checkout.spec.ts', title: 'pays', suite: ['x'] }),
    ).toBe(true);
  });

  test('never matches another file or title', () => {
    expect(flakeTestMatches(ref, { file: 'tests/cart.spec.ts', title: 'pays' })).toBe(false);
    expect(flakeTestMatches(ref, { file: 'tests/checkout.spec.ts', title: 'refunds' })).toBe(false);
    expect(flakeTestMatches(ref, { file: null, title: 'pays' })).toBe(false);
  });
});

describe('flakeErrorSignature', () => {
  test('is the same for one failure with different values, and differs across failures', () => {
    const a = flakeErrorSignature(
      'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected: "$42"\nReceived: "$0"\nTimeout: 5000ms',
    );
    const b = flakeErrorSignature(
      'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected: "$17"\nReceived: ""\nTimeout: 7000ms',
    );
    const c = flakeErrorSignature('TimeoutError: page.click: Timeout 30000ms exceeded.');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('condition labels', () => {
  test('name each condition in a few words', () => {
    expect(describeFlakeCondition({ kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' })).toBe(
      'delay GET /api/cart 1.8 s',
    );
    expect(describeFlakeCondition({ kind: 'fail', route: 'POST /api/pay', status: 503, match: 'all' })).toBe(
      'fail POST /api/pay with 503',
    );
    expect(describeFlakeCondition({ kind: 'fail', route: 'POST /api/pay', abort: true, match: 'all' })).toBe(
      'abort POST /api/pay',
    );
    expect(describeFlakeCondition({ kind: 'cpu', rate: 4 })).toBe('CPU ×4');
    expect(describeFlakeCondition({ kind: 'timezone', timeZone: 'Europe/Paris' })).toBe('time zone Europe/Paris');
    expect(describeFlakeCondition({ kind: 'locale', locale: 'fr-FR' })).toBe('locale fr-FR');
    expect(
      describeFlakeCondition({
        kind: 'alongside',
        test: { file: 'a.spec.ts', title: 'resets catalog', suite: ['admin'] },
      }),
    ).toBe('run with admin › resets catalog');
    expect(describeFlakeCondition({ kind: 'after', test: { file: 'a.spec.ts', title: 'seeds', suite: [] } })).toBe(
      'run after seeds',
    );
    expect(describeFlakeCondition({ kind: 'project', name: 'firefox' })).toBe('on firefox');
  });

  test('join an arm and call an empty one the control', () => {
    expect(describeFlakeArm([])).toBe('control');
    expect(
      describeFlakeArm([
        { kind: 'delay', route: 'GET /api/cart', ms: 800, match: 'all' },
        { kind: 'cpu', rate: 4 },
      ]),
    ).toBe('delay GET /api/cart 800 ms + CPU ×4');
  });
});
