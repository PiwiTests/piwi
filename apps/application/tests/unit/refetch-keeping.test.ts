import { describe, expect, test } from 'vitest';
import { isFinalRefetch, refetchFailure, refetchKeeping } from '../../app/utils/refetch-keeping';

/** A read the test answers or fails by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('refetchKeeping', () => {
  test('shows what a read answers', async () => {
    const shown = { value: { status: 'running' } };
    const reload = refetchKeeping(shown, async () => ({ status: 'passed' }));
    await expect(reload()).resolves.toBe('answered');
    expect(shown.value).toEqual({ status: 'passed' });
  });

  test('keeps what the page shows when a read fails, and says it failed', async () => {
    const run = { status: 'running' };
    const shown = { value: run };
    const reload = refetchKeeping(shown, () => Promise.reject(new Error('502 Bad Gateway')));
    await expect(reload()).resolves.toBe('failed');
    expect(shown.value).toBe(run);
  });

  test('drops an answer that comes after the answer of a later read', async () => {
    const shown = { value: 'loaded' };
    const reads = [deferred<string>(), deferred<string>()];
    let next = 0;
    const reload = refetchKeeping(shown, () => reads[next++]!.promise);
    const first = reload();
    const second = reload();
    reads[1]!.resolve('newer');
    await second;
    reads[0]!.resolve('older');
    await expect(first).resolves.toBe('answered');
    expect(shown.value).toBe('newer');
  });

  test('shows an earlier read’s answer when the later read fails', async () => {
    const shown = { value: 'loaded' };
    const reads = [deferred<string>(), deferred<string>()];
    let next = 0;
    const reload = refetchKeeping(shown, () => reads[next++]!.promise);
    const first = reload();
    const second = reload();
    reads[1]!.reject(new Error('502 Bad Gateway'));
    await expect(second).resolves.toBe('failed');
    reads[0]!.resolve('older');
    await first;
    expect(shown.value).toBe('older');
  });

  test('says why a read failed, by the status of its error answer, and keeps what the page shows', async () => {
    /** An error as `$fetch` throws it for an error answer. */
    const answer = (status: number) => Object.assign(new Error(`${status}`), { status, statusCode: status });
    const cases = [
      [answer(404), 'gone'],
      [answer(410), 'gone'],
      [answer(401), 'signed-out'],
      [answer(403), 'forbidden'],
      [answer(502), 'failed'],
      [answer(503), 'failed'],
      [answer(429), 'failed'],
      // No answer came: the network failed, or the request timed out.
      [new TypeError('fetch failed'), 'failed'],
    ] as const;
    for (const [error, failure] of cases) {
      const run = { status: 'running' };
      const shown = { value: run };
      const reload = refetchKeeping(shown, () => Promise.reject(error));
      await expect(reload(), error.message).resolves.toBe(failure);
      expect(shown.value).toBe(run);
    }
  });

  test('reads the status of a Nuxt error, which carries only its `statusCode`', () => {
    expect(refetchFailure({ statusCode: 404 })).toBe('gone');
    expect(refetchFailure(undefined)).toBe('failed');
  });

  test('a failure is final when the data is gone or the viewer cannot read it, never when the instance did not answer', () => {
    expect(isFinalRefetch('gone')).toBe(true);
    expect(isFinalRefetch('signed-out')).toBe(true);
    expect(isFinalRefetch('forbidden')).toBe(true);
    expect(isFinalRefetch('failed')).toBe(false);
    expect(isFinalRefetch('answered')).toBe(false);
  });
});
