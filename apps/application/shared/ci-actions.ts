/**
 * CI actions — a project's list of named ways to start CI.
 *
 * An action has its own target (a GitHub workflow, a GitLab pipeline, a
 * Bitbucket custom pipeline, or a CI server request), the inputs it sends
 * beside the Playwright arguments, what it accepts (re-runs of failed tests,
 * a whole suite, a Flake Lab experiment), an optional environment, and may be
 * the default for each kind. The list lives in the project's `ciRerun` column
 * as `{ enabled, actions, defaults }`. A stored value with no `actions` list
 * (`via`, a `ciServer` block, one block per provider) converts when read
 * ({@link ciActionsFromLegacy}) and is saved as actions.
 *
 * Pure + dependency-free (the server, the demo and the settings form share it):
 * what talks to a repository host or a CI server lives in `server/utils/`.
 */

import type { ScmProviderName } from '#shared/scm-urls';
import { resolveCiRerunSettings, type CiRerunSettings } from '#shared/ci-rerun';
import {
  CI_SERVER_PRESET_REGISTRY,
  ciServerTargetProblem,
  DEFAULT_ARGS_PARAMETER,
  DEFAULT_DISPATCH_PARAMETER,
  normalizeCiServerBaseUrl,
  resolveCiServerTarget,
  type CiRequestTemplate,
  type CiServerAuth,
  type CiServerPreset,
  type CiServerTarget,
} from '#shared/ci-server';

/** What an action may be started for. */
export const CI_ACTION_KINDS = ['tests', 'suite', 'flakeLab'] as const;
export type CiActionKind = (typeof CI_ACTION_KINDS)[number];

/** The kinds a project names a default action for, and the key each is stored under. */
export const CI_ACTION_DEFAULT_KEYS = { tests: 'rerun', suite: 'suite', flakeLab: 'flakeLab' } as const;

export const MAX_CI_ACTIONS = 20;
export const MAX_CI_ACTION_INPUTS = 20;
export const MAX_CI_ACTION_NAME_LENGTH = 80;
export const MAX_CI_ENVIRONMENT_LENGTH = 80;
export const MAX_CI_INPUT_VALUE_LENGTH = 500;
export const MAX_CI_CHOICE_OPTIONS = 50;

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** An input name: a GitHub input id, a GitLab or Bitbucket variable key and a Jenkins parameter all accept it. */
export const CI_INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** The variable names GitLab and Bitbucket reserve for the CI itself: an input may not set them. */
const RESERVED_VARIABLE_NAME = /^(CI_|GITLAB_|BITBUCKET_)/i;

/** An input an action sends beside the Playwright arguments: a fixed value, or one of a few options. */
export type CiActionInput =
  | { name: string; kind: 'fixed'; value: string }
  | { name: string; kind: 'choice'; options: string[]; default: string };

/** Where an action sends its request. */
export type CiActionTarget =
  | {
      type: 'github';
      /** Workflow file name (e.g. `e2e.yml`) or its numeric id. */
      workflow: string;
      /** The branch or tag the workflow runs on when the run has no branch. */
      ref: string;
      /** The `workflow_dispatch` input that receives the Playwright arguments. */
      argsInput: string;
      /** The input that receives the dispatch id, sent only when set. */
      dispatchIdInput?: string;
    }
  | { type: 'gitlab'; ref: string; argsVariable: string }
  | { type: 'bitbucket'; pipeline: string; argsVariable: string }
  | {
      type: 'ci-server';
      preset: CiServerPreset;
      baseUrl?: string;
      user?: string;
      /** The preset's fields (Jenkins: `job`, `argsParameter`, `dispatchParameter`, `ref`); Custom keeps only `ref`. */
      fields: Record<string, string>;
      /** Custom only: where the credential goes and the request to send. */
      custom?: { auth: CiServerAuth; request: CiRequestTemplate };
    };

