/**
 * A CI dispatch request: what a place asks CI to run (its source), the branch
 * and the inputs it may send with it, and what a place is offered (the actions
 * that take its source, their branch mode and inputs). The server's dispatch
 * (`server/utils/ci-rerun.ts`) and the demo's read requests the same way.
 *
 * A source names one place: a failure cluster, an execution (its test, or
 * every test of its cluster), a run (its failed tests, or the whole suite on
 * its branch), a test's Flake Lab experiment, the project's whole suite, or
 * the project's tests carrying some tags. The kind of the dispatch follows
 * from it.
 *
 * Pure + dependency-free.
 */

import {
  CI_ACTION_KINDS,
  ciActionInputValues,
  ciActionTargetSummary,
  type CiAction,
  type CiActionInput,
  type CiActionKind,
  type CiActionPick,
  type CiActionTarget,
  type CiActionsSettings,
} from '#shared/ci-actions';
import {
  BRANCH_PLACEHOLDER,
  ciServerRequestTemplate,
  segmentClimbsWhenDecoded,
  type CiRequestTemplate,
} from '#shared/ci-server';
import { ciServerTargetOf, ciTargetDefinition } from '#shared/ci-targets';
import type { CiDispatchView, FlakeLabKind } from '#shared/ci-dispatches';
import { parseRouteId } from '#shared/route-id';
import { parseCiTags, type CiTagMatch } from '#shared/ci-tags';
import { foldText } from '#shared/utils/fold-text';

/** Where a dispatch's tests come from, as the server reads it. */
export type CiDispatchSource =
  | { from: 'cluster'; clusterId: number }
  | { from: 'execution'; executionId: number; scope: 'test' | 'cluster' }
  | { from: 'run-failed'; runId: number }
  | { from: 'run-suite'; runId: number }
  | { from: 'flake-lab'; testCaseId: number; flakeLab: FlakeLabKind }
  | { from: 'project' }
  | { from: 'tags'; tags: string[]; match: CiTagMatch };

/** A source as a client sends it, in a body or as query keys. */
export type CiDispatchSourceInput =
  | { clusterId: number }
  | { executionId: number; scope: 'test' | 'cluster' }
  | { runId: number; tests?: 'failed' }
  | { testCaseId: number; flakeLab: FlakeLabKind }
  | { tags: string[]; match?: CiTagMatch }
  | Record<string, never>;

const SOURCE_KEYS = [
  'clusterId',
  'executionId',
  'scope',
  'runId',
  'tests',
  'testCaseId',
  'flakeLab',
  'tags',
  'match',
] as const;
const ID_KEYS = ['clusterId', 'executionId', 'runId', 'testCaseId'] as const;

/** The longest action id or name a request may name. */
const MAX_ACTION_LENGTH = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** An id from a body (a number) or a query (its digits), as a route reads its path's ids. */
function idOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? parseRouteId(String(raw)) : null;
  return typeof raw === 'string' ? parseRouteId(raw) : null;
}

/**
 * A source from a body's `source` or a request's query keys: exactly one of
 * `clusterId`, `executionId` (with `scope`), `runId` (with `tests: 'failed'`
 * for its failed tests, without for the whole suite) and `testCaseId` (with
 * `flakeLab`); `tags` (with `match`: `any`, the default, or `all`) for the
 * project's tests carrying them, a list in a body and one key per tag in a
 * query, where an empty value names none ({@link parseCiTags}); or none of
 * them for the project's whole suite. A key of another shape, or one no shape
 * names, is refused.
 */
