/**
 * CI actions — a project's list of named ways to start CI.
 *
 * An action has its own target (a GitHub workflow, a GitLab pipeline, a
 * Bitbucket custom pipeline, or a CI server request), the inputs it sends
 * beside the Playwright arguments, what it accepts (re-runs of failed tests,
 * a whole suite, a Flake Lab experiment), an optional environment, and may be
 * the default for each kind. The list lives in the project's `ciRerun` column
 * as `{ enabled, actions, defaults }`. A value in the original shape
 * (`via`, one block per provider) is converted when read
 * ({@link ciActionsFromLegacy}) and saved in this shape.
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
const MAX_NAME_LENGTH = 80;
const MAX_ENVIRONMENT_LENGTH = 80;
const MAX_INPUT_VALUE_LENGTH = 500;
const MAX_CHOICE_OPTIONS = 50;

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;

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
    if (!INPUT_NAME.test(name) || taken.has(name.toLowerCase())) continue;
    if (raw.kind === 'fixed') {
      const value = typeof raw.value === 'string' ? raw.value.trim() : '';
      if (value.length > MAX_INPUT_VALUE_LENGTH) continue;
      taken.add(name.toLowerCase());
      out.push({ name, kind: 'fixed', value });
    } else if (raw.kind === 'choice') {
      const options = [
        ...new Set(
          (Array.isArray(raw.options) ? raw.options : [])
            .map(str)
            .filter((o) => o !== '' && o.length <= MAX_INPUT_VALUE_LENGTH),
        ),
      ].slice(0, MAX_CHOICE_OPTIONS);
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
  const name = str(input.name).slice(0, MAX_NAME_LENGTH);
  const target = resolveTarget(input.target);
  if (!name || !target) return null;
  const rawId = str(input.id);
  const accepts = CI_ACTION_KINDS.filter((kind) => Array.isArray(input.accepts) && input.accepts.includes(kind));
  const environment = str(input.environment).slice(0, MAX_ENVIRONMENT_LENGTH);
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

/**
 * The actions a value in the original shape stands for: one re-run
 * action per configured provider (or for the CI server), and one Flake Lab
 * action for each Flake Lab target, each the default for its kind.
 */
export function ciActionsFromLegacy(legacy: CiRerunSettings): CiActionsSettings {
  const rerun: CiAction[] = [];
  const flakeLab: CiAction[] = [];
  const add = (list: CiAction[], id: string, name: string, target: CiActionTarget, kind: CiActionKind) => {
    list.push({ id, name, target, inputs: [], accepts: [kind] });
  };

  if (legacy.via === 'ci-server') {
    const server = legacy.ciServer;
    if (server) {
      const base = {
        type: 'ci-server' as const,
        preset: server.preset,
        ...(server.baseUrl ? { baseUrl: server.baseUrl } : {}),
        ...(server.user ? { user: server.user } : {}),
      };
      add(
        rerun,
        'rerun-ci-server',
        RERUN_NAME,
        {
          ...base,
          fields: server.rerun,
          ...(server.custom ? { custom: { auth: server.custom.auth, request: server.custom.rerun } } : {}),
        },
        'tests',
      );
      const ref: Record<string, string> = server.rerun.ref ? { ref: server.rerun.ref } : {};
      if (server.custom?.flakeLab) {
        add(
          flakeLab,
          'flakelab-ci-server',
          FLAKE_LAB_NAME,
          { ...base, fields: ref, custom: { auth: server.custom.auth, request: server.custom.flakeLab } },
          'flakeLab',
        );
      } else if (server.preset !== 'custom' && server.flakeLab) {
        add(
          flakeLab,
          'flakelab-ci-server',
          FLAKE_LAB_NAME,
          { ...base, fields: { ...server.flakeLab, ...ref } },
          'flakeLab',
        );
      }
    }
  } else {
    const gh = legacy.github;
    const gl = legacy.gitlab;
    const bb = legacy.bitbucket;
    const lab = legacy.flakeLab;
    if (gh) {
      add(
        rerun,
        'rerun-github',
        '',
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
          flakeLab,
          'flakelab-github',
          '',
          { type: 'github', workflow: lab.github.workflow, ref: gh.ref, argsInput: lab.github.inputName },
          'flakeLab',
        );
      }
    }
    if (gl) {
      add(rerun, 'rerun-gitlab', '', { type: 'gitlab', ref: gl.ref, argsVariable: gl.variableName }, 'tests');
      if (lab?.gitlab) {
        add(
          flakeLab,
          'flakelab-gitlab',
          '',
          { type: 'gitlab', ref: gl.ref, argsVariable: lab.gitlab.variableName },
          'flakeLab',
        );
      }
    }
    if (bb) {
      add(
        rerun,
        'rerun-bitbucket',
        '',
        { type: 'bitbucket', pipeline: bb.pipeline, argsVariable: bb.variableName },
        'tests',
      );
    }
    if (lab?.bitbucket) {
      add(
        flakeLab,
        'flakelab-bitbucket',
        '',
        { type: 'bitbucket', pipeline: lab.bitbucket.pipeline, argsVariable: lab.bitbucket.variableName },
        'flakeLab',
      );
    }
    for (const [list, base] of [
      [rerun, RERUN_NAME],
      [flakeLab, FLAKE_LAB_NAME],
    ] as const) {
      for (const action of list) {
        const provider = action.target.type as ScmProviderName;
        action.name = list.length > 1 ? `${base} · ${PROVIDER_LABEL[provider]}` : base;
      }
    }
  }

  const actions = [...rerun, ...flakeLab];
  return {
    enabled: legacy.enabled,
    actions,
    defaults: {
      ...(rerun[0] ? { rerun: rerun[0].id } : {}),
      ...(flakeLab[0] ? { flakeLab: flakeLab[0].id } : {}),
    },
  };
}

/**
 * A project's CI actions from an untrusted or stored payload: the actions
 * shape, or a value in the original shape. Drops what cannot
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

/**
 * Why a posted actions payload cannot be saved, or null when it can: more
 * actions than the limit, an action that has no usable name or target, a name
 * another action already has, or a CI server target that cannot dispatch.
 */
export function ciActionsProblem(raw: unknown): string | null {
  if (!hasCiActions(raw)) return null;
  if (raw.actions.length > MAX_CI_ACTIONS) return `A project can have at most ${MAX_CI_ACTIONS} CI actions.`;
  const names = new Set<string>();
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
    const key = action.name.toLowerCase();
    if (names.has(key)) return `Two CI actions are named "${action.name}": names must be unique in a project.`;
    names.add(key);
  }
  return null;
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