export interface CiAction {
  /** Stable id, which a dispatch record and the MCP tool name. */
  id: string;
  /** Shown in the list; unique in the project, ignoring case. */
  name: string;
  target: CiActionTarget;
  inputs: CiActionInput[];
  accepts: CiActionKind[];
  /** The environment this action runs in; a run in that environment picks it first. */
  environment?: string;
}

export interface CiActionsSettings {
  /** Master switch. Off by default: dispatching CI needs an explicit opt-in. */
  enabled: boolean;
  actions: CiAction[];
  /** The action ids buttons use for each kind when no environment decides. */
  defaults: { rerun?: string; flakeLab?: string; suite?: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A new action id: eight hex characters. */
export function newCiActionId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The CI server target an action of type `ci-server` sends through, in the shape the CI server code reads. */
export function ciServerTargetOf(target: Extract<CiActionTarget, { type: 'ci-server' }>): CiServerTarget {
  return {
    preset: target.preset,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.user ? { user: target.user } : {}),
    rerun: target.fields,
    ...(target.custom ? { custom: { auth: target.custom.auth, rerun: target.custom.request } } : {}),
  };
}

/** The input names the target itself sends, which an action input may not reuse. */
export function builtInInputNames(target: CiActionTarget): string[] {
  switch (target.type) {
    case 'github':
      return [target.argsInput, ...(target.dispatchIdInput ? [target.dispatchIdInput] : [])];
    case 'gitlab':
    case 'bitbucket':
      return [target.argsVariable];
    case 'ci-server':
      return target.preset === 'custom'
        ? []
        : [
            target.fields.argsParameter || DEFAULT_ARGS_PARAMETER,
            target.fields.dispatchParameter || DEFAULT_DISPATCH_PARAMETER,
          ];
  }
}

/** A posted `ci-server` action target in the shape `resolveCiServerTarget` reads. */
function rawCiServerTarget(target: Record<string, unknown>): Record<string, unknown> {
  const custom = isRecord(target.custom) ? target.custom : null;
  return {
    preset: target.preset,
    baseUrl: target.baseUrl,
    user: target.user,
    rerun: target.fields,
    ...(custom ? { custom: { auth: custom.auth, rerun: custom.request } } : {}),
  };
}

/** A target from an untrusted payload, or null when it cannot dispatch. */
function resolveTarget(input: unknown): CiActionTarget | null {
  if (!isRecord(input)) return null;
  if (input.type === 'github') {
    const workflow = str(input.workflow);
    const ref = str(input.ref);
    const argsInput = str(input.argsInput);
    const dispatchIdInput = str(input.dispatchIdInput);
    if (!workflow || !ref || !argsInput) return null;
    return { type: 'github', workflow, ref, argsInput, ...(dispatchIdInput ? { dispatchIdInput } : {}) };
  }
  if (input.type === 'gitlab') {
    const ref = str(input.ref);
    const argsVariable = str(input.argsVariable);
    return ref && argsVariable ? { type: 'gitlab', ref, argsVariable } : null;
  }
  if (input.type === 'bitbucket') {
    const pipeline = str(input.pipeline);
    const argsVariable = str(input.argsVariable);
    return pipeline && argsVariable ? { type: 'bitbucket', pipeline, argsVariable } : null;
  }
  if (input.type === 'ci-server') {
    const resolved = resolveCiServerTarget(rawCiServerTarget(input));
    if (!resolved) return null;
    return {
      type: 'ci-server',
      preset: resolved.preset,
      ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
      ...(resolved.user ? { user: resolved.user } : {}),
      fields: resolved.rerun,
      ...(resolved.custom ? { custom: { auth: resolved.custom.auth, request: resolved.custom.rerun } } : {}),
    };
  }
  return null;
}

function resolveInputs(input: unknown, target: CiActionTarget): CiActionInput[] {
  if (!Array.isArray(input) || (target.type === 'ci-server' && target.preset === 'custom')) return [];
  const taken = new Set(builtInInputNames(target).map((n) => n.toLowerCase()));
  const out: CiActionInput[] = [];
  for (const raw of input) {
    if (out.length >= MAX_CI_ACTION_INPUTS || !isRecord(raw)) continue;
    const name = str(raw.name);
    if (!CI_INPUT_NAME.test(name) || taken.has(name.toLowerCase())) continue;
    if (raw.kind === 'fixed') {
      const value = typeof raw.value === 'string' ? raw.value.trim() : '';
      if (value.length > MAX_CI_INPUT_VALUE_LENGTH) continue;
      taken.add(name.toLowerCase());
      out.push({ name, kind: 'fixed', value });
    } else if (raw.kind === 'choice') {
      const options = [
        ...new Set(
          (Array.isArray(raw.options) ? raw.options : [])
            .map(str)
            .filter((o) => o !== '' && o.length <= MAX_CI_INPUT_VALUE_LENGTH),
        ),
      ].slice(0, MAX_CI_CHOICE_OPTIONS);
      if (options.length === 0) continue;
      const chosen = str(raw.default);
      taken.add(name.toLowerCase());
      out.push({ name, kind: 'choice', options, default: options.includes(chosen) ? chosen : options[0]! });
    }
  }
  return out;
}

/** One action from an untrusted payload, or null when it has no usable name or target. */
function resolveAction(input: unknown): CiAction | null {
  if (!isRecord(input)) return null;
  const name = str(input.name).slice(0, MAX_CI_ACTION_NAME_LENGTH);
  const target = resolveTarget(input.target);
  if (!name || !target) return null;
  const rawId = str(input.id);
  const accepts = CI_ACTION_KINDS.filter((kind) => Array.isArray(input.accepts) && input.accepts.includes(kind));
  const environment = str(input.environment).slice(0, MAX_CI_ENVIRONMENT_LENGTH);
  return {
    id: ACTION_ID.test(rawId) ? rawId : newCiActionId(),
    name,
    target,
    inputs: resolveInputs(input.inputs, target),
    accepts: accepts.length ? accepts : ['tests'],
    ...(environment ? { environment } : {}),
  };
}

/** The first action that accepts `kind`, or undefined. */
function firstAccepting(actions: CiAction[], kind: CiActionKind): CiAction | undefined {
  return actions.find((a) => a.accepts.includes(kind));
}

function resolveDefaults(input: unknown, actions: CiAction[]): CiActionsSettings['defaults'] {
  const raw = isRecord(input) ? input : {};
  const defaults: CiActionsSettings['defaults'] = {};
  for (const kind of CI_ACTION_KINDS) {
    const key = CI_ACTION_DEFAULT_KEYS[kind];
    const id = str(raw[key]);
    if (!id) continue;
    const found = actions.find((a) => a.id === id && a.accepts.includes(kind)) ?? firstAccepting(actions, kind);
    if (found) defaults[key] = found.id;
  }
  return defaults;
}

/** Whether a stored or posted value is in the actions shape (it has an `actions` list). */
export function hasCiActions(raw: unknown): raw is Record<string, unknown> & { actions: unknown[] } {
  return isRecord(raw) && Array.isArray(raw.actions);
}

const PROVIDER_LABEL: Record<ScmProviderName, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
const RERUN_NAME = 'Re-run failed tests';
const FLAKE_LAB_NAME = 'Flake Lab';

/** What names an action in a list that holds several: the host or the CI server preset it targets. */
function targetLabel(target: CiActionTarget): string {
  if (target.type !== 'ci-server') return PROVIDER_LABEL[target.type];
  return target.preset === 'custom' ? 'Custom request' : CI_SERVER_PRESET_REGISTRY[target.preset].label;
}

/**
 * The actions a stored value with no `actions` list stands for: a re-run
 * action for the CI server block and one for each provider block, and a Flake
 * Lab action for each Flake Lab target, so that nothing configured is lost.
 * Each kind's default is the action on the side `via` selects (the CI server
 * for `ci-server`, else the repository host).
 */
export function ciActionsFromLegacy(legacy: CiRerunSettings): CiActionsSettings {
  const server: { rerun: CiAction[]; flakeLab: CiAction[] } = { rerun: [], flakeLab: [] };
  const repository: { rerun: CiAction[]; flakeLab: CiAction[] } = { rerun: [], flakeLab: [] };
  const add = (list: CiAction[], id: string, target: CiActionTarget, kind: CiActionKind) => {
    list.push({ id, name: '', target, inputs: [], accepts: [kind] });
  };

  const ciServer = legacy.ciServer;
  if (ciServer) {
    const base = {
      type: 'ci-server' as const,
      preset: ciServer.preset,
      ...(ciServer.baseUrl ? { baseUrl: ciServer.baseUrl } : {}),
      ...(ciServer.user ? { user: ciServer.user } : {}),
    };
    add(
      server.rerun,
      'rerun-ci-server',
      {
        ...base,
        fields: ciServer.rerun,
        ...(ciServer.custom ? { custom: { auth: ciServer.custom.auth, request: ciServer.custom.rerun } } : {}),
      },
      'tests',
    );
    const ref: Record<string, string> = ciServer.rerun.ref ? { ref: ciServer.rerun.ref } : {};
    if (ciServer.custom?.flakeLab) {
      add(
        server.flakeLab,
        'flakelab-ci-server',
        { ...base, fields: ref, custom: { auth: ciServer.custom.auth, request: ciServer.custom.flakeLab } },
        'flakeLab',
      );
    } else if (ciServer.preset !== 'custom' && ciServer.flakeLab) {
      add(server.flakeLab, 'flakelab-ci-server', { ...base, fields: { ...ciServer.flakeLab, ...ref } }, 'flakeLab');
    }
  }

  const gh = legacy.github;
  const gl = legacy.gitlab;
  const bb = legacy.bitbucket;
  const lab = legacy.flakeLab;
  if (gh) {
    add(
      repository.rerun,
      'rerun-github',
      {
        type: 'github',
        workflow: gh.workflow,
        ref: gh.ref,
        argsInput: gh.inputName,
        ...(gh.dispatchIdInput ? { dispatchIdInput: gh.dispatchIdInput } : {}),
      },
      'tests',
    );
    if (lab?.github) {
      add(
        repository.flakeLab,
        'flakelab-github',
        { type: 'github', workflow: lab.github.workflow, ref: gh.ref, argsInput: lab.github.inputName },
        'flakeLab',
      );
    }
  }
  if (gl) {
    add(repository.rerun, 'rerun-gitlab', { type: 'gitlab', ref: gl.ref, argsVariable: gl.variableName }, 'tests');
    if (lab?.gitlab) {
      add(
        repository.flakeLab,
        'flakelab-gitlab',
        { type: 'gitlab', ref: gl.ref, argsVariable: lab.gitlab.variableName },
        'flakeLab',
      );
    }
  }
  if (bb) {
    add(
      repository.rerun,
      'rerun-bitbucket',
      { type: 'bitbucket', pipeline: bb.pipeline, argsVariable: bb.variableName },
      'tests',
    );
  }
  if (lab?.bitbucket) {
    add(
      repository.flakeLab,
      'flakelab-bitbucket',
      { type: 'bitbucket', pipeline: lab.bitbucket.pipeline, argsVariable: lab.bitbucket.variableName },
      'flakeLab',
    );
  }

  const sides = legacy.via === 'ci-server' ? [server, repository] : [repository, server];
  const rerun = sides.flatMap((side) => side.rerun);
  const flakeLab = sides.flatMap((side) => side.flakeLab);
  for (const [list, base] of [
    [rerun, RERUN_NAME],
    [flakeLab, FLAKE_LAB_NAME],
  ] as const) {
    for (const action of list) action.name = list.length > 1 ? `${base} · ${targetLabel(action.target)}` : base;
  }

  return {
    enabled: legacy.enabled,
    actions: [...rerun, ...flakeLab],
    defaults: {
      ...(rerun[0] ? { rerun: rerun[0].id } : {}),
      ...(flakeLab[0] ? { flakeLab: flakeLab[0].id } : {}),
    },
  };
}

/**
 * A project's CI actions from an untrusted or stored payload: the actions
 * shape, or a value that converts ({@link ciActionsFromLegacy}). Drops what cannot
 * dispatch (an action without a name or a complete target, a repeated id or
 * name, an input that is empty, repeated, or named like one the target
 * sends), and points a default that names no usable action at the first
 * action that accepts its kind.
 */
export function resolveCiActionsSettings(raw: unknown): CiActionsSettings {
  if (!isRecord(raw)) return { enabled: false, actions: [], defaults: {} };
  if (!hasCiActions(raw)) return ciActionsFromLegacy(resolveCiRerunSettings(raw as Partial<CiRerunSettings>));
  const actions: CiAction[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of raw.actions) {
    if (actions.length >= MAX_CI_ACTIONS) break;
    const action = resolveAction(entry);
    if (!action || ids.has(action.id) || names.has(action.name.toLowerCase())) continue;
    ids.add(action.id);
    names.add(action.name.toLowerCase());
    actions.push(action);
  }
  return { enabled: raw.enabled === true, actions, defaults: resolveDefaults(raw.defaults, actions) };
}

/** Why one posted input cannot be saved, or null: a name the target accepts, a value and options within the limits. */
function inputProblem(raw: unknown, taken: Set<string>, target: CiActionTarget): string | null {
  if (!isRecord(raw)) return 'An input is not an object.';
  const name = str(raw.name);
  if (!CI_INPUT_NAME.test(name)) {
    return `"${name}" is not a valid input name: use letters, digits and "_", not starting with a digit.`;
  }
  if (taken.has(name.toLowerCase())) return `The input "${name}" is sent twice: names must be unique.`;
  taken.add(name.toLowerCase());
  if ((target.type === 'gitlab' || target.type === 'bitbucket') && RESERVED_VARIABLE_NAME.test(name)) {
    return reservedInputMessage(name, target.type);
  }
  if (raw.kind === 'fixed') {
    if (typeof raw.value === 'string' && raw.value.trim().length > MAX_CI_INPUT_VALUE_LENGTH) {
      return `The value of "${name}" is longer than ${MAX_CI_INPUT_VALUE_LENGTH} characters.`;
    }
    return null;
  }
  if (raw.kind !== 'choice') return `The input "${name}" is neither a fixed value nor a choice.`;
  const options = (Array.isArray(raw.options) ? raw.options : []).map(str).filter((o) => o !== '');
  if (options.length === 0) return `The choice "${name}" needs at least one option.`;
  if (new Set(options).size > MAX_CI_CHOICE_OPTIONS) {
    return `The choice "${name}" has more than ${MAX_CI_CHOICE_OPTIONS} options.`;
  }
  if (options.some((o) => o.length > MAX_CI_INPUT_VALUE_LENGTH)) {
    return `An option of "${name}" is longer than ${MAX_CI_INPUT_VALUE_LENGTH} characters.`;
  }
  return null;
}

/** Why a posted action's inputs cannot be saved, or null. */
function inputsProblem(raw: unknown, target: CiActionTarget): string | null {
  if (raw == null || (target.type === 'ci-server' && target.preset === 'custom')) return null;
  if (!Array.isArray(raw)) return 'The inputs must be a list.';
  if (raw.length > MAX_CI_ACTION_INPUTS) return `An action can have at most ${MAX_CI_ACTION_INPUTS} inputs.`;
  const taken = new Set(builtInInputNames(target).map((n) => n.toLowerCase()));
  for (const entry of raw) {
    const problem = inputProblem(entry, taken, target);
    if (problem) return problem;
  }
  return null;
}

/**
 * Why a posted actions payload cannot be saved, or null when it can: more
 * actions than the limit, an action that has no usable name or target, a name
 * over its limit or one another action already has, a repeated id, an input
 * the target cannot send (a name it rejects, a repeat, a reserved variable, a
 * value or option over its limit), or a CI server target that cannot dispatch.
 */
export function ciActionsProblem(raw: unknown): string | null {
  if (!hasCiActions(raw)) return null;
  if (raw.actions.length > MAX_CI_ACTIONS) return `A project can have at most ${MAX_CI_ACTIONS} CI actions.`;
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entry of raw.actions) {
    const label = isRecord(entry) && str(entry.name) ? `"${str(entry.name)}"` : 'An action';
    const action = resolveAction(entry);
    if (!action) {
      const target = isRecord(entry) && isRecord(entry.target) ? entry.target : null;
      if (target?.type === 'ci-server') {
        const problem = ciServerTargetProblem(rawCiServerTarget(target));
        if (problem) return `${label}: ${problem}`;
      }
      return `${label} needs a name and a complete target.`;
    }
    const posted = entry as Record<string, unknown>;
    if (str(posted.name).length > MAX_CI_ACTION_NAME_LENGTH) {
      return `${label}: a name is at most ${MAX_CI_ACTION_NAME_LENGTH} characters.`;
    }
    if (str(posted.environment).length > MAX_CI_ENVIRONMENT_LENGTH) {
      return `${label}: an environment is at most ${MAX_CI_ENVIRONMENT_LENGTH} characters.`;
    }
    const postedId = str(posted.id);
    if (ACTION_ID.test(postedId)) {
      if (ids.has(postedId)) return `Two CI actions have the id "${postedId}": ids must be unique in a project.`;
      ids.add(postedId);
    }
    const inputs = inputsProblem(posted.inputs, action.target);
    if (inputs) return `${label}: ${inputs}`;
    const key = action.name.toLowerCase();
    if (names.has(key)) return `Two CI actions are named "${action.name}": names must be unique in a project.`;
    names.add(key);
  }
  return null;
}

