/**
 * The test filters analytics resolved in the last seconds, so the widgets of
 * one dashboard page, each asked for in its own request, resolve a filter
 * once. Kept per database, selection key, inline predicates, browsers and
 * allowed projects, for `TEST_FILTER_MEMO_TTL_MS`. A finished, deleted or
 * incident-flagged run, a change to a selection or to a quarantine, and a
 * merge of two tests drop the filters that read their project.
 */
import { TtlCache } from '../../../server/utils/ttl-cache';
import type { AnalyticsScope } from '../../analytics/scope';
import type { ResolvedTestFilter } from './common';

export const TEST_FILTER_MEMO_TTL_MS = 30_000;

/** A resolved filter and the notes its resolution wrote. */
export interface MemoizedTestFilter {
  filter: ResolvedTestFilter | null;
  notes: string[];
}

interface Entry {
  pending: Promise<MemoizedTestFilter>;
  /** The projects the filter read, or every project. */
  projects: 'all' | number[];
}

const memo = new TtlCache<Entry>(TEST_FILTER_MEMO_TTL_MS, 500);

const databaseIds = new WeakMap<object, number>();
let nextDatabaseId = 0;

function databaseId(db: object): number {
  let id = databaseIds.get(db);
  if (id === undefined) {
    id = ++nextDatabaseId;
    databaseIds.set(db, id);
  }
  return id;
}

/** JSON with object keys in a fixed order, so two equal predicate groups give one key. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The memo key of a scope's test filter over the allowed projects (after project access, filter and tags). */
export function testFilterKey(db: object, scope: AnalyticsScope, allowed: 'all' | number[]): string {
  return stableJson({
    db: databaseId(db),
    selection: scope.selection ?? null,
    tests: scope.tests ?? null,
    browsers: scope.browsers?.length ? scope.browsers : null,
    allowed: allowed === 'all' ? 'all' : [...new Set(allowed)].sort((a, b) => a - b),
  });
}

/**
 * The test filter of `scope` over `allowed`, from the memo when one resolved in
 * the last `TEST_FILTER_MEMO_TTL_MS`, else from `resolve`. Requests arriving
 * while one resolves share it; a resolution that fails is forgotten.
 */
export function memoizedTestFilter(
  db: object,
  scope: AnalyticsScope,
  allowed: 'all' | number[],
  resolve: () => Promise<MemoizedTestFilter>,
): Promise<MemoizedTestFilter> {
  const key = testFilterKey(db, scope, allowed);
  const hit = memo.get(key);
  if (hit) return hit.pending;
  const entry: Entry = { pending: resolve(), projects: allowed === 'all' ? 'all' : [...allowed] };
  memo.set(key, entry);
  entry.pending.catch(() => {
    if (memo.get(key) === entry) memo.delete(key);
  });
  return entry.pending;
}

/** Drop the memoized filters that read a project, after a write that changes what they resolve to. */
export function dropProjectTestFilters(projectId: number): number {
  return memo.deleteWhere((entry) => entry.projects === 'all' || entry.projects.includes(projectId));
}

/** Drop every memoized filter. */
export function clearTestFilterMemo(): void {
  memo.deleteWhere(() => true);
}
