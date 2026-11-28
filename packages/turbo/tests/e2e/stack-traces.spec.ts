import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { state } from '../../src/hooks';
import { expect, test } from '../../src/test';

test.use({ fastStackTraces: true });

function callSites(): NodeJS.CallSite[] {
  const prepare = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, stack) => stack;
  try {
    return new Error().stack as unknown as NodeJS.CallSite[];
  } finally {
    Error.prepareStackTrace = prepare;
  }
}

test('formats a stack as source-map-support does', async () => {
  const stack = await (async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return callSites();
  })();
  const error = new TypeError('boom');
  const formatted = Error.prepareStackTrace!(error, stack);
  expect(Error.prepareStackTrace).not.toBe(state.sourceMappedStackTrace);
  expect(formatted).toBe(state.sourceMappedStackTrace!(error, stack));
  // Frames of both kinds: this file's, mapped to its TypeScript lines, and Playwright's, in node_modules.
  expect(formatted).toMatch(/stack-traces\.spec\.ts:\d+:\d+/);
  expect(formatted).toMatch(/[\\/]node_modules[\\/]/);
});

test('keeps the location of a failed assertion in the test file', () => {
  let error: Error | undefined;
  try {
    expect(1).toBe(2);
  } catch (caught) {
    error = caught as Error;
  }
  const source = readFileSync(test.info().file, 'utf8').split('\n');
  const line = source.findIndex((text) => text.trim() === 'expect(1).toBe(2);') + 1;
  expect(error?.stack).toContain(`stack-traces.spec.ts:${line}:`);
});

/** The stacks formatted while `run` runs whose top frame is the race of an evaluation against its context. */
async function raceStacks(run: () => Promise<unknown>): Promise<number> {
  const prepare = Error.prepareStackTrace!;
  let count = 0;
  Error.prepareStackTrace = (error, stack) => {
    if (stack[0]?.getFunctionName() === '_race') count++;
    return prepare(error, stack);
  };
  try {
    await run();
  } finally {
    Error.prepareStackTrace = prepare;
  }
  return count;
}

/** An error as Playwright's server ends a call with it, which a trace and its debug log show. */
interface ServerError {
  message?: string;
  stack?: string;
}

/** The errors Playwright's server ends the calls of `run` with. */
async function serverErrors(page: Page, run: () => Promise<unknown>): Promise<ServerError[]> {
  type Listener = { onAfterCall: (progress: { metadata?: { error?: { error?: ServerError } } }) => void };
  type ServerContext = {
    instrumentation: {
      addListener: (listener: Listener, context: unknown) => void;
      removeListener: (listener: Listener) => void;
    };
  };
  const context = page.context();
  const connection = (context as unknown as { _connection: { toImpl: (object: unknown) => ServerContext } })
    ._connection;
  const impl = connection.toImpl(context);
  const errors: ServerError[] = [];
  const listener: Listener = {
    onAfterCall: (progress) => {
      const error = progress.metadata?.error?.error;
      if (error) errors.push(error);
    },
  };
  impl.instrumentation.addListener(listener, impl);
  try {
    await run().catch(() => {});
  } finally {
    impl.instrumentation.removeListener(listener);
  }
  return errors;
}

const firstLine = (error: ServerError) => (error.stack ?? '').split('\n')[0];
const framesOf = (error: ServerError) =>
  (error.stack ?? '').split('\n').filter((line) => line.startsWith('    at ')).length;

/** The error `call` fails with. */
const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => new Error('the call passed'),
    (error: Error) => error,
  );

test('alone, leaves the race of an evaluation against its context to Playwright', async ({ page }) => {
  await page.setContent('<p>race</p>');
  const before = state.counters.lightRaces;
  expect(state.lightRaces).toBe(false);
  expect(await raceStacks(() => page.evaluate(() => document.title))).toBeGreaterThan(0);
  expect(state.counters.lightRaces).toBe(before);
});