export function parseCiDispatchSource(raw: unknown): Parsed<CiDispatchSource> {
  if (!isRecord(raw)) return { ok: false, message: 'source must be an object, {} for the project’s whole suite.' };
  const keys = Object.keys(raw).filter((key) => raw[key] !== undefined);
  const unknown = keys.find((key) => !(SOURCE_KEYS as readonly string[]).includes(key));
  if (unknown) return { ok: false, message: `source has no key "${unknown}".` };
  const ids = ID_KEYS.filter((key) => keys.includes(key));
  if (ids.length > 1) {
    return { ok: false, message: 'source names one of clusterId, executionId, runId and testCaseId, not several.' };
  }
  const allowed: Record<string, readonly string[]> = {
    clusterId: ['clusterId'],
    executionId: ['executionId', 'scope'],
    runId: ['runId', 'tests'],
    testCaseId: ['testCaseId', 'flakeLab'],
    tags: ['tags', 'match'],
  };
  const named = ids[0] ?? (keys.includes('tags') ? 'tags' : undefined);
  const extra = keys.find((key) => !(named ? allowed[named]! : []).includes(key));
  if (extra) {
    return {
      ok: false,
      message: named ? `source has no key "${extra}" beside ${named}.` : `source has "${extra}" but names no place.`,
    };
  }
  if (!named) return { ok: true, value: { from: 'project' } };
  if (named === 'tags') {
    const tags = parseCiTags(raw.tags);
    if (!tags.ok) return tags;
    const match = raw.match ?? 'any';
    if (match !== 'any' && match !== 'all') return { ok: false, message: 'match must be any or all.' };
    return { ok: true, value: { from: 'tags', tags: tags.tags, match } };
  }
  const id = idOf(raw[named]);
  if (id === null) return { ok: false, message: `${named} must be a positive integer.` };
  switch (named) {
    case 'clusterId':
      return { ok: true, value: { from: 'cluster', clusterId: id } };
    case 'executionId': {
      const scope = raw.scope;
      if (scope !== 'test' && scope !== 'cluster') return { ok: false, message: 'scope must be test or cluster.' };
      return { ok: true, value: { from: 'execution', executionId: id, scope } };
    }
    case 'runId':
      if (raw.tests === undefined) return { ok: true, value: { from: 'run-suite', runId: id } };
      if (raw.tests !== 'failed')
        return { ok: false, message: 'tests must be failed, or left out for the whole suite.' };
      return { ok: true, value: { from: 'run-failed', runId: id } };
    case 'testCaseId': {
      const flakeLab = raw.flakeLab;
      if (flakeLab !== 'reproduce' && flakeLab !== 'verify') {
        return { ok: false, message: 'flakeLab must be reproduce or verify.' };
      }
      return { ok: true, value: { from: 'flake-lab', testCaseId: id, flakeLab } };
    }
  }
}

/** The kind of dispatch a source starts: its tests, a whole suite, tagged tests, or a Flake Lab experiment. */
export function ciDispatchSourceKind(source: CiDispatchSource): CiActionKind {
  switch (source.from) {
    case 'cluster':
    case 'execution':
    case 'run-failed':
      return 'tests';
    case 'run-suite':
    case 'project':
      return 'suite';
    case 'tags':
      return 'tags';
    case 'flake-lab':
      return 'flakeLab';
  }
}

/**
 * A source as the query keys of `GET /api/projects/:id/ci-actions/offered`: as it is, except tagged tests with no tag
 * picked yet, whose `tags` is an empty value, so the place reads as tagged tests.
 */
export function ciDispatchSourceQuery(source: CiDispatchSourceInput): Record<string, unknown> {
  return 'tags' in source && source.tags.length === 0 ? { ...source, tags: '' } : source;
}

/** Tests a re-run names at most: a cluster's affected tests, or a run's failed tests. */
export const MAX_RERUN_TESTS = 100;

/** The longest branch name, in UTF-8 bytes, a dispatch sends. */
export const MAX_CI_REF_BYTES = 255;

/**
 * Why a branch name cannot be sent, or null: the rules of
 * `git check-ref-format --branch`. Not empty, not `@` or `HEAD`, at most
 * {@link MAX_CI_REF_BYTES} bytes, no leading `-` or `/`, no trailing `/` or
 * `.`, no `..`, `//` or `@{`, no space, control character or any of
 * `~ ^ : ? * [ \`, and no part between `/` that starts with `.` or ends with
 * `.lock`.
 */
