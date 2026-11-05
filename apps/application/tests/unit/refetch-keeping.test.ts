import { describe, expect, test } from 'vitest';
import { refetchKeeping } from '../../app/utils/refetch-keeping';

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
    await expect(reload()).resolves.toBe(true);
    expect(shown.value).toEqual({ status: 'passed' });
  });

  test('keeps what the page shows when a read fails, and says it failed', async () => {
    const run = { status: 'running' };
    const shown = { value: run };
    const reload = refetchKeeping(shown, () => Promise.reject(new Error('502 Bad Gateway')));
    await expect(reload()).resolves.toBe(false);
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
    await expect(first).resolves.toBe(true);
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
    await expect(second).resolves.toBe(false);
    reads[0]!.resolve('older');
    await first;
    expect(shown.value).toBe('older');
  });
});
