/**
 * What a finished run sends to a test management tool: one result per test case key, from the final attempts of the
 * run, and the name and description of the test run they go into.
 *
 * Pure and dependency-free, so the payload a sync stores is built the same way wherever it is read. The code that
 * reads the run, the binding and the catalog is `server/utils/integrations/test-management/sync.ts`.
 */
import { FAILED_STATUS_KEYS, flakyFinalAttempts, testOutcomes } from '../utils/test-counts';
import { testCaseKeys } from './test-management-mapping';
import {
  DEFAULT_RUN_NAME_TEMPLATE,
  type ResolvedTestManagementBinding,
  type TestManagementStatuses,
} from './test-management-binding';

/** The longest name the tool accepts for a test run. */
export const MAX_RUN_NAME_LENGTH = 255;

/** The longest value of a variable once a name is too long for the tool. */
const SHORT_VARIABLE_LENGTH = 24;

/** The most unknown keys a payload lists. */
export const MAX_PAYLOAD_UNKNOWN_KEYS = 20;

/** A final-attempt row of the run, with the tags and external ID of its test. */
export interface SyncAttemptRow {
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number | null;
  retries: number | null;
  status: string;
  /** The stored verdict of the row (`passed_after_failure`). */
  passedAfterFailure: boolean | null;
  tags: readonly string[];
  externalId: string | null;
}

/** The facts of the run a name and a description are made of. */
export interface SyncRunFacts {
  runId: number;
  /** The run's address in Piwi, or null when the server has none. */
  url: string | null;
  branch: string | null;
  environment: string | null;
  commit: string | null;
  /** When the run started, epoch ms. */
  startedAt: number | null;
  ciBuild: string | null;
}

/** How many results of each kind a payload sends. */
export interface SyncCounts {
  passed: number;
  failed: number;
  flaky: number;
  notExecuted: number;
}

export interface SyncResult {
  key: string;
  status: string;
}

/** What a sync stores and sends: built when the run finishes, so a retry sends the same. */
export interface SyncPayload {
  run: { name: string; description: string; folderId?: string; version?: string };
  results: SyncResult[];
  /** Keys the tests carry that the catalog does not hold, up to {@link MAX_PAYLOAD_UNKNOWN_KEYS}; never sent. */
  unknownKeys: string[];
  /** How many keys the catalog does not hold, listed or not. */
  unknownKeyCount: number;
  /** Tests that carry no key. */
  unmappedCount: number;
  /** Tests whose tags were cut at 20 in the run. */
  tagsTruncated: number;
  counts: SyncCounts;
  dryRun: boolean;
}

/**
 * What a sync action stores at enqueue, so a retry sends what the first attempt would have: the payload, and what
 * finding or linking the run later needs.
 */
export interface SyncActionPayload extends SyncPayload {
  runId: number;
  /** The run's address in Piwi, or null when the server has none. */
  runUrl: string | null;
  /** The tool's project the results go to, as the binding named it at enqueue. */
  providerProjectKey: string;
  /** When to start looking for the test run an earlier attempt made, an ISO time. */
  startedAt: string;
}

/**
 * What a sync row's `result` holds: the marker written before the upload is sent, the test run the upload created, and
 * what a finished sync sent. A dry run holds the payload it would have sent.
 */
export interface SyncState {
  /** Set before the upload is sent, epoch ms; with no `runKey` it means the upload may have reached the tool. */
  uploadStartedAt?: number;
  runKey?: string;
  runUrl?: string;
  /** Set once the test run carries its link back to the run's page in Piwi, so a retry does not add it again. */
  linked?: true;
  sent?: number;
  dryRun?: true;
  payload?: SyncPayload;
}

/** The state a sync row's `result` holds; an empty state for a row that holds none. */
export function readSyncState(result: unknown): SyncState {
  if (!result || typeof result !== 'object') return {};
  const value = result as Record<string, unknown>;
  return {
    ...(typeof value.uploadStartedAt === 'number' ? { uploadStartedAt: value.uploadStartedAt } : {}),
    ...(typeof value.runKey === 'string' ? { runKey: value.runKey } : {}),
    ...(typeof value.runUrl === 'string' ? { runUrl: value.runUrl } : {}),
    ...(value.linked === true ? { linked: true as const } : {}),
    ...(typeof value.sent === 'number' ? { sent: value.sent } : {}),
    ...(value.dryRun === true ? { dryRun: true as const } : {}),
    ...(value.payload && typeof value.payload === 'object' ? { payload: value.payload as SyncPayload } : {}),
  };
}

/** Whether an upload began and the tool never named the test run it made: it may exist, so uploading again may repeat it. */
export function uploadOutcomeUnknown(state: SyncState): boolean {
  return state.uploadStartedAt !== undefined && state.runKey === undefined;
}

/** The failure an unknown upload records: what to look for in the tool, and what to do then. */
export function syncOutcomeUnknownMessage(runName: string): string {
  return `Outcome unknown: check the test management tool for a test run named "${runName}", then use Sync again`;
}

export interface BuildSyncInput {
  run: SyncRunFacts;
  /** Every attempt row of the run. */
  rows: readonly SyncAttemptRow[];
  /** The test case key pattern of the project. */
  pattern: string | null;
  binding: Pick<ResolvedTestManagementBinding, 'keySources' | 'runPolicy' | 'statuses' | 'options' | 'dryRun'>;
  /** The keys the tool's catalog holds. */
  knownKeys: ReadonlySet<string>;
  tagsTruncated: number;
}

type KeyOutcome = 'failed' | 'flaky' | 'passed' | 'skipped';

