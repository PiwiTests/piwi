/**
 * Flake mode: the capture fixtures' side of a flake-lab arm. The lab runs
 * Playwright with `PIWI_FLAKE_PLAN` pointing at one arm's plan; for the test the
 * plan names, the fixtures apply the arm's conditions on the first instrumented
 * page before it navigates, and every finished attempt of that test (and of an
 * `alongside` or `after` companion) appends one line to `PIWI_FLAKE_RESULTS`.
 *
 * Route conditions (`delay`, `fail`) go through the interception shared with
 * probe mode; `cpu` and `network` open a Chrome DevTools Protocol session, so
 * they apply in Chromium only and are reported skipped elsewhere; `alongside`,
 * `after` and `project` are applied by the command line's Playwright arguments
 * and only reported here.
 */

import * as fs from 'node:fs';
import type { Page } from '@playwright/test';
import {
  COMMAND_CONDITION_KINDS,
  FLAKE_LAB_RUN_METADATA_KEY,
  FLAKE_PLAN_VERSION,
  flakeErrorSignature,
  flakeTestMatches,
  parseFlakePlanText,
  type FlakeCondition,
  type FlakeConditionReport,
  type FlakePlan,
  type FlakeLabRunStamp,
  type FlakeResultLine,
} from '@piwitests/core/flake-plan';
import { parseRunOriginRef, RUN_ORIGIN_METADATA_KEY } from '@piwitests/core/wire';
import { requestRouteKey } from '@piwitests/core/page-key';
import { PIWI_FLAKE_ENV, PIWI_PROBE_ENV } from '../config/env.js';
import { errorMessage } from '../support/errors.js';
import { relativeTestPath } from '../support/test-paths.js';
import type { RouteAction } from '../probe/faults.js';
import { installRouteRules, performRouteAction, type RouteRule } from '../probe/interception.js';
import { isProbeMode } from '../probe/mode.js';

/** True when this Playwright run is a flake-lab run. */
export function isFlakeMode(): boolean {
  return !!process.env[PIWI_FLAKE_ENV.plan]?.trim();
}

/**
 * The message for a run that asks for probe mode and flake mode at once, or
 * null. Each mode stamps the run and changes what the page sees, so the two
 * never mix: the config wrapper and the capture fixtures stop such a run.
 */
export function labModeConflict(): string | null {
  if (!isProbeMode() || !isFlakeMode()) return null;
  return `[Piwi Dashboard] ${PIWI_PROBE_ENV.flag} and ${PIWI_FLAKE_ENV.plan} are both set: a run is a probe run or a flake-lab run, not both. Unset one of them.`;
}

let planCache: { file: string; plan: FlakePlan } | null = null;

/**
 * The arm's plan, read once per worker. Throws with the file name and the first
 * problem when the file is missing or invalid, so an arm never runs without its
 * conditions.
 */
export function loadFlakePlan(): FlakePlan {
  const file = process.env[PIWI_FLAKE_ENV.plan]?.trim() ?? '';
  if (planCache && planCache.file === file) return planCache.plan;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`[Piwi Dashboard] Cannot read the flake plan ${file}: ${errorMessage(error)}`);
  }
  try {
    const plan = parseFlakePlanText(text);
    planCache = { file, plan };
    return plan;
  } catch (error) {
    throw new Error(`[Piwi Dashboard] ${errorMessage(error)} (${file})`);
  }
}

/** Forget the cached plan (tests switch plans within one process). */
export function resetFlakePlanCache(): void {
  planCache = null;
}

/**
 * The run-metadata stamp of a flake-lab run, merged into the run's metadata,
 * with its origin: `flake-lab`, referring to the experiment.
 */
export function flakeRunMetadata(stamp: FlakeLabRunStamp, base: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = parseRunOriginRef(stamp.experimentId);
  return {
    ...base,
    [FLAKE_LAB_RUN_METADATA_KEY]: { experimentId: stamp.experimentId, armId: stamp.armId },
    [RUN_ORIGIN_METADATA_KEY]: ref === undefined ? { kind: 'flake-lab' } : { kind: 'flake-lab', ref },
  };
}

