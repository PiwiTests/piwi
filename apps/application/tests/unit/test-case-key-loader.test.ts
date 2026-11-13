import { describe, expect, test, vi } from 'vitest';
import { reactive } from 'vue';
import {
  createTestCaseKeyLoader,
  type CatalogCasesResponse,
  type TestCaseKeyState,
} from '../../app/utils/test-case-key-loader';

const answer = (cases: CatalogCasesResponse['cases'], fetchedAt: string | null = '2026-11-09T10:00:00.000Z') => ({
  fetchedAt,
  cases,
});

function setup(fetchCases: (keys: string[]) => Promise<CatalogCasesResponse>) {
  const states = reactive<Record<string, TestCaseKeyState>>({});
  const queue: Array<() => void> = [];
  const loader = createTestCaseKeyLoader({ states, fetchCases, schedule: (fn) => void queue.push(fn) });
  const tick = async () => {
    for (const fn of queue.splice(0)) fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { states, loader, tick, queue };
}

describe('createTestCaseKeyLoader', () => {
  test('asks for nothing until a key is loaded', async () => {
    const fetchCases = vi.fn();
    const { queue, states } = setup(fetchCases);
    expect(queue).toEqual([]);
    expect(states).toEqual({});
    expect(fetchCases).not.toHaveBeenCalled();
  });

  test('sends the keys asked for in one tick as one request, and each key once', async () => {
    const fetchCases = vi.fn(async () =>
      answer({ 'SHOP-T1': { name: 'Login', status: 'Approved', url: null }, 'SHOP-T2': null }),
    );
    const { loader, states, tick } = setup(fetchCases);
    loader.load('SHOP-T1');
    loader.load('SHOP-T2');
    loader.load('SHOP-T1');
    expect(states['SHOP-T1']).toEqual({ status: 'loading' });
    await tick();
    expect(fetchCases).toHaveBeenCalledTimes(1);
    expect(fetchCases).toHaveBeenCalledWith(['SHOP-T1', 'SHOP-T2']);
    expect(states['SHOP-T1']).toEqual({
      status: 'ready',
      testCase: { name: 'Login', status: 'Approved', url: null },
      fetchedAt: '2026-11-09T10:00:00.000Z',
    });
    expect(states['SHOP-T2']).toMatchObject({ status: 'ready', testCase: null });

    loader.load('SHOP-T1'); // cached: no second request
    await tick();
    expect(fetchCases).toHaveBeenCalledTimes(1);
  });

  test('splits more than a hundred keys into requests of a hundred', async () => {
    const fetchCases = vi.fn(async (_keys: string[]) => answer({}));
    const { loader, tick } = setup(fetchCases);
    for (let i = 0; i < 130; i++) loader.load(`SHOP-T${i}`);
    await tick();
    await tick();
    expect(fetchCases.mock.calls.map(([keys]) => keys.length)).toEqual([100, 30]);
  });

  test('a failed request leaves an error that the next open retries', async () => {
    const fetchCases = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(answer({}));
    const { loader, states, tick } = setup(fetchCases);
    loader.load('SHOP-T1');
    await tick();
    expect(states['SHOP-T1']).toEqual({ status: 'error' });
    loader.load('SHOP-T1');
    await tick();
    expect(states['SHOP-T1']).toMatchObject({ status: 'ready', testCase: null });
    expect(fetchCases).toHaveBeenCalledTimes(2);
  });

  test('a key the catalog could not hold is never sent', async () => {
    const fetchCases = vi.fn(async () => answer({}));
    const { loader, states, tick } = setup(fetchCases);
    loader.load('not a key!');
    await tick();
    expect(states['not a key!']).toEqual({ status: 'error' });
    expect(fetchCases).not.toHaveBeenCalled();
  });

  test('keeps a catalog that was never read apart from an unknown key', async () => {
    const { loader, states, tick } = setup(async () => answer({ 'SHOP-T1': null }, null));
    loader.load('SHOP-T1');
    await tick();
    expect(states['SHOP-T1']).toEqual({ status: 'ready', testCase: null, fetchedAt: null });
  });

  test('reset drops an answer still on its way and the keys still queued', async () => {
    let resolve: (value: CatalogCasesResponse) => void = () => {};
    const fetchCases = vi.fn(() => new Promise<CatalogCasesResponse>((r) => (resolve = r)));
    const { loader, states, tick } = setup(fetchCases);
    loader.load('SHOP-T1');
    await tick();
    expect(fetchCases).toHaveBeenCalledTimes(1);
    loader.load('SHOP-T2'); // queued, not yet sent
    loader.reset();
    for (const key of Object.keys(states)) delete states[key];

    resolve(answer({ 'SHOP-T1': { name: 'Login', status: null, url: null } }));
    await tick();
    expect(states).toEqual({});
    expect(fetchCases).toHaveBeenCalledTimes(1);

    loader.load('SHOP-T1'); // asked for again after the reset
    await tick();
    expect(fetchCases).toHaveBeenCalledTimes(2);
  });

  test('reset drops the failure of a request that was on its way', async () => {
    let reject: (reason: unknown) => void = () => {};
    const fetchCases = vi.fn(() => new Promise<CatalogCasesResponse>((_, r) => (reject = r)));
    const { loader, states, tick } = setup(fetchCases);
    loader.load('SHOP-T1');
    await tick();
    loader.reset();
    delete states['SHOP-T1'];
    reject(new Error('gone'));
    await tick();
    expect(states).toEqual({});
  });
});