/** Why an input name is refused on GitLab or Bitbucket: the CI itself reserves it. */
export function reservedInputMessage(name: string, provider: 'gitlab' | 'bitbucket' = 'gitlab'): string {
  return `The input "${name}" is a variable ${PROVIDER_LABEL[provider]} reserves: names starting with CI_, GITLAB_ or BITBUCKET_ cannot be set.`;
}

/** The first of an action's inputs that GitLab or Bitbucket reserve the name of, or null. */
export function reservedInputName(action: CiAction): string | null {
  if (action.target.type !== 'gitlab' && action.target.type !== 'bitbucket') return null;
  return action.inputs.find((input) => RESERVED_VARIABLE_NAME.test(input.name))?.name ?? null;
}

/** A short description of an action's target, for the list. */
export function ciActionTargetSummary(target: CiActionTarget): string {
  switch (target.type) {
    case 'github':
      return `GitHub · ${target.workflow}`;
    case 'gitlab':
      return 'GitLab pipeline';
    case 'bitbucket':
      return `Bitbucket · custom: ${target.pipeline}`;
    case 'ci-server':
      return target.preset === 'custom'
        ? 'Custom request'
        : `${CI_SERVER_PRESET_REGISTRY[target.preset].label} · ${target.fields.job ?? ''}`.trim();
  }
}

