import { describe, expect, test } from 'vitest';
import { liveCaseKey } from '../../app/utils/test-attempts';

/** A test as the live run page meets it: streamed, or loaded from the database. */
const test1 = { title: 'adds to cart', location: 'cart.spec.ts:12:3', repeatEachIndex: 0 };

describe('liveCaseKey', () => {
  test('matches a streamed attempt with its stored row, whatever order the browser JSON keys come in', () => {
    // PostgreSQL's jsonb stores an object's keys in its own order, unlike the reporter's.
    const streamed = { ...test1, browser: { projectName: 'chromium', browserName: 'chromium', viewport: null } };
    const stored = { ...test1, browser: { viewport: null, browserName: 'chromium', projectName: 'chromium' } };
    expect(liveCaseKey(stored as never)).toBe(liveCaseKey(streamed as never));
  });

  test('tells the Playwright projects and the repetitions of a test apart', () => {
    const chromium = liveCaseKey({ ...test1, browser: { projectName: 'chromium' } } as never);
    expect(liveCaseKey({ ...test1, browser: { projectName: 'firefox' } } as never)).not.toBe(chromium);
    expect(liveCaseKey({ ...test1, repeatEachIndex: 1, browser: { projectName: 'chromium' } } as never)).not.toBe(
      chromium,
    );
  });
});
