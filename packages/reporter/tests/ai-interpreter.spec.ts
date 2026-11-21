import { describe, it, expect } from 'vitest';
import type { Page } from '@playwright/test';
import {
  assertPostcondition,
  buildLocator,
  checkFingerprintDrift,
  describeLocator,
  executeStep,
  executeRun,
  locatorSource,
  PostconditionError,
  StepDriftError,
} from '../src/internal/ai/interpreter.js';
import type { RunEntry, RunStep } from '../src/internal/ai/artifact.js';

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A recording double: every method logs its call and returns another recorder.
 * `then`/`catch`/`finally` and symbols resolve to `undefined` so `await`ing a
 * returned locator does not treat it as a never-resolving thenable.
 */
function makeRecorder(log: Call[]): Record<string, (...args: unknown[]) => unknown> {
  const handler: ProxyHandler<Record<string, never>> = {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return (...args: unknown[]) => {
        log.push({ method: prop, args });
        return new Proxy({}, handler);
      };
    },
  };
  return new Proxy({}, handler) as Record<string, (...args: unknown[]) => unknown>;
}

function recorderPage(log: Call[] = []): { page: Page; log: Call[] } {
  return { page: makeRecorder(log) as unknown as Page, log };
}

describe('buildLocator', () => {
  it('dispatches the builder method with substituted args and chains', () => {
    const { page, log } = recorderPage();
    buildLocator(
      page,
      { method: 'getByRole', args: ['list'], chain: [{ method: 'getByText', args: ['{{name}}'] }] },
      { name: 'Alice' },
    );
    expect(log).toEqual([
      { method: 'getByRole', args: ['list'] },
      { method: 'getByText', args: ['Alice'] },
    ]);
  });

  it('rejects a non-allowlisted method', () => {
    const { page } = recorderPage();
    expect(() => buildLocator(page, { method: 'evaluate', args: [] })).toThrow(/not allowlisted/);
  });
});

describe('describeLocator', () => {
  it('renders a readable call including the chain', () => {
    expect(describeLocator({ method: 'getByRole', args: ['list'], chain: [{ method: 'first', args: [] }] })).toBe(
      'getByRole("list").first()',
    );
  });
});

describe('locatorSource', () => {
  it("renders Playwright's own source style, matching its error messages", () => {
    expect(locatorSource({ method: 'getByRole', args: ['textbox', { name: 'Email' }] })).toBe(
      "getByRole('textbox', { name: 'Email' })",
    );
  });

  it('renders chains, numbers and escaped quotes', () => {
    expect(
      locatorSource({
        method: 'getByRole',
        args: ['heading', { name: "Ada's page", level: 1 }],
        chain: [{ method: 'first', args: [] }],
      }),
    ).toBe("getByRole('heading', { name: 'Ada\\'s page', level: 1 }).first()");
  });

  it('keeps {{param}} markers verbatim so values never appear', () => {
    expect(locatorSource({ method: 'getByLabel', args: ['{{field}}'] })).toBe("getByLabel('{{field}}')");
  });
});

describe('checkFingerprintDrift', () => {
  it('returns present when a same-role, same-name candidate exists', () => {
    expect(checkFingerprintDrift('- button "Save"', { role: 'button', name: 'Save' })).toBe('present');
  });
  it('returns drifted when the role is there but the name is gone', () => {
    expect(checkFingerprintDrift('- button "Delete"', { role: 'button', name: 'Save changes now' })).toBe('drifted');
  });
  it('returns unknown for an empty or unreadable snapshot', () => {
    expect(checkFingerprintDrift(null, { role: 'button', name: 'Save' })).toBe('unknown');
    expect(checkFingerprintDrift('', { role: 'button', name: 'Save' })).toBe('unknown');
  });
});