/** The label of each kind an action accepts. */
export const CI_ACTION_KIND_LABELS: Record<CiActionKind, string> = {
  tests: 'Re-runs',
  suite: 'Run on CI',
  flakeLab: 'Flake Lab',
};

/** The key of `defaults` an action is the default under, for each kind it is. */
export function ciActionDefaultKinds(settings: CiActionsSettings, actionId: string): CiActionKind[] {
  return CI_ACTION_KINDS.filter((kind) => settings.defaults[CI_ACTION_DEFAULT_KEYS[kind]] === actionId);
}

/** The inputs an action sends with a dispatch: fixed values as set, a choice as its default. */
export function ciActionInputValues(action: CiAction): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of action.inputs) values[input.name] = input.kind === 'fixed' ? input.value : input.default;
  return values;
}

/** What {@link pickCiAction} found: the action to use, or why none can be. */
export type CiActionPick = { action: CiAction; reason: null } | { action: null; reason: string };

/** Whether an action can serve a run whose repository is on `provider` (null: no supported repository). */
function servesProvider(action: CiAction, provider: ScmProviderName | null): boolean {
  return action.target.type === 'ci-server' || action.target.type === provider;
}

/** What each kind is started for, in a sentence about the absence of an action. */
const KIND_PHRASE: Record<CiActionKind, string> = {
  tests: 're-runs tests',
  suite: 'runs the suite',
  flakeLab: 'runs Flake Lab',
};