/** A running test as flake mode sees it. */
export interface FlakeTestIdentity {
  /** Absolute spec path, as Playwright reports it. */
  file: string | null;
  /** The folder spec paths are named relative to (the Playwright config's); the working directory by default. */
  base?: string;
  title: string;
  /** `[file, ...describe titles, test title]`. */
  titlePath?: string[];
  project: string | null;
}

/**
 * A spec path in the shape the dashboard stores: relative to `base` (the
 * Playwright config's folder), POSIX separators.
 */
export function relativeTestFile(file: string | null | undefined, base: string = process.cwd()): string | null {
  return file ? relativeTestPath(file, base) : null;
}

/**
 * The test's role in the arm: the `target` the plan names (file and title, the
 * describe path when both have one, and the project when the plan pins one), a
 * `companion` an `alongside` or `after` condition names, or null for any other
 * test in the run.
 */
export function flakeRoleForTest(plan: FlakePlan, test: FlakeTestIdentity): 'target' | 'companion' | null {
  const running = {
    file: relativeTestFile(test.file, test.base),
    title: test.title,
    suite: test.titlePath ? test.titlePath.slice(1, -1) : undefined,
  };
  if (flakeTestMatches(plan.test, running) && (plan.test.project === null || plan.test.project === test.project)) {
    return 'target';
  }
  const companion = plan.arm.conditions.some(
    (c) => (c.kind === 'alongside' || c.kind === 'after') && flakeTestMatches(c.test, running),
  );
  return companion ? 'companion' : null;
}

/** The browser behind a page (`chromium`, `firefox`, `webkit`), or null when Playwright does not say. */
export function pageBrowserName(page: Page): string | null {
  try {
    return page.context().browser()?.browserType().name() ?? null;
  } catch {
    return null;
  }
}

/** The CDP calls a `cpu` or `network` condition makes. */
export function cdpCommandFor(condition: FlakeCondition): { method: string; params: Record<string, unknown> } | null {
  if (condition.kind === 'cpu') return { method: 'Emulation.setCPUThrottlingRate', params: { rate: condition.rate } };
  if (condition.kind === 'network') {
    return {
      method: 'Network.emulateNetworkConditions',
      params: {
        offline: false,
        latency: condition.latencyMs,
        // Kilobits per second to bytes per second.
        downloadThroughput: (condition.downKbps * 1000) / 8,
        uploadThroughput: (condition.upKbps * 1000) / 8,
      },
    };
  }
  return null;
}

/** The route action a `delay` or `fail` condition performs. */
function conditionRouteAction(condition: FlakeCondition): RouteAction | null {
  if (condition.kind === 'delay') return { kind: 'delay', ms: condition.ms };
  if (condition.kind === 'fail')
    return 'abort' in condition ? { kind: 'abort' } : { kind: 'status', status: condition.status };
  return null;
}

/** What one arm did to the page, read when the attempt finishes. */
export interface FlakeConditions {
  /** One report per condition, in plan order. */
  reports: () => FlakeConditionReport[];
}

/**
 * Reports for an attempt whose page never opened: a route condition matched no
 * request, and a CDP condition had no page to apply to.
 */
export function unappliedReports(plan: FlakePlan): FlakeConditionReport[] {
  return plan.arm.conditions.map((c): FlakeConditionReport => {
    if (COMMAND_CONDITION_KINDS.includes(c.kind)) return { kind: c.kind, outcome: 'by-command' };
    if (cdpCommandFor(c)) return { kind: c.kind, outcome: 'skipped', note: 'the attempt opened no page' };
    return { kind: c.kind, outcome: 'not-matched' };
  });
}

/**
 * Apply an arm's conditions to a page before it navigates: one interception
 * rule per route condition, and one CDP command per `cpu` or `network`
 * condition. A CDP condition on a browser other than Chromium, or one whose
 * session cannot open, is reported skipped rather than failing the attempt.
 *
 * The interception is installed in every arm, the control and an arm without
 * route conditions included: routing turns off the page's HTTP cache and sends
 * every request through Playwright, so an arm that routed while its control did
 * not would differ from it by more than its conditions.
 */
