import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Green belongs to the page's one primary action.
 *
 * On the failure pages the evidence card and the affected tests state facts and
 * selections: a failure in the status palette's rose, a duration that stands out
 * in the one tone of `app/utils/duration-tone.ts`, a selected tab or row in the
 * neutral classes of `app/utils/index.ts` (`SELECTED_TAB_CLASS`,
 * `SEGMENTED_SELECTED_CLASS`, `SELECTED_ROW_CLASS`). This scan keeps the
 * components that draw them free of the raw Tailwind reds, oranges and greens
 * that bypass the palette, and of any primary-colored class outside a hover or a
 * focus ring. The E2E `tests/failure-page-accent.spec.ts` checks the same rule
 * on the rendered pages.
 */

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The components of the evidence card and of the cluster page's affected tests. */
const FILES = [
  'app/components/test-case/EvidenceTabs.vue',
  'app/components/test-case/FailureTimelineCard.vue',
  'app/components/test-case/TimelineTypeFilter.vue',
  'app/components/test-case/TimelineDuration.vue',
  'app/components/test-case/StepStatusMark.vue',
  'app/components/test-case/StepParams.vue',
  'app/components/test-case/FailingStepSnapshot.vue',
  'app/components/test-case/AttemptsCard.vue',
  'app/components/test-case/TestCaseNetworkRequests.vue',
  'app/components/test-case/TraceNetworkList.vue',
  'app/components/test-case/TestCasePerformancePanel.vue',
  'app/components/test-case/ExecutionCoverageSection.vue',
  'app/components/test-case/CoverageFileSource.vue',
  'app/components/test-case/CoverageDivergencePart.vue',
  'app/components/test-case/CoverageDivergenceSource.vue',
  'app/components/shared/CoverageSourceView.vue',
  'app/components/cluster/ClusterAffectedTests.vue',
  'app/components/shared/TestRow.vue',
];

/** A raw red, orange or green shade, under any variant (`dark:`, `hover:`…). */
const RAW_SHADE_RE = /(?<![\w-])(?:[\w-]+:)*(?:text|bg|fill|stroke|border|ring)-(?:red|orange|green)-\d+(?:\/\d+)?/g;

/** A primary-colored class with its variant prefix (`hover:`, `focus-visible:`…) in group 1. */
const PRIMARY_RE = /(?<![\w-])((?:[\w-]+:)*)(?:text|bg|fill|stroke|border|ring)-primary(?:-\d+)?(?:\/\d+)?(?![\w-])/g;

/** The variants under which the primary color is a hover or a focus ring, not a state. */
const ALLOWED_PRIMARY_VARIANTS = ['hover:', 'focus-visible:'];

function read(file: string): string {
  return readFileSync(join(APP_ROOT, file), 'utf8');
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('the evidence card and the affected tests keep green to the primary action', () => {
  test.each(FILES)('%s uses no raw red, orange or green shade', (file) => {
    const source = read(file);
    const hits = [...source.matchAll(RAW_SHADE_RE)].map((m) => `${file}:${lineOf(source, m.index!)} ${m[0]}`);
    expect(hits, 'take the color from STATUS_PALETTE or app/utils/duration-tone.ts').toEqual([]);
  });

  test.each(FILES)('%s uses the primary color only on hover and focus', (file) => {
    const source = read(file);
    const hits = [...source.matchAll(PRIMARY_RE)]
      .filter((m) => !ALLOWED_PRIMARY_VARIANTS.some((variant) => m[1]!.includes(variant)))
      .map((m) => `${file}:${lineOf(source, m.index!)} ${m[0]}`);
    expect(hits, 'mark a selection with the neutral classes of app/utils/index.ts').toEqual([]);
  });

  test('the patterns catch what they are meant to', () => {
    const shades = (s: string) => [...s.matchAll(RAW_SHADE_RE)].map((m) => m[0]);
    expect(shades('text-red-600 dark:bg-green-500/10 hover:border-orange-300')).toEqual([
      'text-red-600',
      'dark:bg-green-500/10',
      'hover:border-orange-300',
    ]);
    expect(shades('text-rose-700 bg-emerald-100 text-amber-600 border-redish-1')).toEqual([]);

    const primary = (s: string) =>
      [...s.matchAll(PRIMARY_RE)]
        .filter((m) => !ALLOWED_PRIMARY_VARIANTS.some((variant) => m[1]!.includes(variant)))
        .map((m) => m[0]);
    expect(primary('bg-primary/5 ring-primary/40 text-primary dark:text-primary-400')).toEqual([
      'bg-primary/5',
      'ring-primary/40',
      'text-primary',
      'dark:text-primary-400',
    ]);
    expect(primary('hover:text-primary focus-visible:ring-primary dark:hover:bg-primary/10 accent-primary')).toEqual(
      [],
    );
  });
});
