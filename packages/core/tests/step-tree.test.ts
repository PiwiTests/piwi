import { describe, test, expect } from 'vitest';
import {
  failingStepIndex,
  failureHookContext,
  isCaptureStep,
  isPhaseContainer,
  sameCodeLocation,
  stepFailureRoles,
  stepParents,
  stepPhases,
  type TreeStepLike,
} from '../src/step-tree';
import { categorizeStep, collectStepMetrics, flattenSteps, markRecoveredSteps } from '../src/step-analysis';
import {
  afterAllFailure,
  beforeAllFailure,
  beforeEachFailure,
  bodyFailure,
  caughtProbeFailure,
  caughtProbeTimeout,
  sameMessageProbeFailure,
  softAssertionsFailure,
  teardownAfterBodyFailure,
  toPassFailure,
  type RecordedExecution,
  type RecordedStep,
} from './fixtures/playwright-steps';

const titleAt = (steps: RecordedStep[], index: number | null) =>
  index === null ? null : [steps[index]!.title, steps[index]!.subtitle].filter(Boolean).join(' ');

/** The same steps without the recorded depth, as a reporter that predates it stored them. */
const withoutDepth = (steps: RecordedStep[]): TreeStepLike[] => steps.map(({ depth: _depth, ...rest }) => rest);

/**
 * The same steps as a reporter that marks no caught error stored them: no
 * `recovered` mark and no error location, with or without the depth.
 */
const unmarked = (steps: RecordedStep[], { depth = true } = {}): TreeStepLike[] =>
  steps.map(({ recovered: _recovered, depth: stepDepth, error, ...rest }) => ({
    ...rest,
    ...(depth ? { depth: stepDepth } : {}),
    ...(error ? { error: { message: error.message } } : {}),
  }));

/** Every way the steps of one execution can be stored: marked, unmarked, with and without depth. */
const storedShapes = (execution: RecordedExecution): Array<[string, TreeStepLike[]]> => [
  ['marked', execution.steps],
  ['marked, no depth', withoutDepth(execution.steps)],
  ['unmarked', unmarked(execution.steps)],
  ['unmarked, no depth', unmarked(execution.steps, { depth: false })],
];

/** The failing step's title and subtitle. */
const failingOf = (execution: RecordedExecution, steps: TreeStepLike[], error: string | null = execution.error) =>
  titleAt(execution.steps, failingStepIndex(steps, stepParents(steps), error));

/** Each failed step's role, keyed by `title subtitle`, the capture's and the passing steps left out. */
const rolesOf = (execution: RecordedExecution, steps: TreeStepLike[] = execution.steps) => {
  const roles = stepFailureRoles(steps, execution.error);
  return execution.steps.flatMap((_, i) => (roles[i] ? [[titleAt(execution.steps, i), roles[i]]] : []));
};

describe('stepParents', () => {
  test('rebuilds the tree from each step’s depth', () => {
    const parents = stepParents(bodyFailure.steps);
    const index = (title: string) => bodyFailure.steps.findIndex((s) => s.title === title);
    expect(parents[index('Before Hooks')]).toBe(-1);
    expect(parents[index('beforeAll hook')]).toBe(index('Before Hooks'));
    expect(parents[index('Sign in as Ada')]).toBe(index('beforeEach hook'));
    expect(parents[index('Fill contact details')]).toBe(-1);
    expect(parents[index('Fill contact details') + 1]).toBe(index('Fill contact details'));
  });

  test('without a depth, start times and durations give the same phases and failing step', () => {
    for (const execution of [bodyFailure, beforeEachFailure, beforeAllFailure, afterAllFailure]) {
      const timed = withoutDepth(execution.steps);
      expect(stepPhases(timed)).toEqual(stepPhases(execution.steps));
      expect(failingStepIndex(timed)).toBe(failingStepIndex(execution.steps));
    }
  });

  test('without a depth, a step inside another’s span is its child', () => {
    const parents = stepParents(withoutDepth(bodyFailure.steps));
    const index = (title: string) => bodyFailure.steps.findIndex((s) => s.title === title);
    expect(parents[index('Sign in as Ada')]).toBe(index('beforeEach hook'));
    expect(parents[index('Fill contact details') + 1]).toBe(index('Fill contact details'));
  });

  test('without a depth or times, every step is top level', () => {
    expect(stepParents([{ title: 'a' }, { title: 'b' }])).toEqual([-1, -1]);
  });
});

