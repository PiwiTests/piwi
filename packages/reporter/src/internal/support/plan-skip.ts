/**
 * Pass reuse through Playwright's `TestRun` (Playwright 1.62 and later). `piwi run --plan` sets `PIWI_PLAN` with
 * `PIWI_PLAN_SKIP=true` and passes Playwright no skip list; the reporter's `preprocess` reads the plan's reused tests
 * from the dashboard and skips each with `testRun.skip`, naming the run whose pass stands in for it. Every reporter of
 * the run shows them as skipped, with that reason; this reporter sends nothing of them, and the dashboard records them
 * as the run's reused results.
 *
 * A test is matched by the line of a Playwright test list the plan names it with (`[project] › file › describe ›
 * title`, its file from Playwright's `rootDir`), read as Playwright reads one, whole: a test the plan does not name
 * exactly runs.
 */
import * as path from 'node:path';
import type { TestCase } from '@playwright/test/reporter';
import { PIWI_PLAN_ENV, PIWI_PLAN_SKIP_ENV, readBool } from '../config/env.js';
import type { DashboardAsk } from './test-run-edits.js';

/** The plan whose reused tests the reporter skips itself, from `PIWI_PLAN` with `PIWI_PLAN_SKIP`; null for none. */
export function planToSkip(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[PIWI_PLAN_ENV];
  if (!raw || !/^\d+$/.test(raw) || readBool(env[PIWI_PLAN_SKIP_ENV]) !== true) return null;
  return Number(raw);
}

/** A test as a Playwright test list names it. */
export interface TestListName {
  project: string | null;
  file: string;
  titles: string[];
}

/** The key two names that name the same test share. */
function nameKey(name: TestListName): string {
  return JSON.stringify([name.project, name.file, ...name.titles]);
}

/**
 * A line of a Playwright test list, read as Playwright reads one: split at `›` (else `>`), each part trimmed, a first
 * part in brackets naming the project, and the file's `:line:column` dropped. Null for a blank, comment or malformed
 * line.
 */
export function parseTestListLine(line: string): TestListName | null {
  const text = line.trim();
  if (!text || text.startsWith('#')) return null;
  const parts = text.split(text.includes('›') ? '›' : '>').map((part) => part.trim());
  let project: string | null = null;
  if (parts[0]!.startsWith('[')) {
    if (!parts[0]!.endsWith(']')) return null;
    project = parts.shift()!.slice(1, -1);
  }
  const file = parts
    .shift()
    ?.replace(/(?::\d+){1,2}$/, '')
    .replace(/\\/g, '/');
  if (!file) return null;
  return { project, file, titles: parts };
}

/** How a test of the run is named in a test list: its project, its file from `rootDir`, its describes and title. */
export function testListName(
  test: TestCase,
  rootDir: string,
  project: string | null,
  suitePath: string[],
): TestListName {
  const file = path.relative(rootDir, test.location.file).split(path.sep).join('/');
  return { project, file, titles: [...suitePath, test.title] };
}

/**
 * The reason each line of a stored plan skips its test, by the line's key: `passed in run #N`, the run of the pass the
 * plan reuses, else the plan's for a line of an answer that names no run beside it. Throws on an answer that is not a
 * plan.
 */
export function planSkipReasons(answer: unknown, planId: number): Map<string, string> {
  const plan = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : null;
  if (!plan || !Array.isArray(plan.skip)) throw new Error(`the answer for plan ${planId} is not a plan`);
  const reasons = new Map<string, string>();
  const add = (line: unknown, reason: string) => {
    const name = typeof line === 'string' ? parseTestListLine(line) : null;
    if (name && !reasons.has(nameKey(name))) reasons.set(nameKey(name), reason);
  };
  for (const entry of Array.isArray(plan.reused) ? plan.reused : []) {
    const reused = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    if (!Array.isArray(reused.skip) || typeof reused.sourceRunId !== 'number') continue;
    for (const line of reused.skip) add(line, `passed in run #${reused.sourceRunId}`);
  }
  for (const line of plan.skip) add(line, `passed in an earlier run (pass reuse plan ${planId})`);
  return reasons;
}

/** Read the reason each line of plan `planId` skips its test, from the dashboard. */
export async function fetchPlanSkipReasons(ask: DashboardAsk, planId: number): Promise<Map<string, string>> {
  const answer = await ask.http.readJSON(`/api/projects/${ask.projectId}/run-plans/${planId}`, ask.auth, ask.signal);
  return planSkipReasons(answer, planId);
}

/**
 * Skip each test a plan names (`reasons`, by `planSkipReasons`) with `skip`, the run's `testRun.skip`, and return the
 * tests it skipped. `tests` are the tests the run can change, each with its name.
 */
export function skipPlannedTests(
  skip: (test: TestCase, reason: string) => void,
  tests: ReadonlyArray<{ test: TestCase; name: TestListName }>,
  reasons: ReadonlyMap<string, string>,
): TestCase[] {
  const skipped: TestCase[] = [];
  for (const { test, name } of tests) {
    const reason = reasons.get(nameKey(name));
    if (reason === undefined) continue;
    skip(test, reason);
    skipped.push(test);
  }
  return skipped;
}