describe('executeStep', () => {
  it('builds the locator and runs the action with its value', async () => {
    const { page, log } = recorderPage();
    const step: RunStep = { locator: { method: 'getByLabel', args: ['Email'] }, action: 'fill', value: '{{email}}' };
    const result = await executeStep(step, { page, params: { email: 'a@b.c' } });
    expect(result).toBe('ran');
    expect(log).toEqual([
      { method: 'getByLabel', args: ['Email'] },
      { method: 'fill', args: ['a@b.c'] },
    ]);
  });

  it('skips an optional step whose element never becomes visible', async () => {
    // The recorder's waitFor resolves, so drive absence via a readAria-free probe override.
    const log: Call[] = [];
    const failingProbe = {
      get(_t: unknown, prop: string) {
        return () => {
          if (prop === 'waitFor') return Promise.reject(new Error('timeout'));
          return new Proxy({}, failingProbe);
        };
      },
    };
    const page = new Proxy({}, failingProbe) as unknown as Page;
    const step: RunStep = {
      locator: { method: 'getByRole', args: ['button', { name: 'Accept cookies' }] },
      action: 'click',
      optional: true,
    };
    const result = await executeStep(step, { page, params: {}, optionalProbeTimeout: 5 });
    expect(result).toBe('skipped');
    expect(log).toEqual([]);
  });

  it('arms waitForResponse before firing the action (race-proof)', async () => {
    const { page, log } = recorderPage();
    const step: RunStep = {
      locator: { method: 'getByRole', args: ['button', { name: 'Save' }] },
      action: 'click',
      waitForResponse: '**/api/save',
    };
    await executeStep(step, { page, params: {} });
    // The wait is registered strictly before the click, so a fast reply can't slip through.
    expect(log.map((c) => c.method)).toEqual(['getByRole', 'waitForResponse', 'click']);
    expect(log.find((c) => c.method === 'waitForResponse')?.args[0]).toBe('**/api/save');
  });

  it('substitutes params into the wait pattern and forwards the configured timeout', async () => {
    const { page, log } = recorderPage();
    const step: RunStep = {
      locator: { method: 'getByRole', args: ['button'] },
      action: 'click',
      waitForResponse: '**/api/users/{{id}}',
    };
    await executeStep(step, { page, params: { id: '42' }, responseWaitTimeout: 5000 });
    expect(log.find((c) => c.method === 'waitForResponse')?.args).toEqual(['**/api/users/42', { timeout: 5000 }]);
  });

  it('throws StepDriftError before acting when the fingerprint drifted', async () => {
    const { page, log } = recorderPage();
    const step: RunStep = {
      locator: { method: 'getByRole', args: ['button', { name: 'Save' }] },
      action: 'click',
      fingerprint: { role: 'button', name: 'Save changes now' },
    };
    await expect(
      executeStep(step, { page, params: {}, readAria: async () => '- button "Delete"' }),
    ).rejects.toBeInstanceOf(StepDriftError);
    // The action never ran (only the locator was built).
    expect(log.some((c) => c.method === 'click')).toBe(false);
  });
});

describe('assertPostcondition', () => {
  it('waits for the target to become visible', async () => {
    const { page, log } = recorderPage();
    await assertPostcondition({ assert: 'visible', locator: { method: 'getByRole', args: ['heading'] } }, {
      page,
      params: {},
    });
    expect(log).toContainEqual({ method: 'getByRole', args: ['heading'] });
    expect(log).toContainEqual({ method: 'waitFor', args: [{ state: 'visible' }] });
  });

  it('waits for a substituted URL', async () => {
    const { page, log } = recorderPage();
    await assertPostcondition({ assert: 'url', url: '/orders/{{id}}' }, { page, params: { id: '42' } });
    expect(log).toContainEqual({ method: 'waitForURL', args: ['/orders/42'] });
  });

  it('wraps a failure in PostconditionError', async () => {
    const rejecting = {
      get(_t: unknown, prop: string) {
        return () => {
          if (prop === 'waitForURL') return Promise.reject(new Error('nope'));
          return new Proxy({}, rejecting);
        };
      },
    };
    const page = new Proxy({}, rejecting) as unknown as Page;
    await expect(assertPostcondition({ assert: 'url', url: '/x' }, { page, params: {} })).rejects.toBeInstanceOf(
      PostconditionError,
    );
  });
});

describe('executeRun', () => {
  it('runs every step then asserts the postcondition', async () => {
    const { page, log } = recorderPage();
    const entry: RunEntry = {
      version: 1,
      kind: 'run',
      template: 'log in as {email}',
      steps: [
        { locator: { method: 'getByLabel', args: ['Email'] }, action: 'fill', value: '{{email}}' },
        { locator: { method: 'getByRole', args: ['button', { name: 'Sign in' }] }, action: 'click' },
      ],
      postcondition: { assert: 'visible', locator: { method: 'getByRole', args: ['heading', { name: 'Home' }] } },
    };
    await executeRun(entry, { page, params: { email: 'a@b.c' } });
    const methods = log.map((c) => c.method);
    expect(methods).toEqual(['getByLabel', 'fill', 'getByRole', 'click', 'getByRole', 'first', 'waitFor']);
  });
});