describe('stepPhases', () => {
  test('splits setup, the test body and teardown', () => {
    const phases = stepPhases(bodyFailure.steps);
    const phaseOf = (title: string) => phases[bodyFailure.steps.findIndex((s) => s.title === title)];
    expect(phaseOf('Before Hooks')).toBe('setup');
    expect(phaseOf('Sign in as Ada')).toBe('setup');
    expect(phaseOf('Launch browser')).toBe('setup');
    expect(phaseOf('Open checkout')).toBe('body');
    expect(phaseOf('Fill contact details')).toBe('body');
    expect(phaseOf('afterEach hook')).toBe('teardown');
    expect(phaseOf('afterAll hook')).toBe('teardown');
    expect(phaseOf('Worker Cleanup')).toBe('teardown');
  });
});

describe('failingStepIndex', () => {
  test('is the innermost step of the failing chain, not the test.step around it', () => {
    expect(titleAt(bodyFailure.steps, failingStepIndex(bodyFailure.steps))).toBe(
      'Fill "ada@example.com" getByLabel(\'Email address\')',
    );
  });

  test('finds the failing action inside a beforeEach hook, not "Before Hooks"', () => {
    expect(titleAt(beforeEachFailure.steps, failingStepIndex(beforeEachFailure.steps))).toBe(
      "Click getByRole('button', { name: 'Edit profile' })",
    );
  });

  test('finds the failing assertion inside a beforeAll and an afterAll hook', () => {
    expect(titleAt(beforeAllFailure.steps, failingStepIndex(beforeAllFailure.steps))).toBe(
      'seeding the report fixtures',
    );
    expect(titleAt(afterAllFailure.steps, failingStepIndex(afterAllFailure.steps))).toBe('cleanup endpoint');
  });

  test('works from start times alone', () => {
    expect(titleAt(beforeEachFailure.steps, failingStepIndex(withoutDepth(beforeEachFailure.steps)))).toBe(
      "Click getByRole('button', { name: 'Edit profile' })",
    );
  });

  test('never picks a capture probe that was cut off by the end of the test', () => {
    const steps: TreeStepLike[] = [
      {
        title: 'Evaluate',
        category: 'other',
        depth: 0,
        failed: true,
        error: { message: 'locator.evaluate: Test ended.' },
        location: '/work/shop/node_modules/@piwitests/reporter/dist/index.js:7770:17',
      },
      { title: 'Click', category: 'action', depth: 0, failed: true, error: { message: 'Timeout' } },
    ];
    expect(failingStepIndex(steps)).toBe(1);
  });

  test('is null when no step failed', () => {
    expect(failingStepIndex([{ title: 'a' }, { title: 'b' }])).toBeNull();
  });

  test.each(storedShapes(caughtProbeFailure))('skips a probe the test caught (%s)', (_, steps) => {
    expect(failingOf(caughtProbeFailure, steps)).toBe(
      "Expect \"toBeEnabled\" locator('.carousel').getByRole('link', { name: '' })",
    );
  });

  test('skips a caught probe on the last failing chain when the error is unknown', () => {
    expect(failingOf(caughtProbeFailure, unmarked(caughtProbeFailure.steps), null)).toBe(
      "Expect \"toBeEnabled\" locator('.carousel').getByRole('link', { name: '' })",
    );
  });

  test.each(storedShapes(sameMessageProbeFailure))(
    'tells caught probes that read the same error apart by where it was thrown (%s)',
    (_, steps) => {
      expect(failingOf(sameMessageProbeFailure, steps)).toBe(
        "Expect \"toBeVisible\" getByRole('button', { name: 'Missing' })",
      );
    },
  );

  test.each(storedShapes(softAssertionsFailure))('is the first failed soft assertion (%s)', (_, steps) => {
    expect(failingOf(softAssertionsFailure, steps)).toBe(
      "Expect \"soft toBeVisible\" getByRole('button', { name: 'Zed' })",
    );
  });

  test.each(storedShapes(teardownAfterBodyFailure))(
    'stays on the test body when the teardown fails after it (%s)',
    (_, steps) => {
      expect(failingOf(teardownAfterBodyFailure, steps)).toBe(
        "Expect \"toBeVisible\" getByRole('button', { name: 'Nope' })",
      );
    },
  );

  test('stays on the test body when the teardown fails after it and the error is unknown', () => {
    expect(failingOf(teardownAfterBodyFailure, teardownAfterBodyFailure.steps, null)).toBe(
      "Expect \"toBeVisible\" getByRole('button', { name: 'Nope' })",
    );
  });

  test.each(storedShapes(caughtProbeTimeout))('is the action the test timeout interrupted (%s)', (_, steps) => {
    expect(failingOf(caughtProbeTimeout, steps)).toBe("Click getByRole('button', { name: 'Nope' })");
  });

  test('is the toPass assertion when the reporter marked its attempts recovered', () => {
    expect(failingOf(toPassFailure, toPassFailure.steps)).toBe('Expect "toPass"');
  });

  test('is the last toPass attempt on steps stored without the mark', () => {
    const steps = unmarked(toPassFailure.steps);
    const index = failingStepIndex(steps, stepParents(steps), toPassFailure.error);
    expect(titleAt(toPassFailure.steps, index)).toBe('Expect "toBe"');
    expect(index).toBe(toPassFailure.steps.map((s) => s.title).lastIndexOf('Expect "toBe"'));
  });
});

