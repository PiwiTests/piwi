import { describe, expect, it } from 'vitest';
import type { ReelEntry } from '#shared/video-reel';
import { searchReelEntries } from '../../app/utils/video-reel-search';

function entry(executionId: number, title: string, filePath = 'tests/checkout.spec.ts'): ReelEntry {
  return {
    execution: {
      executionId,
      testCaseId: executionId,
      title,
      filePath,
      line: 1,
      column: 1,
      status: 'passed',
      retries: 0,
      repeatEachIndex: 0,
      browserName: null,
      passedAfterFailure: false,
      shardIndex: null,
      parallelIndex: 0,
      workerIndex: 0,
      startedAt: null,
      durationMs: 1000,
      createPageEndMs: null,
      video: null,
    },
    laneLabel: 'Worker 1',
    lengthMs: 0,
    reelStartMs: 0,
  };
}

const ENTRIES = [
  entry(11, 'opens the cart'),
  entry(12, 'fills the card'),
  entry(13, 'adds a crème brûlée to the CART'),
  entry(14, 'places the order', 'tests/cart.spec.ts'),
];
const indices = (query: string) => searchReelEntries(ENTRIES, query).rows.map((row) => row.index);

describe('searchReelEntries', () => {
  it('keeps every row, in order, with no highlight while the search is empty', () => {
    const result = searchReelEntries(ENTRIES, '   ');
    expect(result.rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(result.highlights).toBeNull();
  });

  it('keeps the rows whose title holds the words, with their index in the reel', () => {
    const result = searchReelEntries(ENTRIES, 'cart');
    expect(result.rows.map((row) => [row.index, row.entry.execution.executionId])).toEqual([
      [0, 11],
      [2, 13],
    ]);
    expect(result.highlights?.title).toEqual(['cart']);
  });

  it('folds case and accents', () => {
    expect(indices('CREME BRULEE')).toEqual([2]);
    expect(indices('crème')).toEqual([2]);
  });

  it('looks in the title alone, not the file', () => {
    // The fourth test's file is cart.spec.ts, but its title does not say cart.
    expect(indices('cart')).not.toContain(3);
    expect(indices('file:cart')).toEqual([]);
  });

  it('reads the Tests tab language: phrases, wildcards and exclusions', () => {
    expect(indices('"the card"')).toEqual([1]);
    expect(indices('pl*order')).toEqual([3]);
    expect(indices('the -cart')).toEqual([1, 3]);
  });

  it('keeps no row when nothing matches', () => {
    expect(indices('zzz')).toEqual([]);
  });
});