/** How strongly an outcome speaks for a key several tests cover. */
const OUTCOME_RANK: Record<KeyOutcome, number> = { skipped: 0, passed: 1, flaky: 2, failed: 3 };

const FAILED = new Set<string>(FAILED_STATUS_KEYS);

/** The value a variable takes when the run does not carry it. */
const MISSING_VALUE = '-';

function variableValues(run: SyncRunFacts, maxLength: number): Record<string, string> {
  const cut = (value: string | null) => (value ? value.slice(0, maxLength) : MISSING_VALUE);
  return {
    branch: cut(run.branch),
    environment: cut(run.environment),
    runId: String(run.runId),
    commit: run.commit ? run.commit.slice(0, 7) : MISSING_VALUE,
    date: run.startedAt === null ? MISSING_VALUE : new Date(run.startedAt).toISOString().slice(0, 10),
    ciBuild: cut(run.ciBuild),
  };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]*)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * The name of the test run: the template with the run's facts. A name over the tool's limit is made again with
 * shorter values, then from the default template, so `{runId}` is never cut off.
 */
export function renderRunName(template: string, run: SyncRunFacts): string {
  for (const [text, length] of [
    [template, Number.MAX_SAFE_INTEGER],
    [template, SHORT_VARIABLE_LENGTH],
    [DEFAULT_RUN_NAME_TEMPLATE, SHORT_VARIABLE_LENGTH],
  ] as const) {
    const name = fill(text, variableValues(run, length)).trim();
    if (name.length <= MAX_RUN_NAME_LENGTH) return name;
  }
  return `Piwi #${run.runId}`;
}

/** The description of the test run: the run's address, branch, commit and what was sent. */
export function renderRunDescription(run: SyncRunFacts, counts: SyncCounts, sent: number): string {
  const parts = [`${counts.passed} passed`, `${counts.failed} failed`];
  if (counts.flaky > 0) parts.push(`${counts.flaky} flaky`);
  if (counts.notExecuted > 0) parts.push(`${counts.notExecuted} not executed`);
  return [
    `Piwi run #${run.runId}`,
    run.url,
    run.branch ? `Branch: ${run.branch}` : null,
    run.commit ? `Commit: ${run.commit.slice(0, 7)}` : null,
    `Results sent: ${sent} (${parts.join(', ')})`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** What a key's outcome is reported as, or null when it is left out. */
function statusFor(
  outcome: KeyOutcome,
  statuses: TestManagementStatuses,
  options: BuildSyncInput['binding']['options'],
): string | null {
  switch (outcome) {
    case 'failed':
      return statuses.fail;
    case 'passed':
      return statuses.pass;
    case 'flaky':
      if (options.flakyAs === 'fail') return statuses.fail;
      if (options.flakyAs === 'flaky') return statuses.flaky ?? statuses.pass;
      return statuses.pass;
    case 'skipped':
      return options.skippedAs === 'notExecuted' ? statuses.notExecuted : null;
  }
}

/**
 * The payload a finished run sends. One result per key a test carries and the catalog holds, from the final attempts
 * of the run: the worst outcome of the tests that cover the key (any failed or timed out, else any that passed after
 * a retry, else passed, else skipped), named by the binding's statuses. A key whose tests were all skipped or did not
 * run is left out unless the binding reports them as Not Executed.
 */
export function buildSyncPayload(input: BuildSyncInput): SyncPayload {
  const { run, rows, pattern, binding, knownKeys } = input;

  const keysByCase = new Map<number, Set<string>>();
  for (const row of rows) {
    let keys = keysByCase.get(row.testCaseId);
    if (!keys) {
      keys = new Set();
      keysByCase.set(row.testCaseId, keys);
    }
    for (const key of testCaseKeys(row, pattern, binding.keySources)) keys.add(key);
  }

  const flaky = flakyFinalAttempts(rows);
  const outcomes = new Map<string, KeyOutcome>();
  for (const row of testOutcomes(rows)) {
    const outcome: KeyOutcome = FAILED.has(row.status)
      ? 'failed'
      : row.status === 'passed'
        ? flaky.has(row)
          ? 'flaky'
          : 'passed'
        : 'skipped';
    for (const key of keysByCase.get(row.testCaseId) ?? []) {
      const current = outcomes.get(key);
      if (!current || OUTCOME_RANK[outcome] > OUTCOME_RANK[current]) outcomes.set(key, outcome);
    }
  }

  const counts: SyncCounts = { passed: 0, failed: 0, flaky: 0, notExecuted: 0 };
  const results: SyncResult[] = [];
  const unknown: string[] = [];
  for (const [key, outcome] of [...outcomes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!knownKeys.has(key)) {
      unknown.push(key);
      continue;
    }
    const status = statusFor(outcome, binding.statuses, binding.options);
    if (status === null) continue;
    results.push({ key, status });
    if (outcome === 'failed') counts.failed += 1;
    else if (outcome === 'flaky') counts.flaky += 1;
    else if (outcome === 'passed') counts.passed += 1;
    else counts.notExecuted += 1;
  }

  const unmappedCount = [...keysByCase.values()].filter((keys) => keys.size === 0).length;
  const { folderId, version, nameTemplate } = binding.runPolicy;
  return {
    run: {
      name: renderRunName(nameTemplate, run),
      description: renderRunDescription(run, counts, results.length),
      ...(folderId ? { folderId } : {}),
      ...(version ? { version } : {}),
    },
    results,
    unknownKeys: unknown.slice(0, MAX_PAYLOAD_UNKNOWN_KEYS),
    unknownKeyCount: unknown.length,
    unmappedCount,
    tagsTruncated: input.tagsTruncated,
    counts,
    dryRun: binding.dryRun,
  };
}