describe('stepFailureRoles', () => {
  test('marks the caught probe recovered and the test.step around the failure enclosing', () => {
    expect(rolesOf(caughtProbeFailure)).toEqual([
      ["Expect \"toBeVisible\" getByRole('dialog').getByRole('button', { name: 'Confirm' })", 'recovered'],
      ['Check the download link', 'enclosing'],
      ["Expect \"toBeEnabled\" locator('.carousel').getByRole('link', { name: '' })", 'failing'],
    ]);
  });

  test('without the reporter’s mark, a step whose error is none of the test’s is recovered', () => {
    expect(rolesOf(caughtProbeFailure, unmarked(caughtProbeFailure.steps))).toEqual(rolesOf(caughtProbeFailure));
  });

  test('never marks a failed soft assertion recovered', () => {
    expect(rolesOf(softAssertionsFailure)).toEqual([
      ["Expect \"soft toBeVisible\" getByRole('button', { name: 'Zed' })", 'failing'],
      ["Expect \"soft toBeVisible\" getByRole('button', { name: 'Qux' })", 'failed'],
    ]);
  });

  test('keeps a teardown that failed after the body as a second failure', () => {
    expect(rolesOf(teardownAfterBodyFailure)).toEqual([
      ["Expect \"toBeVisible\" getByRole('button', { name: 'Nope' })", 'failing'],
      ['After Hooks', 'failed'],
      ['afterEach hook', 'failed'],
      ["Expect \"toBeVisible\" getByRole('heading', { name: 'Bye' })", 'failed'],
    ]);
  });

  test('marks every retried toPass attempt recovered', () => {
    const roles = rolesOf(toPassFailure);
    expect(roles[0]).toEqual(['Expect "toPass"', 'failing']);
    expect(roles.slice(1).every(([, role]) => role === 'recovered')).toBe(true);
    expect(roles).toHaveLength(6);
  });

  test('is null for every step of a passing execution', () => {
    expect(stepFailureRoles(bodyFailure.steps.map(({ failed: _f, error: _e, ...rest }) => rest))).toEqual(
      bodyFailure.steps.map(() => null),
    );
  });
});

describe('sameCodeLocation', () => {
  test('matches the same line and column in the same file, one path relative', () => {
    expect(
      sameCodeLocation('/work/shop/tests/a.spec.ts:26:77', { file: 'tests/a.spec.ts', line: 26, column: 77 }),
    ).toBe(true);
    expect(sameCodeLocation('/work/shop/tests/a.spec.ts:26:77', '/work/shop/tests/a.spec.ts:26:78')).toBe(false);
    expect(sameCodeLocation('/work/shop/tests/a.spec.ts:26:77', 'tests/b.spec.ts:26:77')).toBe(false);
    expect(sameCodeLocation('', 'tests/b.spec.ts:26:77')).toBe(false);
  });
});

