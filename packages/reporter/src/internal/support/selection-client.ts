/**
 * Thin HTTP client for the dashboard's selection resolve endpoint, shared by the
 * `piwi select` / `piwi run` / `piwi preflight` CLI and the `resolveSelection()`
 * config helper. Resolution happens server-side; this only names the project,
 * calls resolve, and hands back the structured result. It also fetches the
 * project's locator index for `piwi preflight`.
 */
import type { LocatorIndex, LocatorIndexTest } from '@piwitests/core/locator-index';
import type { BaseLineChange } from '@piwitests/core/suspect-lines';

export interface SelectionResolution {
  key: string | null;
  version: number | null;
  tests: Array<{ testCaseId: number; filePath: string; title: string; line: number | null; locks?: string[] }>;
  resolvedHash: string;
  estimate: { count: number; totalDurationMs: number | null };
  warnings: Array<{ code: string; message: string }>;
  materialization: { format: string; args: string[]; command: string };
}

/** Impact resolution — a normal resolution plus the diff-mapping summary. */
export interface ImpactResolution extends SelectionResolution {
  impact: {
    changedFiles: number;
    mappedFiles: number;
    widened: boolean;
    /** Changed files that forced the full suite: mapped to no test, or only through failure frames. */
    unmappedSourceFiles: string[];
    /** Changed files whose tests were narrowed to the changed lines they ran; absent from an older dashboard. */
    lineLevelFiles?: number;
  };
}

export interface SelectionClientOptions {
  serverUrl: string;
  apiKey?: string | null;
  /** Project name or numeric id. */
  project: string;
  key: string;
  format?: string;
  budgetMs?: number | null;
  pkgRunner?: string;
  /** Shard spec `i/n` — keep only shard i of n, balanced by duration. */
  shard?: string | null;
  /** Rank order to emit tests in (fail-fast), e.g. `failureLikelihood`. */
  order?: string | null;
}

function authHeaders(apiKey?: string | null): Record<string, string> {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

/** Resolve a project name to its id, or pass a numeric id straight through. */
export async function resolveProjectId(options: SelectionClientOptions): Promise<number> {
  if (!options.project) throw new Error('No project — pass --project or set PIWI_PROJECT_NAME');
  if (/^\d+$/.test(options.project)) return Number(options.project);

  const res = await fetch(`${options.serverUrl}/api/projects/menu`, { headers: authHeaders(options.apiKey) });
  if (!res.ok) throw new Error(`Could not list projects (dashboard returned ${res.status})`);
  const body = (await res.json()) as { items?: Array<{ id: number; name: string }> };
  const match = body.items?.find((p) => p.name.toLowerCase() === options.project.toLowerCase());
  if (!match) throw new Error(`No project named "${options.project}" on this dashboard`);
  return match.id;
}

/** Resolve a saved (or built-in) selection to its runnable materialization. */
export async function fetchResolution(
  options: SelectionClientOptions,
  projectId: number,
): Promise<SelectionResolution> {
  const params = new URLSearchParams({ format: options.format ?? 'args' });
  if (options.pkgRunner) params.set('pkgRunner', options.pkgRunner);
  if (options.budgetMs != null) params.set('budgetMs', String(options.budgetMs));
  if (options.shard) params.set('shard', options.shard);
  if (options.order) params.set('order', options.order);
  const url = `${options.serverUrl}/api/projects/${projectId}/selections/${encodeURIComponent(options.key)}/resolve?${params}`;
  const res = await fetch(url, { headers: authHeaders(options.apiKey) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status} resolving "${options.key}"`);
  }
  return (await res.json()) as SelectionResolution;
}

/**
 * Map a set of changed files to the tests they impact; `changes`, the changed
 * base lines of modified files, narrows them to the tests that ran those lines.
 */
export async function fetchImpact(
  options: SelectionClientOptions,
  projectId: number,
  changedFiles: string[],
  changes: BaseLineChange[] = [],
): Promise<ImpactResolution> {
  const url = `${options.serverUrl}/api/projects/${projectId}/selections/impact`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(options.apiKey) },
    body: JSON.stringify({
      changedFiles,
      ...(changes.length > 0 ? { changes } : {}),
      format: options.format ?? 'args',
      shard: options.shard ?? undefined,
      order: options.order ?? undefined,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status} resolving impact`);
  }
  return (await res.json()) as ImpactResolution;
}