export function ciRefProblem(ref: string): string | null {
  const name = JSON.stringify(ref);
  if (ref === '') return 'The branch name is empty.';
  if (new TextEncoder().encode(ref).length > MAX_CI_REF_BYTES) {
    return `A branch name is at most ${MAX_CI_REF_BYTES} bytes.`;
  }
  if (ref === '@' || ref === 'HEAD') return `A branch cannot be named ${name}.`;
  if (ref.startsWith('-')) return `${name} is not a branch name: it starts with "-".`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) {
    return `${name} is not a branch name: it holds a space, a control character or one of ~ ^ : ? * [ \\.`;
  }
  if (ref.includes('..')) return `${name} is not a branch name: it holds "..".`;
  if (ref.includes('@{')) return `${name} is not a branch name: it holds "@{".`;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) {
    return `${name} is not a branch name: it starts or ends with "/", or holds "//".`;
  }
  if (ref.endsWith('.')) return `${name} is not a branch name: it ends with ".".`;
  if (ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return `${name} is not a branch name: a part between "/" starts with "." or ends with ".lock".`;
  }
  return null;
}

/**
 * How a target takes a branch: `list` for a repository host's CI, which runs
 * any branch of the repository; `typed` for a CI server request that names the
 * branch (a Jenkins job with `{branch}` in its path, a Custom request naming
 * `{{ref}}` or `{{branchJob}}`); `fixed` for one that runs its job's
 * configured branch.
 */
export type CiBranchMode = 'list' | 'typed' | 'fixed';

/** The request a CI server action sends, or null when it builds none. */
function ciServerRequestOf(target: CiActionTarget): CiRequestTemplate | null {
  if (target.type !== 'ci-server') return null;
  return ciServerRequestTemplate(ciServerTargetOf(target), 'rerun')?.template ?? null;
}

/** The branch mode of a target ({@link CiBranchMode}). */
export function ciBranchMode(target: CiActionTarget): CiBranchMode {
  return ciTargetDefinition(target.type).branchMode(target);
}

/** The branch a target runs when a dispatch names none; null when the target leaves it to the CI (Bitbucket, a fixed job). */
export function ciTargetRef(target: CiActionTarget): string | null {
  return ciTargetDefinition(target.type).defaultRef(target);
}

/**
 * Why an action cannot take this branch, or null: a target whose job runs its
 * configured branch takes none, and a branch a CI server path names must not
 * climb once the server decodes it ({@link segmentClimbsWhenDecoded}).
 */
export function ciActionRefProblem(action: CiAction, ref: string): string | null {
  const mode = ciBranchMode(action.target);
  if (mode === 'fixed') {
    return `The CI action "${action.name}" runs its job's configured branch, so it takes no branch.`;
  }
  const request = ciServerRequestOf(action.target);
  if (request && BRANCH_PLACEHOLDER.test(request.path) && segmentClimbsWhenDecoded(ref)) {
    return `${JSON.stringify(ref)} cannot go in the job's path: it climbs out of it once decoded.`;
  }
  return null;
}

/**
 * Why these inputs cannot be sent through an action, or null: a dispatch sets
 * only the action's choices, each to one of its options. A fixed input, and a
 * name the action does not declare, are refused.
 */
export function ciDispatchInputsProblem(action: CiAction, raw: unknown): string | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return 'inputs must be an object of input names and their values.';
  for (const [name, value] of Object.entries(raw)) {
    const input = action.inputs.find((i) => i.name === name);
    if (!input) return `The CI action "${action.name}" has no input "${name}".`;
    if (input.kind === 'fixed') return `The input "${name}" of "${action.name}" is fixed: it cannot be set.`;
    if (typeof value !== 'string' || !input.options.includes(value)) {
      return `${JSON.stringify(value)} is not an option of "${name}": pick one of ${input.options.join(', ')}.`;
    }
  }
  return null;
}

/** The action that started a source's run, and the values it was sent with. */
export interface CiDispatchStart {
  actionId: string;
  inputs: Record<string, string>;
}

/**
 * The inputs a dispatch sends: fixed values as set, and each choice the
 * request sets, else the value the dispatch that started the source's run sent
 * when it went through this action, else its default.
 */
