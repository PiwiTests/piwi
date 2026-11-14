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