/** A project's locator index: every chain its tests used, for one branch (the default branch when absent). */
export async function fetchLocatorIndex(
  options: Pick<SelectionClientOptions, 'serverUrl' | 'apiKey'>,
  projectId: number,
  branch?: string | null,
): Promise<LocatorIndex> {
  const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  const res = await fetch(`${options.serverUrl}/api/projects/${projectId}/locator-index${query}`, {
    headers: authHeaders(options.apiKey),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status} fetching the locator index`);
  }
  return (await res.json()) as LocatorIndex;
}

/** A project's code index: the source files its tests reach, when code reach or an instrumented backend recorded any. */
interface CodeIndex {
  files: string[];
  tests: LocatorIndexTest[];
  reach: Array<{ file: number; tests: number[]; origin: 'client' | 'server' }>;
  builtAt: string | null;
  truncated: boolean;
}

/** Fetch the code index of a branch (the default branch when absent). */
export async function fetchCodeIndex(
  options: Pick<SelectionClientOptions, 'serverUrl' | 'apiKey'>,
  projectId: number,
  branch?: string | null,
): Promise<CodeIndex> {
  const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  const res = await fetch(`${options.serverUrl}/api/projects/${projectId}/code-index${query}`, {
    headers: authHeaders(options.apiKey),
  });
  if (!res.ok) throw new Error(`Dashboard returned ${res.status} fetching the code index`);
  return (await res.json()) as CodeIndex;
}

/** Why a planned test runs, or that it is reused. */
export type PlanReason =
  | 'reused'
  | 'no-source'
  | 'quarantined'
  | 'open-cluster'
  | 'flaky'
  | 'no-reuse-tag'
  | 'commit-unavailable'
  | 'widened'
  | 'changed';

/** What every plan answer carries. */
export interface PlanSummary {
  selection: { key: string; version: number | null };
  counts: { candidates: number; run: number; reused: number };
  reasons: Partial<Record<PlanReason, number>>;
}

export interface CreatedPlan extends PlanSummary {
  id: number;
  expiresAt: string;
  estimate: { runDurationMs: number; reusedDurationMs: number };
}

export interface StoredPlan extends PlanSummary {
  id: number;
  /** The commit the plan was made at; null outside a git checkout. */
  commit: string | null;
  expiresAt: string;
  /** The selection's Playwright arguments; none for the whole suite. */
  args: string[];
  /** The Playwright test list lines of the reused tests, for `--test-list-invert`. */
  skip: string[];
  reused: Array<{ testCaseId: number; sourceRunId: number; sourceCommit: string; projects: string[] }>;
}

/** One source commit's change to the working tree, as `piwi run impact` computes it. */
export interface PlanDiff {
  commit: string;
  changedFiles: string[];
  changes: BaseLineChange[];
}

async function planRequest<T>(url: string, init: RequestInit, apiKey: string | null | undefined, what: string) {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status} ${what}`);
  }
  return (await res.json()) as T;
}

/** The source commits a plan of `selection` diffs against. */
export function fetchPlanSources(
  options: Pick<SelectionClientOptions, 'serverUrl' | 'apiKey'>,
  projectId: number,
  selection: string,
  playwrightVersion: string | null,
): Promise<{ candidates: number; commits: Array<{ commit: string; tests: number }> }> {
  return planRequest(
    `${options.serverUrl}/api/projects/${projectId}/run-plans/sources`,
    { method: 'POST', body: JSON.stringify({ selection, playwrightVersion }) },
    options.apiKey,
    'finding the passes to reuse',
  );
}

/** Store a plan of `selection` from the diffs against its source commits. */
export function createPlan(
  options: Pick<SelectionClientOptions, 'serverUrl' | 'apiKey'>,
  projectId: number,
  body: {
    selection: string;
    playwrightVersion: string | null;
    commit: string | null;
    branch: string | null;
    diffs: PlanDiff[];
  },
): Promise<CreatedPlan> {
  return planRequest(
    `${options.serverUrl}/api/projects/${projectId}/run-plans`,
    { method: 'POST', body: JSON.stringify(body) },
    options.apiKey,
    'planning the run',
  );
}

/** A stored plan: the selection's arguments and the tests to skip. */
export function fetchPlan(
  options: Pick<SelectionClientOptions, 'serverUrl' | 'apiKey'>,
  projectId: number,
  planId: number,
): Promise<StoredPlan> {
  return planRequest(
    `${options.serverUrl}/api/projects/${projectId}/run-plans/${planId}`,
    { method: 'GET' },
    options.apiKey,
    `reading plan ${planId}`,
  );
}