export function ciDispatchInputValues(
  action: CiAction,
  chosen: Record<string, string> | null | undefined,
  started: CiDispatchStart | null | undefined,
): Record<string, string> {
  const fromStart = started && started.actionId === action.id ? started.inputs : {};
  return ciActionInputValues(action, { ...fromStart, ...(chosen ?? {}) });
}

/** What a dispatch request carries once read. */
export interface CiDispatchRequest {
  source: CiDispatchSource;
  /** An action id or exact name; null for the place's default (`pickCiAction`). */
  action: string | null;
  /** The branch to run on; null for the source run's, else the project's default, else the target's. */
  ref: string | null;
  /** The choices to set; null for their values from the source's run, else their defaults. */
  inputs: Record<string, string> | null;
}

const BODY_KEYS = ['action', 'kind', 'source', 'ref', 'inputs'];

/**
 * A `POST /api/projects/:id/ci-dispatches` body: `{ source, action?, kind?,
 * ref?, inputs? }`. Refuses a key the body does not take, a source of no shape
 * ({@link parseCiDispatchSource}), a `kind` its source does not start, an
 * `action` that is not a name, a branch git refuses ({@link ciRefProblem}) and
 * `inputs` that are not names and values. Whether the action takes the branch
 * and the inputs is checked against it.
 */
export function parseCiDispatchRequest(raw: unknown): Parsed<CiDispatchRequest> {
  if (!isRecord(raw)) return { ok: false, message: 'The body must be an object with a source.' };
  const unknown = Object.keys(raw).find((key) => !BODY_KEYS.includes(key));
  if (unknown) return { ok: false, message: `The body has no key "${unknown}".` };
  if (raw.source === undefined) return { ok: false, message: 'source is required: {} for the project’s whole suite.' };
  const source = parseCiDispatchSource(raw.source);
  if (!source.ok) return source;
  const parsed = ciDispatchRequestOf(source.value, raw);
  if (!parsed.ok) return parsed;
  if (raw.kind != null) {
    if (!(CI_ACTION_KINDS as readonly unknown[]).includes(raw.kind)) {
      return { ok: false, message: `kind must be one of ${CI_ACTION_KINDS.join(', ')}.` };
    }
    const kind = ciDispatchSourceKind(source.value);
    if (raw.kind !== kind) return { ok: false, message: `This source starts a ${kind} dispatch, not ${raw.kind}.` };
  }
  return parsed;
}

/** A source with the options a request or a tool may add to it: `action`, `ref` and `inputs`, checked as a body's. */
export function ciDispatchRequestOf(
  source: CiDispatchSource,
  raw: { action?: unknown; ref?: unknown; inputs?: unknown },
): Parsed<CiDispatchRequest> {
  let action: string | null = null;
  if (raw.action != null) {
    if (typeof raw.action !== 'string' || raw.action.length > MAX_ACTION_LENGTH) {
      return { ok: false, message: 'action must be a CI action id or name.' };
    }
    action = raw.action.trim() || null;
  }
  let ref: string | null = null;
  // An empty branch is none, as an empty action is.
  if (raw.ref != null && raw.ref !== '') {
    if (typeof raw.ref !== 'string') return { ok: false, message: 'ref must be a branch name.' };
    const problem = ciRefProblem(raw.ref);
    if (problem) return { ok: false, message: problem };
    ref = raw.ref;
  }
  let inputs: Record<string, string> | null = null;
  if (raw.inputs != null) {
    if (!isRecord(raw.inputs) || Object.values(raw.inputs).some((v) => typeof v !== 'string')) {
      return { ok: false, message: 'inputs must be an object of input names and their values.' };
    }
    inputs = raw.inputs as Record<string, string>;
  }
  return { ok: true, value: { source, action, ref, inputs } };
}

/** The message of an action a request names that the project does not have, or null. */
export function unknownCiActionMessage(settings: CiActionsSettings, name: string | null): string | null {
  if (!name) return null;
  return settings.actions.some((a) => a.id === name || a.name === name)
    ? null
    : `This project has no CI action "${name}".`;
}

