import { describe, it, expect, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import {
  lazyLocator,
  readMaskedSnapshot,
  resolveLocator,
  resolveRun,
  ServerStepResolver,
  type StepResolutionRequest,
  type StepResolutionResponse,
  type StepResolver,
} from '../src/internal/ai/resolution.js';

interface Call {
  method: string;
  args: unknown[];
}

/** A recording double: methods log their call and return another recorder (never thenable). */
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

/** A no-op response observer for tests not about Ajax capture (runs the action, sees nothing). */
const noObserve = async (_page: Page, action: () => Promise<void>): Promise<string[]> => {
  await action();
  return [];
};

/** A resolver that replays a fixed script of decisions and records each request. */
function scripted(responses: StepResolutionResponse[]): { resolver: StepResolver; requests: StepResolutionRequest[] } {
  const requests: StepResolutionRequest[] = [];
  let i = 0;
  return {
    requests,
    resolver: {
      async resolveStep(request) {
        requests.push(request);
        return (
          responses[i++] ?? {
            done: true,
            postcondition: { assert: 'visible', element: { role: 'heading', name: 'x' } },
          }
        );
      },
    },
  };
}

describe('resolveLocator', () => {
  it('resolves, compiles and verifies a single-element entry', async () => {
    const { page } = recorderPage();
    const { resolver } = scripted([{ element: { role: 'button', name: 'Submit' } }]);
    const entry = await resolveLocator('the submit button', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '- button "Submit"',
    });
    expect(entry).toMatchObject({ kind: 'locator', template: 'the submit button', locator: { method: 'getByRole' } });
  });

  it('accepts a parametric grounding whose name is the masked marker', async () => {
    const { page } = recorderPage();
    const { resolver } = scripted([{ element: { role: 'row', name: '{{name}}' } }]);
    const entry = await resolveLocator('row for {name}', {
      page,
      params: { name: 'Alice' },
      resolver,
      readSnapshot: async () => '- row "{{name}}"',
    });
    expect(JSON.stringify(entry.locator)).toContain('{{name}}');
  });

  it('rejects a non-parametric grounding that pinned a concrete value', async () => {
    const { page } = recorderPage();
    const { resolver } = scripted([{ element: { role: 'row', name: 'Alice' } }]);
    await expect(
      resolveLocator('row for {name}', { page, params: { name: 'Alice' }, resolver, readSnapshot: async () => '' }),
    ).rejects.toThrow(/not parametric/);
  });

  it('caps the snapshot sent to the resolver at the configured maxSnapshotChars', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = scripted([{ element: { role: 'button', name: 'Go' } }]);
    await resolveLocator('the go button', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => 'x'.repeat(1000),
      maxSnapshotChars: 50,
    });
    expect(requests[0].ariaSnapshot).toHaveLength(50);
  });
});

describe('resolveRun', () => {
  it('drives the loop, executes each step and asserts the postcondition', async () => {
    const { page, log } = recorderPage();
    const { resolver, requests } = scripted([
      { element: { role: 'textbox', name: 'Email' }, action: 'fill', value: '{{email}}' },
      { done: true, postcondition: { assert: 'visible', element: { role: 'heading', name: 'Home' } } },
    ]);
    const entry = await resolveRun('log in as {email}', {
      page,
      params: { email: 'a@b.c' },
      resolver,
      readSnapshot: async () => '- textbox "Email"',
      observeResponses: noObserve,
    });
    expect(entry.steps).toHaveLength(1);
    expect(entry.steps[0]).toMatchObject({ action: 'fill', value: '{{email}}' });
    expect(entry.postcondition).toMatchObject({ assert: 'visible' });
    // The fill ran with the real value; the second request carried the history.
    expect(log.some((c) => c.method === 'fill' && c.args[0] === 'a@b.c')).toBe(true);
    expect(requests[1].history).toHaveLength(1);
  });

  it('throws when the flow declares done without a postcondition oracle', async () => {
    const { page } = recorderPage();
    const { resolver } = scripted([{ done: true }]);
    await expect(
      resolveRun('do a thing', { page, params: {}, resolver, readSnapshot: async () => '' }),
    ).rejects.toThrow(/postcondition/);
  });

  it('enforces the max-step budget', async () => {
    const { page } = recorderPage();
    const { resolver } = scripted(
      Array.from({ length: 5 }, () => ({ element: { role: 'button', name: 'Next' }, action: 'click' as const })),
    );
    await expect(
      resolveRun('click forever', {
        page,
        params: {},
        resolver,
        readSnapshot: async () => '',
        maxSteps: 3,
        observeResponses: noObserve,
      }),
    ).rejects.toThrow(/budget/);
  });
});

