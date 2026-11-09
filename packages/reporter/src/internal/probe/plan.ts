/**
 * Probe plan matching (client side). Pure helpers the probe command and the
 * interception layer share: match a running test to its plan item, decide which
 * request to mutate (after the first navigation, the Nth match only), and stamp
 * a probe run so the dashboard never counts it as real.
 */

import type { ProbeFault } from './faults.js';
import { RUN_ORIGIN_METADATA_KEY } from '@piwitests/core/wire';
import { compileGlob, type GlobToken } from '@piwitests/core/glob';

/** One (test, route, fault) pair the server's plan asks this run to apply. */
export interface ProbePlanItem {
  testCaseId: number;
  testTitle: string;
  /** Spec file relative to the project root, POSIX separators. Disambiguates a leaf title shared across files. */
  filePath: string | null;
  /** Describe-block titles from the outermost down, breaking a title tie within one file. */
  suitePath: string[];
  routeKey: string;
  /** A client fault (applied at the Playwright boundary) or a server fault (signed onto the request). */
  fault: ProbeFault | string;
  /** `client` (default) mutates the response; `server` signs an X-Piwi-Probe header. */
  level?: 'client' | 'server';
  /** The dependency a server dependency fault targets. */
  dependency?: string;
  nth: number;
}

export interface ProbePlan {
  budget: number;
  items: ProbePlanItem[];
}

/**
 * The run-metadata stamp that marks a probe run. Merged into the run metadata so
 * the server routes the run to its silent path (no clusters, regression signals,
 * notifications or pull-request feedback). Must match the server's
 * `PROBE_RUN_METADATA_KEY`. The run's origin says `probe` too.
 */
export function probeRunMetadata(base: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, piwiProbe: true, [RUN_ORIGIN_METADATA_KEY]: { kind: 'probe' } };
}

/** Split a route key `METHOD /pattern` into its method and path pattern. */
function parseRouteKey(routeKey: string): { method: string; pattern: string } {
  const space = routeKey.indexOf(' ');
  if (space < 0) return { method: '', pattern: routeKey };
  return { method: routeKey.slice(0, space).toUpperCase(), pattern: routeKey.slice(space + 1) };
}

/** A `:name` of a route pattern: `:id`, `:uuid`, `:param`. */
const ROUTE_PARAM = /:[A-Za-z0-9_]+/y;

/**
 * A route pattern's path as a matcher of the whole path: each `:name` takes one
 * or more characters of one segment (what `[^/]+` takes), any other character
 * itself. `compileGlob` matches in steps that grow with the path's length
 * times the pattern's.
 */
function routePatternMatcher(pattern: string): (path: string) => boolean {
  const path = pattern.split('?')[0] ?? pattern;
  const tokens: GlobToken[] = [];
  for (let i = 0; i < path.length; i++) {
    ROUTE_PARAM.lastIndex = i;
    const param = ROUTE_PARAM.exec(path);
    if (param) {
      tokens.push({ kind: 'one', slash: false }, { kind: 'run', slash: false });
      i += param[0].length - 1;
    } else {
      tokens.push({ kind: 'char', char: path[i]! });
    }
  }
  return compileGlob(tokens);
}

/** True when two describe-block paths are equal element for element. */
function suitePathEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((title, i) => title === b[i]);
}

/**
 * Match a running test to a plan item on file path plus leaf title, so a title
 * shared across specs never matches the wrong file. When several plan items
 * share a file and title, the describe-block path breaks the tie. A plan item
 * with no file path (older servers) falls back to a leaf-title match. Returns
 * the matching item, or null when none matches this test.
 */
export function matchProbeItem(
  plan: ProbePlan,
  test: { filePath?: string | null; title?: string | null; suitePath?: string[] },
): ProbePlanItem | null {
  const byFileTitle = plan.items.filter(
    (item) => item.filePath && test.filePath && item.filePath === test.filePath && item.testTitle === test.title,
  );
  if (byFileTitle.length === 1) return byFileTitle[0]!;
  if (byFileTitle.length > 1) {
    return byFileTitle.find((item) => suitePathEqual(item.suitePath, test.suitePath)) ?? byFileTitle[0]!;
  }
  for (const item of plan.items) {
    if (!item.filePath && item.testTitle && test.title && item.testTitle === test.title) return item;
  }
  return null;
}

/** True when a request's method and path match a plan item's route. */
export function requestMatchesRoute(method: string, url: string, routeKey: string): boolean {
  const { method: rm, pattern } = parseRouteKey(routeKey);
  if (rm && rm !== method.toUpperCase()) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0] ?? url;
  }
  return routePatternMatcher(pattern)(path);
}

/** Mutable per-test probe state: first-navigation flag and per-route match count. */
export interface ProbeState {
  navigated: boolean;
  matches: number;
}

export function createProbeState(): ProbeState {
  return { navigated: false, matches: 0 };
}

/** Record that the first navigation happened; requests before it are never mutated. */
export function markNavigated(state: ProbeState): void {
  state.navigated = true;
}

/**
 * Decide whether this matching request is one to act on: only after the first
 * navigation, and every match (`all`) or only the Nth. Advances the match
 * counter, so an ordinal returns true exactly once per page.
 */
export function shouldAct(state: ProbeState, match: 'all' | number): boolean {
  if (!state.navigated) return false;
  state.matches += 1;
  return match === 'all' || state.matches === Math.max(1, match);
}