test.describe('with another hook on', () => {
  test.use({ skipStabilityWait: true });

  test("an evaluation's race against its context's destruction formats no stack", async ({ page }) => {
    await page.setContent('<p>race</p>');
    const before = state.counters.lightRaces;
    const evaluations = async () => {
      for (let i = 0; i < 20; i++) await page.evaluate(() => document.title);
    };
    expect(await raceStacks(evaluations)).toBe(0);
    expect(state.counters.lightRaces - before).toBeGreaterThanOrEqual(20);
    state.lightRaces = false;
    try {
      expect(await raceStacks(evaluations)).toBeGreaterThanOrEqual(20);
    } finally {
      state.lightRaces = true;
    }
  });

  test('an evaluation in a document that is gone fails with the same error', async ({ page }) => {
    await page.route('http://turbo.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>page</p>' }),
    );
    const errors: Array<Error | undefined> = [];
    const raced: number[] = [];
    for (const lightRaces of [true, false]) {
      await page.goto('http://turbo.test/first');
      const body = await page.evaluateHandle(() => document.body);
      await page.goto('http://turbo.test/second');
      state.lightRaces = lightRaces;
      const before = state.counters.lightRaces;
      try {
        errors.push(
          await body
            .evaluate((element) => element.tagName)
            .then(
              () => undefined,
              (error: Error) => error,
            ),
        );
      } finally {
        state.lightRaces = true;
      }
      raced.push(state.counters.lightRaces - before);
    }
    const [light, stock] = errors;
    expect(raced[0]).toBeGreaterThan(0);
    expect(raced[1]).toBe(0);
    expect(light?.message).toContain('Execution context was destroyed');
    expect(light?.message).toBe(stock?.message);
    expect(light?.stack).toBe(stock?.stack);
    expect(light?.stack).toMatch(/stack-traces\.spec\.ts:\d+:\d+/);
  });

  test('a call that times out fails with the same error, its timeout prepared with no stack', async ({ page }) => {
    await page.setContent('<p>timeout</p>');
    expect(state.lightTimeouts).toBe(true);
    const errors: Error[] = [];
    const server: ServerError[] = [];
    const prepared: number[] = [];
    for (const lightTimeouts of [true, false]) {
      state.lightTimeouts = lightTimeouts;
      const before = state.counters.lightTimeouts;
      try {
        server.push(
          ...(await serverErrors(page, async () => {
            errors.push(await failure(page.locator('#missing').click({ timeout: 300 })));
          })),
        );
      } finally {
        state.lightTimeouts = true;
      }
      prepared.push(state.counters.lightTimeouts - before);
    }
    const [light, stock] = errors;
    // The call, and the instrumentation before and after it.
    expect(prepared).toEqual([3, 0]);
    expect(light.message).toContain('Timeout 300ms exceeded');
    expect(light.message).toBe(stock.message);
    expect(light.stack).toBe(stock.stack);
    expect(light.stack).toMatch(/stack-traces\.spec\.ts:\d+:\d+/);
    expect(server).toHaveLength(2);
    expect(server[0].stack).toBe('TimeoutError: Timeout 300ms exceeded.');
    expect(firstLine(server[1])).toBe(server[0].stack);
    expect(framesOf(server[1])).toBeGreaterThan(1);
  });

  test('a call without a timeout prepares no error of its own', async ({ page }) => {
    await page.setContent('<title>untimed</title>');
    const before = state.counters.lightTimeouts;
    expect(await page.title()).toBe('untimed');
    // The instrumentation before and after it.
    expect(state.counters.lightTimeouts - before).toBe(2);
  });

  test("an error a call makes as it starts keeps the server's frames", async ({ page }) => {
    await page.setContent('<p>selector</p>');
    const before = state.counters.lightTimeouts;
    const [error] = await serverErrors(page, () => page.locator('css=[').click({ timeout: 1000, force: true }));
    expect(state.counters.lightTimeouts - before).toBe(3);
    expect(error.stack).toContain('Unexpected token');
    expect(framesOf(error)).toBeGreaterThan(1);
    expect(Error.stackTraceLimit).toBeGreaterThan(1);
  });

  test('a command the browser refuses fails with the same error, the server keeping one frame', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', "The commands of a CDP session are Chromium's.");
    await page.setContent('<p>command</p>');
    expect(state.lightCommands).toBe(true);
    const session = await context.newCDPSession(page);
    const refused: Error[] = [];
    const navigations: Error[] = [];
    const server: ServerError[] = [];
    const sent: number[] = [];
    for (const lightCommands of [true, false]) {
      state.lightCommands = lightCommands;
      const before = state.counters.lightCommands;
      try {
        refused.push(await failure(session.send('Page.noSuchCommand' as 'Page.enable')));
        server.push(
          ...(await serverErrors(page, async () => {
            navigations.push(await failure(page.goto('no-such-scheme-url')));
          })),
        );
      } finally {
        state.lightCommands = true;
      }
      sent.push(state.counters.lightCommands - before);
    }
    expect(sent[0]).toBeGreaterThan(0);
    expect(sent[1]).toBe(0);
    for (const [light, stock] of [refused, navigations]) {
      expect(light.message).toBe(stock.message);
      expect(light.stack).toBe(stock.stack);
      expect(light.stack).toMatch(/stack-traces\.spec\.ts:\d+:\d+/);
    }
    expect(refused[0].message).toContain('Page.noSuchCommand');
    expect(server).toHaveLength(2);
    expect(firstLine(server[0])).toBe('Error: Protocol error (Page.navigate): Cannot navigate to invalid URL');
    expect(firstLine(server[1])).toBe(firstLine(server[0]));
    expect(framesOf(server[0])).toBe(1);
    expect(framesOf(server[1])).toBeGreaterThan(1);
  });
});