/**
 * Why a request cannot go through the action picked for it, or null: tagged
 * tests that name no tag, a branch git refuses or the action cannot take, an
 * input it does not set.
 */
export function ciDispatchRequestProblem(pick: CiActionPick, request: CiDispatchRequest): string | null {
  if (request.source.from === 'tags' && request.source.tags.length === 0) {
    return 'A dispatch of tagged tests names at least one tag.';
  }
  const refProblem =
    request.ref == null
      ? null
      : (ciRefProblem(request.ref) ?? (pick.action ? ciActionRefProblem(pick.action, request.ref) : null));
  return refProblem ?? (pick.action ? ciDispatchInputsProblem(pick.action, request.inputs) : null);
}

/** An action as a place is offered it. */
export interface CiOfferedAction {
  id: string;
  name: string;
  /** Where it goes: the target's type, and how a row names it (`GitHub · e2e.yml`). */
  target: { type: CiActionTarget['type']; label: string };
  environment: string | null;
  /** How it takes a branch, and the branch a dispatch without one runs on (null: the job's or the CI's own). */
  branch: { mode: CiBranchMode; default: string | null };
  /** Its inputs, each choice's `default` being the value a dispatch that sets none sends. */
  inputs: CiActionInput[];
  available: boolean;
  /** Why it is not available. */
  reason: string | null;
}

/** What `GET /api/projects/:id/ci-actions/offered` answers. */
export interface CiOffered {
  /** Whether CI actions are on for the project. */
  enabled: boolean;
  kind: CiActionKind;
  /** The project's actions that accept the kind, in their order. */
  actions: CiOfferedAction[];
  /** The action a dispatch that names none uses, or null when none can be picked. */
  defaultActionId: string | null;
  /** The place's last dispatch the provider took: its cluster's, or its test's Flake Lab one. */
  lastDispatch: CiDispatchView | null;
}

/** An action's inputs as offered: each choice's default is what the source's run was sent with, when it used this action. */
function offeredInputs(action: CiAction, started: CiDispatchStart | null): CiActionInput[] {
  const values = ciDispatchInputValues(action, null, started);
  return action.inputs.map((input) => (input.kind === 'choice' ? { ...input, default: values[input.name]! } : input));
}

/** An action as a place is offered it, with its readiness for the place. */
export function offeredCiAction(
  action: CiAction,
  place: { branch: string | null; started: CiDispatchStart | null },
  ready: { available: boolean; reason: string | null },
): CiOfferedAction {
  const mode = ciBranchMode(action.target);
  return {
    id: action.id,
    name: action.name,
    target: { type: action.target.type, label: ciActionTargetSummary(action.target) },
    environment: action.environment ?? null,
    branch: { mode, default: mode === 'fixed' ? null : (place.branch ?? ciTargetRef(action.target)) },
    inputs: offeredInputs(action, place.started),
    available: ready.available,
    reason: ready.available ? null : ready.reason,
  };
}

/** Where a branch a dispatch may run on comes from: the project's runs, or the repository itself. */
export interface CiBranchOption {
  name: string;
  source: 'runs' | 'repository';
}

/** The most branches a list answers. */
export const MAX_CI_BRANCHES = 50;

/**
 * The branches a dispatch may run on: the run branches first, in their order,
 * then the repository's that are not among them, each kept once, those whose
 * name holds `q` (ignoring case and accents) only, at most
 * {@link MAX_CI_BRANCHES}.
 */
export function ciBranchOptions(
  runBranches: readonly string[],
  repositoryBranches: readonly string[],
  q?: string | null,
): CiBranchOption[] {
  const needle = foldText(q?.trim() ?? '');
  const seen = new Set<string>();
  const options: CiBranchOption[] = [];
  const add = (names: readonly string[], source: CiBranchOption['source']) => {
    for (const name of names) {
      if (options.length >= MAX_CI_BRANCHES) return;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (needle && !foldText(name).includes(needle)) continue;
      options.push({ name, source });
    }
  };
  add(runBranches, 'runs');
  add(repositoryBranches, 'repository');
  return options;
}
