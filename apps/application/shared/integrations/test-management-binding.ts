/**
 * The per-project test management binding: which connection and provider project a project's tests are matched
 * against, where a test's case keys come from, which runs are in scope, how a test run is named and which status names
 * its results carry.
 *
 * Pure and dependency-free, in the style of `resolveProjectIntegration`: the settings endpoint stores a resolved
 * object, and `resolveTestManagementBinding` clamps an arbitrary (possibly untrusted) payload onto the defaults so every
 * reader sees the same shape. The code that reads and writes the row lives in
 * `server/utils/integrations/test-management/binding.ts`.
 */
import { ANY_RUN_SCOPE, resolveRunScope, type TrackerRunScope } from './automation';

/** The longest status name the tool accepts. */
export const MAX_STATUS_NAME_LENGTH = 255;

/** The longest run name template a binding stores. */
export const MAX_RUN_NAME_TEMPLATE_LENGTH = 200;

/** The longest provider project key, folder ID and version a binding stores. */
const MAX_FIELD_LENGTH = 100;

/** The longest project key a binding stores; a longer one is refused, not cut. */
export const MAX_PROJECT_KEY_LENGTH = MAX_FIELD_LENGTH;

/** A project key as the tool shows it (`SHOP`): the shape Jira gives a project key. */
export const TEST_MANAGEMENT_PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** The variables a run name template may use. `{runId}` is required. */
export const RUN_NAME_VARIABLES = ['branch', 'environment', 'runId', 'commit', 'date', 'ciBuild'] as const;

/** The name a test run gets unless the binding names it otherwise. */
export const DEFAULT_RUN_NAME_TEMPLATE = 'Automation · {branch} · {environment} · Piwi #{runId}';

/** Where a test's case keys come from. */
export interface TestManagementKeySources {
  /** The tags that match the project's test case key pattern. */
  tags: boolean;
  /** The test's external ID, when it matches the key pattern. */
  externalId: boolean;
}

/**
 * How a test run is made. Only a new run per Piwi run exists today, so `mode` has one value; `folderId` and `version`
 * are optional.
 */
export interface TestManagementRunPolicy {
  mode: 'per-run';
  nameTemplate: string;
  folderId?: string;
  version?: string;
}

/** The names the tool gives each result status; `flaky` is the project's own status for a pass after a retry. */
export interface TestManagementStatuses {
  pass: string;
  fail: string;
  flaky: string | null;
  notExecuted: string;
}

/** What a flaky test (passed only after a retry) is reported as. */
export type FlakyAs = 'pass' | 'fail' | 'flaky';

/** What a test that was skipped or did not run is reported as: left out, or Not Executed. */
export type SkippedAs = 'notExecuted' | null;

export interface TestManagementOptions {
  flakyAs: FlakyAs;
  skippedAs: SkippedAs;
  /** Add the first line of the error to a failed result. Off: an error message can carry data from the application. */
  includeError: boolean;
  /** Add the short outcome comment (retry, projects, links) to each result. */
  includeComment: boolean;
}

/** A project's resolved test management binding. */
export interface ResolvedTestManagementBinding {
  connectionId: number | null;
  /** The tool's project key (`SHOP`), null while none is chosen. */
  providerProjectKey: string | null;
  enabled: boolean;
  /** True: nothing is sent to the tool. On for a new binding. */
  dryRun: boolean;
  keySources: TestManagementKeySources;
  runScope: TrackerRunScope;
  runPolicy: TestManagementRunPolicy;
  statuses: TestManagementStatuses;
  options: TestManagementOptions;
}

export const DEFAULT_KEY_SOURCES: Readonly<TestManagementKeySources> = Object.freeze({ tags: true, externalId: false });

export const DEFAULT_TEST_MANAGEMENT_STATUSES: Readonly<TestManagementStatuses> = Object.freeze({
  pass: 'Pass',
  fail: 'Fail',
  flaky: null,
  notExecuted: 'Not Executed',
});

export const DEFAULT_TEST_MANAGEMENT_OPTIONS: Readonly<TestManagementOptions> = Object.freeze({
  flakyAs: 'pass',
  skippedAs: null,
  includeError: false,
  includeComment: true,
});

/** The scope a new binding starts with: the project's default branch only, any environment. */
export const DEFAULT_TEST_MANAGEMENT_RUN_SCOPE: Readonly<TrackerRunScope> = Object.freeze({
  ...ANY_RUN_SCOPE,
  defaultBranch: true,
});

export type RunNameTemplateCheck = { ok: true } | { ok: false; message: string };

/**
 * Whether a run name template can be stored: it is not empty, holds `{runId}` (it makes the name unique and lets a
 * person recognize the run) and names only the known variables.
 */
export function validateRunNameTemplate(template: string): RunNameTemplateCheck {
  const text = template.trim();
  if (!text) return { ok: false, message: 'Enter a name for the test run.' };
  if (text.length > MAX_RUN_NAME_TEMPLATE_LENGTH) {
    return { ok: false, message: `A run name holds ${MAX_RUN_NAME_TEMPLATE_LENGTH} characters at most.` };
  }
  const known = new Set<string>(RUN_NAME_VARIABLES);
  const used = [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
  const unknown = used.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const names = [...new Set(unknown)].map((name) => `{${name}}`).join(', ');
    return {
      ok: false,
      message: `${names} is not a variable. Use ${RUN_NAME_VARIABLES.map((name) => `{${name}}`).join(', ')}.`,
    };
  }
  if (!used.includes('runId')) {
    return { ok: false, message: 'The name must contain {runId}, so each run has its own name.' };
  }
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) {
    return { ok: false, message: 'A brace is left open. Write a variable as {runId}.' };
  }
  return { ok: true };
}

