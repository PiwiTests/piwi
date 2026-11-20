import { readFileSync } from 'node:fs';
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
});
