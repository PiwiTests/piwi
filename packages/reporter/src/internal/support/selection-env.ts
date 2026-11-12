import { PIWI_PLAN_ENV, PIWI_SELECTION_ENV } from '../config/env.js';
import { detectCliNarrowingFlags } from './cli-filters.js';
import type { SelectionStamp } from '../../types.js';

/**
 * Read the selection stamp `piwi run` left in the environment, if any. Returns
 * null unless a selection key is present with a well-formed version, hash and
 * count — a partial or hand-set environment must not produce a bogus stamp.
 */
export function readSelectionStamp(env: NodeJS.ProcessEnv = process.env): SelectionStamp | null {
  const key = env[PIWI_SELECTION_ENV.key];
  if (!key) return null;

  const version = Number(env[PIWI_SELECTION_ENV.version]);
  const resolvedCount = Number(env[PIWI_SELECTION_ENV.count]);
  const resolvedHash = env[PIWI_SELECTION_ENV.hash] ?? '';
  if (!Number.isFinite(version) || !Number.isFinite(resolvedCount) || !resolvedHash) return null;

  return { key, version, resolvedHash, resolvedCount };
}

/**
 * The pass reuse plan `piwi run` left in the environment, or null unless it is
 * a plan id and the run passed Playwright the plan's skip list
 * (`--test-list-invert`): a `PIWI_PLAN` left in a shell for another run
 * claims nothing.
 */
export function readPlanStamp(
  env: NodeJS.ProcessEnv = process.env,
  narrowing: string[] = detectCliNarrowingFlags(),
): { id: number } | null {
  const raw = env[PIWI_PLAN_ENV];
  if (!raw || !/^\d+$/.test(raw) || !narrowing.includes('test-list-invert')) return null;
  return { id: Number(raw) };
}
