import { describe, expect, test } from 'vitest';
import { diagnosisImageOrder, inTurns, takeInTurns } from '../../app/utils/diagnosis-screenshots';

/** A test's attachments in attachment order: ten step screenshots, then Playwright's at the failure. */
const steps = Array.from({ length: 10 }, (_, i) => ({ name: `Step ${i + 1}: Open alerts` }));
const withPlaywrightShot = [...steps, { name: 'screenshot' }];
const name = (image: { name: string }) => image.name;

describe('diagnosisImageOrder', () => {
  test('puts the newest first, so the screenshot Playwright took at the failure leads', () => {
    const ordered = diagnosisImageOrder(withPlaywrightShot, name);
    expect(ordered.slice(0, 3).map(name)).toEqual(['screenshot', 'Step 10: Open alerts', 'Step 9: Open alerts']);
  });

  test("puts the capture fixtures' screenshot of the failing page first", () => {
    const ordered = diagnosisImageOrder(
      [...steps.slice(0, 3), { name: 'piwi-failure-screenshot' }, ...steps.slice(3)],
      name,
    );
    expect(ordered[0]).toEqual({ name: 'piwi-failure-screenshot' });
    expect(ordered[1]).toEqual({ name: 'Step 10: Open alerts' });
  });
});

describe('inTurns', () => {
  test("takes each list's first before any list's second", () => {
    expect(inTurns([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  test('keeps every item, so a test with many screenshots leaves the first slots to the others', () => {
    const many = Array.from({ length: 11 }, (_, i) => `a${i + 1}`);
    expect(inTurns([many, ['b1', 'b2']]).slice(0, 4)).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(inTurns([many, ['b1', 'b2']])).toHaveLength(13);
    expect(inTurns([])).toEqual([]);
  });
});

describe('takeInTurns', () => {
  /** Fifty affected tests, each with three screenshots. */
  const tests = Array.from({ length: 50 }, (_, i) => `t${i + 1}`);
  const shots = (t: string) => [`${t}-1`, `${t}-2`, `${t}-3`];

  test('reads only the first batch when its first images fill the slots', async () => {
    const read: string[] = [];
    const taken: string[] = [];
    const filled = await takeInTurns(
      tests,
      async (t) => (read.push(t), shots(t)),
      async (item) => (taken.push(item), true),
      8,
    );
    expect(filled).toBe(8);
    expect(read).toEqual(tests.slice(0, 8));
    expect(taken).toEqual(tests.slice(0, 8).map((t) => `${t}-1`));
  });

  test('reads the next batch only while slots are left', async () => {
    const read: string[] = [];
    // The first ten tests have no screenshot.
    const list = async (t: string) => (read.push(t), tests.indexOf(t) < 10 ? [] : shots(t));
    const taken: string[] = [];
    await takeInTurns(tests, list, async (item) => (taken.push(item), true), 8);
    expect(read).toEqual(tests.slice(0, 24));
    expect(taken).toEqual(tests.slice(10, 18).map((t) => `${t}-1`));
  });

  test("keeps the order of inTurns: every test's first image before any test's second", async () => {
    const lists: Record<string, string[]> = { a: ['a1', 'a2', 'a3'], b: ['b1'], c: ['c1', 'c2'] };
    const taken: string[] = [];
    await takeInTurns(
      ['a', 'b', 'c'],
      async (t) => lists[t]!,
      async (item) => (taken.push(item), true),
      5,
      2,
    );
    expect(taken).toEqual(inTurns(Object.values(lists)).slice(0, 5));
  });

  test('leaves a slot open when a download fails, for the next image in turn', async () => {
    const taken: string[] = [];
    const filled = await takeInTurns(
      ['a', 'b'],
      async (t) => shots(t),
      async (item) => item !== 'a-1' && (taken.push(item), true),
      3,
    );
    expect(filled).toBe(3);
    expect(taken).toEqual(['b-1', 'a-2', 'b-2']);
  });

  test('reads one source at a time for a batch below one', async () => {
    const read: string[] = [];
    const filled = await takeInTurns(
      ['a', 'b'],
      async (t) => (read.push(t), shots(t)),
      async () => true,
      1,
      0,
    );
    expect(filled).toBe(1);
    expect(read).toEqual(['a']);
  });
});
