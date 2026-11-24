import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, effectScope, onScopeDispose, ref, shallowRef } from 'vue';

// What Nuxt auto-imports into the composable.
vi.stubGlobal('ref', ref);
vi.stubGlobal('shallowRef', shallowRef);
vi.stubGlobal('computed', computed);
vi.stubGlobal('onScopeDispose', onScopeDispose);
vi.stubGlobal('errorMessage', (e: unknown) => String(e));
vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });

const request = (state: string) => ({
  id: 'r1',
  state,
  outcome: state === 'ended' ? 'stopped' : null,
  detail: null,
  target: { deviceName: 'Laptop' },
  tests: [{ title: 'pays' }],
  createdAt: new Date().toISOString(),
  runId: 7,
});

afterEach(() => vi.useRealTimers());

describe('useRunFollowUp', () => {
  test('keeps reading a request whose Stop answered while a read was out', async () => {
    vi.useFakeTimers();
    const pending: { url: string; resolve: (v: unknown) => void }[] = [];
    vi.stubGlobal('$fetch', (url: string) => new Promise((resolve) => pending.push({ url, resolve })));
    const { useRunFollowUp } = await import('~/composables/useRunFollowUp');
    const scope = effectScope();
    const followUp = scope.run(() => useRunFollowUp())!;
    followUp.follow({ kind: 'request', view: request('running') as never });

    await vi.advanceTimersByTimeAsync(2000);
    const read = pending.shift()!;
    expect(read.url).toBe('/api/run-requests/r1');

    // Stop answers before the read does.
    const stopping = followUp.stop();
    pending.shift()!.resolve(request('stopping'));
    await stopping;
    read.resolve(request('running'));
    await vi.advanceTimersByTimeAsync(0);

    // The request is read again, and its end is shown.
    await vi.advanceTimersByTimeAsync(2000);
    expect(pending.map((p) => p.url)).toEqual(['/api/run-requests/r1']);
    pending.shift()!.resolve(request('ended'));
    await vi.advanceTimersByTimeAsync(0);
    expect(followUp.view.value?.final).toBe(true);
    scope.stop();
  });
});