describe('markRecoveredSteps', () => {
  const location = (line: number) => ({ file: '/work/shop/tests/a.spec.ts', line, column: 5 });
  const probe = (line: number) => ({
    title: 'Expect "toBeVisible"',
    category: 'expect',
    duration: 500,
    error: {
      message: '\u001b[2mexpect(\u001b[22mlocator).toBeVisible() failed\n\nLocator: …',
      location: location(line),
    },
    steps: [],
  });

  test('marks a step whose error is none of the test’s errors, and keeps where each was thrown', () => {
    const steps = flattenSteps([probe(10), probe(20)]);
    markRecoveredSteps(steps, [{ message: 'expect(locator).toBeVisible() failed', location: location(20) }]);
    expect(steps.map((s) => [s.error?.location, s.recovered ?? false])).toEqual([
      ['/work/shop/tests/a.spec.ts:10:5', true],
      ['/work/shop/tests/a.spec.ts:20:5', false],
    ]);
  });

  test('matches on the first line alone when the test error records no location', () => {
    const steps = flattenSteps([probe(10)]);
    markRecoveredSteps(steps, [{ message: 'expect(locator).toBeVisible() failed\n\nsomething else' }]);
    expect(steps[0]!.recovered).toBeUndefined();
  });

  test('marks every step error of a passing test, through collectStepMetrics', () => {
    expect(collectStepMetrics([probe(10)], []).steps[0]!.recovered).toBe(true);
    expect(collectStepMetrics([probe(10)]).steps[0]!.recovered).toBeUndefined();
  });
});

describe('failureHookContext', () => {
  test('is null for a failure in the test body', () => {
    expect(failureHookContext(bodyFailure.steps, bodyFailure.error)).toBeNull();
  });

  test('names the hook a setup or teardown failure happened in', () => {
    expect(failureHookContext(beforeEachFailure.steps, beforeEachFailure.error)).toEqual({
      phase: 'setup',
      hook: 'beforeEach',
    });
    expect(failureHookContext(beforeAllFailure.steps, beforeAllFailure.error)).toEqual({
      phase: 'setup',
      hook: 'beforeAll',
    });
    expect(failureHookContext(afterAllFailure.steps, afterAllFailure.error)).toEqual({
      phase: 'teardown',
      hook: 'afterAll',
    });
  });

  test('names a fixture, and a hook with its own title', () => {
    const steps: TreeStepLike[] = [
      { title: 'Before Hooks', category: 'hook', depth: 0, failed: true, error: { message: 'Error: db down' } },
      { title: 'Fixture "db"', category: 'fixture', depth: 1, failed: true, error: { message: 'Error: db down' } },
    ];
    expect(failureHookContext(steps, 'Error: db down')).toEqual({ phase: 'setup', hook: 'fixture "db"' });

    const named: TreeStepLike[] = [
      { title: 'Before Hooks', category: 'hook', depth: 0, failed: true, error: { message: 'Error: x' } },
      { title: 'seed the catalog', category: 'hook', depth: 1, failed: true, error: { message: 'Error: x' } },
    ];
    expect(failureHookContext(named, 'Error: x')).toEqual({ phase: 'setup', hook: 'hook "seed the catalog"' });
  });

  test('is null when the failing hook step does not carry the execution’s own error', () => {
    expect(failureHookContext(afterAllFailure.steps, 'Error: something else in the test body')).toBeNull();
  });

  test('is null for a body failure followed by a failing teardown', () => {
    expect(failureHookContext(teardownAfterBodyFailure.steps, teardownAfterBodyFailure.error)).toBeNull();
  });
});

describe('isCaptureStep', () => {
  test('recognizes the capture’s attachments and its probes through the reporter bundle', () => {
    expect(isCaptureStep({ title: 'Attach "piwi-locators"' })).toBe(true);
    expect(isCaptureStep({ title: 'Fixture "piwiCapture"', category: 'fixture' })).toBe(true);
    expect(isCaptureStep({ title: 'Fixture "page"', category: 'fixture' })).toBe(false);
    expect(isCaptureStep({ title: 'Attach "screenshot"' })).toBe(false);
    expect(
      isCaptureStep({
        title: 'Evaluate',
        location: '/ci/work/node_modules/@piwitests/reporter/dist/index.js:7770:17',
      }),
    ).toBe(true);
    expect(isCaptureStep({ title: 'Evaluate', location: '/ci/work/tests/checkout.spec.ts:22:16' })).toBe(false);
  });
});

