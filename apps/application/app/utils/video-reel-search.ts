import type { ReelEntry } from '#shared/video-reel';
import {
  compileTestSearch,
  parseTestSearch,
  testSearchHighlights,
  type TestSearchField,
  type TestSearchHighlights,
  type TestSearchSubject,
} from '#shared/test-search';

/** What the Video tab's checklist search looks in: the test's title, in the Tests tab's search language. */
export const REEL_SEARCH_FIELDS: readonly TestSearchField[] = ['title'];

/** What the search reads from a checklist entry. */
export function reelSearchSubject(entry: ReelEntry): TestSearchSubject {
  return { title: entry.execution.title };
}

export interface ReelSearch {
  /** The entries that match, each with its index in the reel, which the player, the ticks and the bar are keyed by. */
  rows: { entry: ReelEntry; index: number }[];
  /** The parts of a title to mark; null while nothing is searched. */
  highlights: TestSearchHighlights | null;
}

/** The checklist rows a search keeps, in the reel's order; every row while the search is empty. */
export function searchReelEntries(entries: readonly ReelEntry[], query: string): ReelSearch {
  const rows = entries.map((entry, index) => ({ entry, index }));
  const parsed = parseTestSearch(query, REEL_SEARCH_FIELDS);
  if (parsed.terms.length === 0) return { rows, highlights: null };
  const matches = compileTestSearch(parsed);
  return {
    rows: rows.filter(({ entry }) => matches(reelSearchSubject(entry))),
    highlights: testSearchHighlights(parsed),
  };
}

/**
 * The line over a searched checklist: how many tests match of how many are listed, the noun following the count listed
 * and the verb the count matching (`1 of 11 tests matches`, `2 of 11 tests match`, `1 of 1 test matches`).
 */
export function reelSearchCount(matched: number, total: number): string {
  return `${matched} of ${total} ${total === 1 ? 'test' : 'tests'} ${matched === 1 ? 'matches' : 'match'}`;
}