/**
 * The action a dispatch of `kind` uses. Among the actions that accept the kind
 * and can serve the run (a GitHub, GitLab or Bitbucket action only a run whose
 * repository is on that host; a CI server action always), the one whose
 * environment is the run's, else the default for the kind, else the first.
 * `actionId` (an id or an exact name) names one instead, which must accept the
 * kind and serve the run too.
 */
export function pickCiAction(
  settings: CiActionsSettings,
  kind: CiActionKind,
  run: { provider: ScmProviderName | null; environment?: string | null; actionId?: string | null },
): CiActionPick {
  const requested = run.actionId?.trim();
  if (requested) {
    const named =
      settings.actions.find((a) => a.id === requested) ?? settings.actions.find((a) => a.name === requested);
    if (!named) return { action: null, reason: `This project has no CI action "${requested}".` };
    if (!named.accepts.includes(kind)) {
      return { action: null, reason: `The CI action "${named.name}" does not accept ${CI_ACTION_KIND_LABELS[kind]}.` };
    }
    if (!servesProvider(named, run.provider)) {
      return { action: null, reason: `The CI action "${named.name}" does not serve this run's repository.` };
    }
    return { action: named, reason: null };
  }
  const accepting = settings.actions.filter((a) => a.accepts.includes(kind));
  if (accepting.length === 0) {
    return { action: null, reason: `No CI action ${KIND_PHRASE[kind]} for this project.` };
  }
  const serving = accepting.filter((a) => servesProvider(a, run.provider));
  if (serving.length === 0) {
    return {
      action: null,
      reason: run.provider
        ? `No CI action ${KIND_PHRASE[kind]} for a ${PROVIDER_LABEL[run.provider]} repository.`
        : 'Its run has no supported repository to dispatch to.',
    };
  }
  const environment = run.environment?.trim();
  const byEnvironment = environment ? serving.find((a) => a.environment === environment) : undefined;
  const defaultId = settings.defaults[CI_ACTION_DEFAULT_KEYS[kind]];
  const action = byEnvironment ?? serving.find((a) => a.id === defaultId) ?? serving[0]!;
  return { action, reason: null };
}

