import { describe, test, expect } from 'vitest';
import { createConcurrencyLimit } from '../../server/utils/concurrency-limit';

/**
 * A concurrency limit with a share per client: a client holds at most its
 * share of the places, running or waiting, and gets each back when a call ends,
 * whether it succeeded or failed; a refused call holds none.
 */

/** A call the test finishes by hand. */
function deferred() {
  let finish!: (error?: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = (error) => (error ? reject(error) : resolve('done'));
  });
  return { done, finish };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConcurrencyLimit with a share per client', () => {
  test('refuses a fifth place to one client while another client still gets in', async () => {
    const run = createConcurrencyLimit(2, 32, 4);
    const calls = Array.from({ length: 4 }, () => deferred());
    const held = calls.map((call) => run(() => call.done, 'a'));
    expect(held.every((place) => place !== null)).toBe(true);

    expect(run(() => Promise.resolve('x'), 'a')).toBeNull();
    const other = run(() => Promise.resolve('other'), 'b');
    expect(other).not.toBeNull();

    for (const call of calls) call.finish();
    expect(await Promise.all(held)).toEqual(['done', 'done', 'done', 'done']);
    expect(await other).toBe('other');
  });

  test('gives a place back when a call succeeds, fails or is refused', async () => {
    const run = createConcurrencyLimit(1, 32, 2);
    const first = deferred();
    const second = deferred();
    const succeeding = run(() => first.done, 'a');
    const failing = run(() => second.done, 'a');
    expect(run(() => Promise.resolve('x'), 'a')).toBeNull();

    first.finish();
    await succeeding;
    const third = deferred();
    const afterSuccess = run(() => third.done, 'a');
    expect(afterSuccess).not.toBeNull();
    expect(run(() => Promise.resolve('x'), 'a')).toBeNull();

    second.finish(new Error('out of memory'));
    await expect(failing).rejects.toThrow('out of memory');
    const afterFailure = run(() => Promise.resolve('after failure'), 'a');
    expect(afterFailure).not.toBeNull();

    third.finish();
    expect(await afterSuccess).toBe('done');
    expect(await afterFailure).toBe('after failure');
    await settle();
    // Every place is back: the refused calls took none.
    const again = [deferred(), deferred()];
    const full = again.map((call) => run(() => call.done, 'a'));
    expect(full.every((place) => place !== null)).toBe(true);
    for (const call of again) call.finish();
    await Promise.all(full);
  });

  test('a call that throws before it returns a promise gives its place back', async () => {
    const run = createConcurrencyLimit(2, 0, 1);
    await expect(
      run(() => {
        throw new Error('bad input');
      }, 'a'),
    ).rejects.toThrow('bad input');
    expect(await run(() => Promise.resolve('ok'), 'a')).toBe('ok');
  });

  test('a call made for no client counts against no share', async () => {
    const run = createConcurrencyLimit(2, 32, 1);
    const calls = Array.from({ length: 6 }, () => deferred());
    const held = calls.map((call) => run(() => call.done));
    expect(held.every((place) => place !== null)).toBe(true);
    expect(run(() => Promise.resolve('a'), 'a')).not.toBeNull();
    for (const call of calls) call.finish();
    await Promise.all(held);
  });

  test('the queue bound still refuses a client within its share', async () => {
    const run = createConcurrencyLimit(1, 1, 4);
    const calls = [deferred(), deferred()];
    const held = [run(() => calls[0]!.done, 'a'), run(() => calls[1]!.done, 'b')];
    expect(run(() => Promise.resolve('c'), 'c')).toBeNull();
    for (const call of calls) call.finish();
    await Promise.all(held);
    // The refused call held nothing, so its client may take its share.
    expect(await run(() => Promise.resolve('c'), 'c')).toBe('c');
  });
});