describe('isPhaseContainer', () => {
  test('recognizes Playwright’s phase containers only', () => {
    expect(isPhaseContainer({ title: 'Before Hooks' })).toBe(true);
    expect(isPhaseContainer({ title: 'After Hooks' })).toBe(true);
    expect(isPhaseContainer({ title: 'Worker Cleanup' })).toBe(true);
    expect(isPhaseContainer({ title: 'beforeEach hook' })).toBe(false);
  });
});

describe('flattenSteps and categorizeStep', () => {
  test('flattening records each step’s depth', () => {
    const flat = flattenSteps([
      {
        title: 'Before Hooks',
        category: 'hook',
        duration: 5,
        steps: [{ title: 'beforeEach hook', category: 'hook', duration: 4 }],
      },
      {
        title: 'Open checkout',
        category: 'test.step',
        duration: 3,
        steps: [{ title: 'Click', category: 'pw:api', duration: 2 }],
      },
    ]);
    expect(flat.map((s) => [s.title, s.depth])).toEqual([
      ['Before Hooks', 0],
      ['beforeEach hook', 1],
      ['Open checkout', 0],
      ['Click', 1],
    ]);
  });

  test('a test.step is a group whatever its title, an API request is api, an attachment is attach', () => {
    expect(categorizeStep('Fill contact details', 'test.step')).toBe('test.step');
    expect(categorizeStep('POST', 'pw:api', { url: '/api/seed', method: 'POST' })).toBe('api');
    expect(categorizeStep('Navigate', 'pw:api', { url: '/login' })).toBe('navigation');
    expect(categorizeStep('Attach "trace"', 'test.attach')).toBe('attach');
  });
});

describe('the text a fill or a typing typed, in the stored steps', () => {
  test('goes from the title, the params and the error of a step into a field that may hold a secret', () => {
    const steps = flattenSteps([
      {
        title: 'Fill "S3cr3t!Passw0rd"',
        subtitle: "getByLabel('Password')",
        category: 'pw:api',
        duration: 5,
        params: { locator: "getByLabel('Password')", value: 'S3cr3t!Passw0rd' },
      },
      {
        title: 'Type "123456"',
        subtitle: "getByLabel('Code de vérification')",
        category: 'pw:api',
        duration: 5,
        params: { locator: "getByLabel('Code de vérification')", text: '123456' },
      },
      { title: 'Type "hunter2"', category: 'pw:api', duration: 5, params: { text: 'hunter2' } },
      {
        title: 'Fill "S3cr3t"',
        subtitle: "getByLabel('Mot de passe')",
        category: 'pw:api',
        duration: 5,
        params: { locator: "getByLabel('Mot de passe')", value: 'S3cr3t' },
        error: {
          message: 'locator.fill: Timeout 1500ms exceeded.\nCall log:\n  - fill("S3cr3t")\n  - attempting fill action',
        },
      },
    ]);
    expect(JSON.stringify(steps)).not.toMatch(/S3cr3t|hunter2/);
    expect(steps[0]).toMatchObject({
      title: 'Fill "<hidden>"',
      params: { locator: "getByLabel('Password')", value: '<hidden>' },
    });
    expect(steps[2]).toMatchObject({ title: 'Type "<hidden>"', params: { text: '<hidden>' } });
    expect(steps[3]!.error!.message).toContain('fill("<hidden>")');
  });

  test('stays in the step of a field no locator names as a secret, for a bug report to replay it', () => {
    const [step] = flattenSteps([
      {
        title: 'Fill "WELCOME10"',
        subtitle: "getByLabel('Coupon')",
        category: 'pw:api',
        duration: 5,
        params: { locator: "getByLabel('Coupon')", value: 'WELCOME10' },
      },
    ]);
    expect(step).toMatchObject({ title: 'Fill "WELCOME10"', params: { value: 'WELCOME10' } });
  });
});