export async function installFlakeConditions(page: Page, plan: FlakePlan): Promise<FlakeConditions> {
  const conditions = plan.arm.conditions;
  const reports = unappliedReports(plan);

  const rules: RouteRule[] = [];
  conditions.forEach((condition, i) => {
    const action = conditionRouteAction(condition);
    if (!action || (condition.kind !== 'delay' && condition.kind !== 'fail')) return;
    const route = condition.route;
    rules.push({
      matches: (method, url) => requestRouteKey(method, url) === route,
      match: condition.match,
      handle: async (r, startedAt) => {
        reports[i] = { kind: condition.kind, outcome: 'applied' };
        try {
          await performRouteAction(r, action, startedAt);
        } catch {
          // The page closed mid-request, or the request was already handled.
          await r.fallback().catch(() => {});
        }
      },
    });
  });
  await installRouteRules(page, rules);

  const cdp = conditions.map((c, i) => ({ i, command: cdpCommandFor(c) })).filter((c) => c.command);
  if (cdp.length > 0) {
    const browserName = pageBrowserName(page);
    if (browserName !== null && browserName !== 'chromium') {
      for (const { i } of cdp) {
        reports[i] = {
          kind: conditions[i]!.kind,
          outcome: 'skipped',
          note: `needs Chromium; this attempt ran in ${browserName}`,
        };
      }
    } else {
      try {
        const session = await page.context().newCDPSession(page);
        for (const { i, command } of cdp) {
          try {
            if (command!.method.startsWith('Network.')) await session.send('Network.enable');
            await session.send(command!.method as 'Emulation.setCPUThrottlingRate', command!.params as never);
            reports[i] = { kind: conditions[i]!.kind, outcome: 'applied' };
          } catch (error) {
            reports[i] = { kind: conditions[i]!.kind, outcome: 'skipped', note: errorMessage(error) };
          }
        }
      } catch (error) {
        for (const { i } of cdp) {
          reports[i] = {
            kind: conditions[i]!.kind,
            outcome: 'skipped',
            note: `no DevTools session: ${errorMessage(error)}`,
          };
        }
      }
    }
  }

  return { reports: () => reports.map((r) => ({ ...r })) };
}

/** The Playwright facts of one finished attempt a results line is built from. */
export interface FlakeAttempt {
  role: 'target' | 'companion';
  file: string | null;
  /** The folder `file` is named relative to (the Playwright config's); the working directory by default. */
  base?: string;
  title: string;
  project: string | null;
  browserName: string | null;
  status: string;
  /** The attempt's error text, or null when it has none. */
  errorText: string | null;
  startedAt: number;
  duration: number;
  workerIndex: number;
  parallelIndex: number;
  repeatEachIndex: number;
  retry: number;
  conditions: FlakeConditionReport[];
}

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

/**
 * One results line. An attempt that failed carries its error signature, and
 * matches history when that signature is one of the plan's.
 */
export function flakeResultLine(plan: FlakePlan, attempt: FlakeAttempt): FlakeResultLine {
  const failed = FAILED_STATUSES.has(attempt.status);
  const errorSignature = failed && attempt.errorText ? flakeErrorSignature(attempt.errorText) : null;
  return {
    version: FLAKE_PLAN_VERSION,
    experimentId: plan.experimentId,
    armId: plan.arm.id,
    role: attempt.role,
    file: relativeTestFile(attempt.file, attempt.base),
    title: attempt.title,
    project: attempt.project,
    browserName: attempt.browserName,
    status: attempt.status,
    errorSignature,
    matchesHistory: errorSignature !== null && plan.errorSignatures.includes(errorSignature),
    startedAt: attempt.startedAt,
    duration: attempt.duration,
    workerIndex: attempt.workerIndex,
    parallelIndex: attempt.parallelIndex,
    repeatEachIndex: attempt.repeatEachIndex,
    retry: attempt.retry,
    conditions: attempt.role === 'target' ? attempt.conditions : [],
  };
}

/**
 * Append one line to the results file. The line goes out in a single append
 * (`O_APPEND`), so lines from workers writing at once never interleave. A
 * write failure never breaks the run.
 */
export function recordFlakeResult(line: FlakeResultLine): void {
  const file = process.env[PIWI_FLAKE_ENV.results]?.trim();
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // A results-file write failure must never break the run.
  }
}