/** A string trimmed and cut to `max`, or null for anything else or an empty value. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

/** A status name trimmed and cut to the tool's limit; the default when the input names none. */
function statusName(value: unknown, fallback: string): string;
function statusName(value: unknown, fallback: null): string | null;
function statusName(value: unknown, fallback: string | null): string | null {
  return text(value, MAX_STATUS_NAME_LENGTH) ?? fallback;
}

/** Whether `value` is a status name that is too long for the tool: it is cut when stored, and refused by the endpoint. */
export function statusNameTooLong(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > MAX_STATUS_NAME_LENGTH;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Normalize an arbitrary (possibly untrusted) payload onto the binding's defaults. A field left out takes its default;
 * a value of the wrong type does too. A name template that fails {@link validateRunNameTemplate} falls back to the
 * default (the endpoint refuses it before it gets here).
 */
export function resolveTestManagementBinding(input: unknown): ResolvedTestManagementBinding {
  const raw = record(input);
  const sources = record(raw.keySources);
  const policy = record(raw.runPolicy);
  const statuses = record(raw.statuses);
  const options = record(raw.options);

  const connectionId =
    typeof raw.connectionId === 'number' && Number.isInteger(raw.connectionId) && raw.connectionId > 0
      ? raw.connectionId
      : null;
  const template = typeof policy.nameTemplate === 'string' ? policy.nameTemplate.trim() : '';
  const runPolicy: TestManagementRunPolicy = {
    mode: 'per-run',
    nameTemplate: template && validateRunNameTemplate(template).ok ? template : DEFAULT_RUN_NAME_TEMPLATE,
  };
  const folderId = text(policy.folderId, MAX_FIELD_LENGTH);
  const version = text(policy.version, MAX_FIELD_LENGTH);
  if (folderId) runPolicy.folderId = folderId;
  if (version) runPolicy.version = version;

  return {
    connectionId,
    providerProjectKey: text(raw.providerProjectKey, MAX_FIELD_LENGTH),
    enabled: flag(raw.enabled, true),
    dryRun: flag(raw.dryRun, true),
    keySources: {
      tags: flag(sources.tags, DEFAULT_KEY_SOURCES.tags),
      externalId: flag(sources.externalId, DEFAULT_KEY_SOURCES.externalId),
    },
    runScope:
      raw.runScope === undefined || raw.runScope === null
        ? { ...DEFAULT_TEST_MANAGEMENT_RUN_SCOPE }
        : resolveRunScope(raw.runScope),
    runPolicy,
    statuses: {
      pass: statusName(statuses.pass, DEFAULT_TEST_MANAGEMENT_STATUSES.pass),
      fail: statusName(statuses.fail, DEFAULT_TEST_MANAGEMENT_STATUSES.fail),
      flaky: statusName(statuses.flaky, null),
      notExecuted: statusName(statuses.notExecuted, DEFAULT_TEST_MANAGEMENT_STATUSES.notExecuted),
    },
    options: {
      flakyAs: options.flakyAs === 'fail' || options.flakyAs === 'flaky' ? options.flakyAs : 'pass',
      skippedAs: options.skippedAs === 'notExecuted' ? 'notExecuted' : null,
      includeError: flag(options.includeError, DEFAULT_TEST_MANAGEMENT_OPTIONS.includeError),
      includeComment: flag(options.includeComment, DEFAULT_TEST_MANAGEMENT_OPTIONS.includeComment),
    },
  };
}

/** The binding of a project that has none: the defaults, with no connection. */
export function emptyTestManagementBinding(): ResolvedTestManagementBinding {
  return resolveTestManagementBinding({});
}

/**
 * Why a binding payload with a connection cannot be stored, or null when it can: a provider project key that is not a
 * project key, a run name template without `{runId}` or with an unknown variable, a status name over the tool's limit,
 * an unknown flaky handling, or `flakyAs: 'flaky'` without a flaky status. One check for the endpoint and the demo.
 */
export function testManagementBindingProblem(body: Record<string, unknown>): string | null {
  const key = body.providerProjectKey;
  if (typeof key !== 'string' || !TEST_MANAGEMENT_PROJECT_KEY.test(key.trim())) {
    return 'Choose a project of the test management tool';
  }
  if (key.trim().length > MAX_PROJECT_KEY_LENGTH) {
    return `A project key holds ${MAX_PROJECT_KEY_LENGTH} characters at most`;
  }

  const policy = record(body.runPolicy);
  if (policy.nameTemplate !== undefined) {
    const check =
      typeof policy.nameTemplate === 'string'
        ? validateRunNameTemplate(policy.nameTemplate)
        : ({ ok: false, message: 'Enter a name for the test run.' } as const);
    if (!check.ok) return check.message;
  }

  const statuses = record(body.statuses);
  for (const name of ['pass', 'fail', 'flaky', 'notExecuted']) {
    if (statusNameTooLong(statuses[name])) return 'A status name holds 255 characters at most.';
  }

  const options = record(body.options);
  if (options.flakyAs !== undefined && !['pass', 'fail', 'flaky'].includes(String(options.flakyAs))) {
    return 'Invalid flaky handling';
  }
  if (options.flakyAs === 'flaky' && !(typeof statuses.flaky === 'string' && statuses.flaky.trim())) {
    return 'Name the status a flaky test is reported as.';
  }
  return null;
}