/** What Check found for one action: `ok` null when the target cannot be checked at all. */
export interface CiActionCheckResult {
  ok: boolean | null;
  /** The names a dispatch sends that the target does not declare. */
  missing: string[];
  message: string;
}

/** The input and argument names a dispatch of this action sends, which the target must declare. */
export function ciActionSentNames(action: CiAction): string[] {
  return [...builtInInputNames(action.target), ...action.inputs.map((i) => i.name)];
}

/**
 * The one CI server base URL the project's token may be bound to: the URL
 * every CI server action sends under (its own, else the instance's). The token
 * is one value for the project, so it cannot be saved while the actions use
 * more than one URL. With no CI server action it is the instance's URL.
 */
export function ciServerTokenBinding(
  settings: CiActionsSettings,
  instanceUrl: string | null,
): { url: string; error: null } | { url: null; error: string } {
  const urls = new Set<string>();
  for (const action of settings.actions) {
    if (action.target.type !== 'ci-server') continue;
    const url = normalizeCiServerBaseUrl(action.target.baseUrl) ?? instanceUrl;
    if (url) urls.add(url);
  }
  if (urls.size > 1) {
    return {
      url: null,
      error: `The CI server actions send to ${urls.size} different base URLs (${[...urls].join(', ')}), and the token is bound to one: give them the same base URL, or save the token while one is in use.`,
    };
  }
  const url = [...urls][0] ?? instanceUrl;
  return url ? { url, error: null } : { url: null, error: 'Set the CI server base URL before saving its token' };
}
