import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, ref, toValue } from 'vue';
import type { TestCaseResult } from '../../types/api';
import { isFailedStatus } from '#shared/utils/test-counts';
import { statusPaletteKey } from '../../app/utils/status-palette';

/** The composable with its Nuxt auto-imports in place; a fresh import per case. */
async function retryCommandOf(rows: Partial<TestCaseResult>[], cookie?: unknown) {
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('toValue', toValue);
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
  vi.stubGlobal('useCopy', () => ({ copy: () => {}, copied: ref(false) }));
  vi.stubGlobal('copyPreview', (text: string) => text);
  vi.stubGlobal('isFailedStatus', isFailedStatus);
  vi.stubGlobal('statusPaletteKey', statusPaletteKey);
  vi.stubGlobal('useCookie', () => ref(cookie));
  const { useRetryOptions } = await import('../../app/composables/useRetryOptions');
  vi.stubGlobal('useRetryOptions', useRetryOptions);
  const { useRunRetryCommand } = await import('../../app/composables/useRunRetryCommand');
  return useRunRetryCommand(rows as TestCaseResult[]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** An execution of `checkout.spec.ts:12 › pays` on chromium. */
const pays = (repeatEachIndex: number, retries: number, status: string): Partial<TestCaseResult> => ({
  testCaseId: 1,
  title: 'pays',
  filePath: 'checkout.spec.ts',
  location: 'checkout.spec.ts:12',
  browser: { projectName: 'chromium' },
  repeatEachIndex,
  retries,
  status,
});

describe('the run page retry command under --repeat-each', () => {
  test('re-runs a test whose later repetition failed', async () => {
    const { failedCases, command } = await retryCommandOf([
      pays(0, 0, 'passed'),
      pays(1, 0, 'passed'),
      pays(2, 0, 'failed'),
    ]);

    expect(failedCases.value).toHaveLength(1);
    expect(command.value).toBe('npx playwright test "checkout.spec.ts:12" --project="chromium"');
  });

  test('names a test once however many of its repetitions failed', async () => {
    const { failedCases, allCases } = await retryCommandOf([
      pays(0, 0, 'failed'),
      pays(1, 0, 'passed'),
      pays(2, 0, 'timedout'),
    ]);

    expect(failedCases.value).toHaveLength(1);
    expect(allCases.value).toHaveLength(1);
  });

  test('judges each repetition on its own retries', async () => {
    const { failedCases, flakyCases } = await retryCommandOf([
      pays(0, 0, 'failed'),
      pays(0, 1, 'passed'),
      pays(1, 0, 'failed'),
      pays(1, 1, 'failed'),
    ]);

    expect(failedCases.value).toHaveLength(1);
    expect(flakyCases.value).toHaveLength(1);
  });

  test('leaves out a repetition that passed on its retry', async () => {
    const { failedCases, flakyCases } = await retryCommandOf([pays(0, 0, 'failed'), pays(0, 1, 'passed')]);

    expect(failedCases.value).toEqual([]);
    expect(flakyCases.value).toHaveLength(1);
  });
});

describe('the run options it carries', () => {
  test('the remembered options follow the command', async () => {
    const { command } = await retryCommandOf([pays(0, 0, 'failed')], { headed: true, repeatEach: 3, mode: 'grep' });
    expect(command.value).toBe('npx playwright test --grep "pays" --project="chromium" --headed --repeat-each=3');
  });

  test('a remembered value out of bounds reads as its default', async () => {
    const { command } = await retryCommandOf([pays(0, 0, 'failed')], { repeatEach: 50, workers: 9 });
    expect(command.value).toBe('npx playwright test "checkout.spec.ts:12" --project="chromium"');
  });
});