describe('resolveRun — Ajax wait', () => {
  /** A resolver that emits one action step, then done, and answers wait-picks with a fixed glob. */
  function loginResolver(waitGlob: string | null): { resolver: StepResolver; requests: StepResolutionRequest[] } {
    const requests: StepResolutionRequest[] = [];
    return {
      requests,
      resolver: {
        async resolveStep(request) {
          requests.push(request);
          if (request.kind === 'wait') return waitGlob ? { waitForResponse: waitGlob } : {};
          const priorSteps = requests.filter((r) => r.kind === 'run').length;
          if (priorSteps === 1) return { element: { role: 'button', name: 'Sign in' }, action: 'click' };
          return { done: true, postcondition: { assert: 'visible', element: { role: 'heading', name: 'Home' } } };
        },
      },
    };
  }

  it('observes the Ajax the step triggered and stores the model-chosen wait pattern', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = loginResolver('**/api/login');
    const entry = await resolveRun('log in', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '- button "Sign in"',
      observeResponses: async (_page, action) => {
        await action();
        return ['https://app.example/api/login'];
      },
    });
    expect(entry.steps[0].waitForResponse).toBe('**/api/login');
    const waitReq = requests.find((r) => r.kind === 'wait');
    expect(waitReq?.observedResponses).toEqual(['https://app.example/api/login']);
  });

  it('masks parameter values out of observed response URLs before sending them', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = loginResolver('**/api/users/**');
    await resolveRun('open profile', {
      page,
      params: { email: 'alice@example.com' },
      resolver,
      readSnapshot: async () => '- button "Sign in"',
      observeResponses: async (_page, action) => {
        await action();
        return ['https://app.example/api/users/alice@example.com'];
      },
    });
    expect(requests.find((r) => r.kind === 'wait')?.observedResponses).toEqual([
      'https://app.example/api/users/{{email}}',
    ]);
  });

  it('sends each observed URL once, at most fifty, and leaves out an overlong one', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = loginResolver('**/api/items/**');
    const items = Array.from({ length: 60 }, (_, i) => `https://app.example/api/items/${i}`);
    await resolveRun('log in', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '- button "Sign in"',
      observeResponses: async (_page, action) => {
        await action();
        return [`https://app.example/api/huge?q=${'x'.repeat(4_000)}`, items[0]!, ...items];
      },
    });
    expect(requests.find((r) => r.kind === 'wait')?.observedResponses).toEqual(items.slice(0, 50));
  });

  it('skips the wait-pick entirely when the step triggered no Ajax', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = loginResolver('**/never');
    const entry = await resolveRun('log in', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '- button "Sign in"',
      observeResponses: async (_page, action) => {
        await action();
        return [];
      },
    });
    expect(entry.steps[0].waitForResponse).toBeUndefined();
    expect(requests.some((r) => r.kind === 'wait')).toBe(false);
  });
});

describe('screenshot vision fallback', () => {
  const shot = { mediaType: 'image/jpeg' as const, data: 'BASE64' };

  it('attaches a screenshot only when enabled AND the ARIA snapshot is empty', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = scripted([{ element: { role: 'button', name: 'Go' } }]);
    await resolveLocator('the go button', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '', // canvas-heavy: no ARIA
      screenshotFallback: true,
      captureScreenshot: async () => shot,
    });
    expect(requests[0].screenshot).toEqual(shot);
  });

  it('sends no screenshot when the ARIA snapshot is usable', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = scripted([{ element: { role: 'button', name: 'Go' } }]);
    await resolveLocator('the go button', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '- button "Go"',
      screenshotFallback: true,
      captureScreenshot: async () => shot,
    });
    expect(requests[0].screenshot).toBeUndefined();
  });

  it('never captures when the fallback is off (default — safe for non-vision models)', async () => {
    const { page } = recorderPage();
    const { resolver, requests } = scripted([{ element: { role: 'button', name: 'Go' } }]);
    let captured = false;
    await resolveLocator('the go button', {
      page,
      params: {},
      resolver,
      readSnapshot: async () => '',
      captureScreenshot: async () => {
        captured = true;
        return shot;
      },
    });
    expect(captured).toBe(false);
    expect(requests[0].screenshot).toBeUndefined();
  });
});

describe('lazyLocator', () => {
  it('defers resolution until first use and memoizes it', async () => {
    const log: Call[] = [];
    let built = 0;
    const lazy: Locator = lazyLocator(async () => {
      built++;
      return makeRecorder(log) as unknown as Locator;
    });
    await lazy.click();
    await lazy.fill('x');
    expect(built).toBe(1);
    expect(log.map((c) => c.method)).toEqual(['click', 'fill']);
  });
});

describe('readMaskedSnapshot', () => {
  it('masks parameter values out of the snapshot it returns', async () => {
    const page = {
      locator: () => ({ ariaSnapshot: async () => '- textbox "alice@example.com"' }),
    } as unknown as Page;
    const snapshot = await readMaskedSnapshot(page, { email: 'alice@example.com' });
    expect(snapshot).toBe('- textbox "{{email}}"');
  });

  it('leaves the [ref=…] markers intact when a param value appears in one', async () => {
    const page = {
      locator: () => ({ ariaSnapshot: async () => '- button "Add 1" [ref=e12]' }),
    } as unknown as Page;
    expect(await readMaskedSnapshot(page, { qty: '1' })).toBe('- button "Add {{qty}}" [ref=e12]');
  });
});

describe('ServerStepResolver', () => {
  it('posts the request to the endpoint with the API key and returns the decision', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({
      ok: true,
      json: async () => ({ element: { role: 'button', name: 'Go' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const resolver = new ServerStepResolver('https://dash.example/', 'pd_key');
      const res = await resolver.resolveStep({
        kind: 'locator',
        template: 'x',
        paramNames: [],
        ariaSnapshot: '',
        history: [],
      });
      expect(res.element).toEqual({ role: 'button', name: 'Go' });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://dash.example/api/ai/step-resolution');
      expect(opts.headers['X-API-Key']).toBe('pd_key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws the server message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ message: 'AI is not configured' }) })),
    );
    try {
      const resolver = new ServerStepResolver('https://dash.example', null);
      await expect(
        resolver.resolveStep({ kind: 'locator', template: 'x', paramNames: [], ariaSnapshot: '', history: [] }),
      ).rejects.toThrow(/AI is not configured/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
