import { describe, expect, test } from 'vitest';
import {
  isFinalRefetch,
  refetchFailure,
  refetchKeeping,
  refetchReason,
  settleInOrder,
} from '../../app/utils/refetch-keeping';

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

/** An error as `$fetch` throws it for Piwi's own JSON error answer. */
function piwiAnswer(status: number, message = `Piwi answered ${status}`) {
  return Object.assign(new Error(`${status}`), { status, statusCode: status, data: { statusCode: status, message } });
}

/** An error as `$fetch` throws it for a proxy's own error page in front of Piwi. */
function proxyAnswer(status: number) {
  return Object.assign(new Error(`${status}`), {
    status,
    statusCode: status,
    data: `<html><body><h1>${status}</h1>nginx</body></html>`,
  });
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
    const cases = [
      [piwiAnswer(404), 'gone'],
      [piwiAnswer(410), 'gone'],
      [piwiAnswer(401), 'signed-out'],
      [piwiAnswer(403), 'forbidden'],
      [piwiAnswer(500), 'failed'],
      [piwiAnswer(429), 'failed'],
      [proxyAnswer(502), 'failed'],
      [proxyAnswer(503), 'failed'],
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

  test('a 404, 401 or 403 from a proxy in front of Piwi (its own page, not Piwi’s JSON error) is no final failure', () => {
    for (const status of [404, 410, 401, 403]) {
      expect(refetchFailure(proxyAnswer(status)), String(status)).toBe('failed');
      // A body without Piwi's fields is a proxy's too.
      expect(refetchFailure(Object.assign(new Error(), { status, data: { error: 'Not Found' } }))).toBe('failed');
      expect(refetchFailure(Object.assign(new Error(), { status }))).toBe('failed');
    }
    // A Nuxt error carries its status as `statusCode`, and Piwi's body as `data`.
    expect(refetchFailure({ statusCode: 404, data: { statusCode: 404, message: 'Test run not found' } })).toBe('gone');
    expect(refetchFailure({ statusCode: 404 })).toBe('failed');
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

describe('refetchReason', () => {
  test('says Piwi’s message, else the status the answer carried, else nothing', () => {
    expect(refetchReason(piwiAnswer(500, 'Database is locked'))).toBe('Database is locked.');
    expect(refetchReason(piwiAnswer(400, 'Invalid run id.'))).toBe('Invalid run id.');
    expect(refetchReason(proxyAnswer(502))).toBe('The instance answered with HTTP 502.');
    expect(refetchReason(new TypeError('fetch failed'))).toBeNull();
  });
});

describe('settleInOrder', () => {
  test('settles each result in the order its read started: an older result coming late is not settled', async () => {
    const reads = [deferred<string>(), deferred<string>()];
    let next = 0;
    const settled: string[] = [];
    const reload = settleInOrder(
      () => reads[next++]!.promise,
      (result) => settled.push(result),
    );
    const older = reload();
    const newer = reload();
    reads[1]!.resolve('answered');
    await newer;
    reads[0]!.resolve('gone');
    // Each call still resolves to its own read's result.
    await expect(older).resolves.toBe('gone');
    expect(settled).toEqual(['answered']);
  });

  test('settles every result that comes in order', async () => {
    const settled: string[] = [];
    const results = ['gone', 'answered'];
    const reload = settleInOrder(
      async () => results.shift()!,
      (result) => settled.push(result),
    );
    await reload();
    await reload();
    expect(settled).toEqual(['gone', 'answered']);
  });
});
