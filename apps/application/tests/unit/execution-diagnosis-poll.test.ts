import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';

/** An execution's diagnosis running elsewhere is read again until it lands. */

const { useExecutionDiagnosis } = await import('../../app/composables/useExecutionDiagnosis');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubNuxt(answers: Array<{ status: string; updatedAt: string } | null>) {
  const calls: string[] = [];
  const unmount: Array<() => void> = [];
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', (fn: () => void) => fn());
  vi.stubGlobal('onBeforeUnmount', (fn: () => void) => unmount.push(fn));
  vi.stubGlobal('useToast', () => ({ add: () => {} }));
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/diagnosis')) return { diagnosis: answers.shift() ?? null };
      return { sections: [], tokenEstimate: 0, coverage: null };
    }),
  );
  return { diagnosisReads: () => calls.filter((u) => u.endsWith('/diagnosis')).length, unmount };
}

describe('useExecutionDiagnosis', () => {
  test('polls a running diagnosis until it completes, and exposes the read for Refresh', async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const nuxt = stubNuxt([
      { status: 'running', updatedAt: now },
      { status: 'running', updatedAt: now },
      { status: 'completed', updatedAt: now },
    ]);
    const store = useExecutionDiagnosis(7);
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    expect(store.diagnosis.value?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await nextTick();
    expect(store.diagnosis.value?.status).toBe('completed');
    expect(nuxt.diagnosisReads()).toBe(3);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(nuxt.diagnosisReads()).toBe(3);

    await store.fetchDiagnosis();
    expect(nuxt.diagnosisReads()).toBe(4);
  });

  test('stops polling when the page leaves', async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const nuxt = stubNuxt(Array.from({ length: 10 }, () => ({ status: 'running', updatedAt: now })));
    useExecutionDiagnosis(7);
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    for (const fn of nuxt.unmount) fn();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(nuxt.diagnosisReads()).toBe(1);
  });
});
