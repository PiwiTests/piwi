/**
 * The editable form of one CI action: the draft an action opens as, and the
 * action a save sends, or why it cannot be saved.
 */
import {
  CI_ACTION_DEFAULT_KEYS,
  CI_ACTION_KINDS,
  MAX_CI_ACTION_INPUTS,
  builtInInputNames,
  newCiActionId,
  type CiAction,
  type CiActionInput,
  type CiActionKind,
  type CiActionTarget,
  type CiActionsSettings,
} from '#shared/ci-actions';
import type { ScmProviderName } from '#shared/scm-urls';
import {
  ciActionTargetFromForm,
  ciServerFormFromAction,
  ciServerFormState,
  type CiServerFormState,
} from '~/utils/ci-server-form';

/** The target types the editor offers, as the type select lists them. */
export const CI_ACTION_TARGET_ITEMS = [
  { label: 'GitHub workflow', value: 'github' },
  { label: 'GitLab pipeline', value: 'gitlab' },
  { label: 'Bitbucket custom pipeline', value: 'bitbucket' },
  { label: 'Jenkins job', value: 'jenkins' },
  { label: 'Custom request', value: 'custom' },
] as const;

/** The editor's target type: the three repository hosts, then the two CI server presets. */
export type CiActionFormType = ScmProviderName | 'jenkins' | 'custom';

export interface CiActionInputDraft {
  /** A key that stays with the row while its name is edited. */
  key: number;
  name: string;
  kind: 'fixed' | 'choice';
  value: string;
  /** One option per line. */
  options: string;
  default: string;
}

export interface CiActionDraft {
  id: string;
  name: string;
  type: CiActionFormType;
  github: { workflow: string; ref: string; argsInput: string; dispatchIdInput: string };
  gitlab: { ref: string; argsVariable: string };
  bitbucket: { pipeline: string; argsVariable: string };
  ciServer: CiServerFormState;
  inputs: CiActionInputDraft[];
  accepts: CiActionKind[];
  environment: string;
  /** The kinds this action is the default for. */
  defaultFor: CiActionKind[];
}

let inputKey = 0;

function inputDraft(input?: CiActionInput): CiActionInputDraft {
  const key = ++inputKey;
  if (input?.kind === 'choice') {
    return {
      key,
      name: input.name,
      kind: 'choice',
      value: '',
      options: input.options.join('\n'),
      default: input.default,
    };
  }
  return {
    key,
    name: input?.name ?? '',
    kind: 'fixed',
    value: input?.kind === 'fixed' ? input.value : '',
    options: '',
    default: '',
  };
}

/** A new, empty input row. */
export const newInputDraft = () => inputDraft();

function formType(target: CiActionTarget | undefined): CiActionFormType {
  if (!target) return 'github';
  if (target.type !== 'ci-server') return target.type;
  return target.preset === 'custom' ? 'custom' : 'jenkins';
}

/** The draft an action opens as, with the kinds it is the default for; `null` starts a new GitHub action. */
export function ciActionDraft(action: CiAction | null, settings?: CiActionsSettings): CiActionDraft {
  const target = action?.target;
  const defaultFor =
    action && settings
      ? CI_ACTION_KINDS.filter((kind) => settings.defaults[CI_ACTION_DEFAULT_KEYS[kind]] === action.id)
      : [];
  return {
    id: action?.id ?? newCiActionId(),
    name: action?.name ?? '',
    type: formType(target),
    github: {
      workflow: target?.type === 'github' ? target.workflow : '',
      ref: target?.type === 'github' ? target.ref : 'main',
      argsInput: target?.type === 'github' ? target.argsInput : 'args',
      dispatchIdInput: target?.type === 'github' ? (target.dispatchIdInput ?? '') : '',
    },
    gitlab: {
      ref: target?.type === 'gitlab' ? target.ref : 'main',
      argsVariable: target?.type === 'gitlab' ? target.argsVariable : 'PIWI_RERUN_ARGS',
    },
    bitbucket: {
      pipeline: target?.type === 'bitbucket' ? target.pipeline : '',
      argsVariable: target?.type === 'bitbucket' ? target.argsVariable : 'PIWI_RERUN_ARGS',
    },
    ciServer: target?.type === 'ci-server' ? ciServerFormFromAction(target) : ciServerFormState(null),
    inputs: (action?.inputs ?? []).map(inputDraft),
    accepts: action ? [...action.accepts] : ['tests'],
    environment: action?.environment ?? '',
    defaultFor,
  };
}

const lines = (text: string) => [
  ...new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

/** The inputs a draft sends, or the first problem in them. */
function inputsFromDraft(
  draft: CiActionDraft,
  target: CiActionTarget,
): { inputs: CiActionInput[]; error: string | null } {
  if (target.type === 'ci-server' && target.preset === 'custom') return { inputs: [], error: null };
  const taken = new Set(builtInInputNames(target).map((n) => n.toLowerCase()));
  const inputs: CiActionInput[] = [];
  for (const row of draft.inputs) {
    const name = row.name.trim();
    if (!name && !row.value.trim() && !row.options.trim()) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(name)) {
      return { inputs, error: `"${name}" is not a valid input name: use letters, digits, ".", "-" and "_".` };
    }
    if (taken.has(name.toLowerCase())) {
      return { inputs, error: `The input "${name}" is already sent by this action: names must be unique.` };
    }
    taken.add(name.toLowerCase());
    if (row.kind === 'fixed') {
      inputs.push({ name, kind: 'fixed', value: row.value.trim() });
    } else {
      const options = lines(row.options);
      if (options.length === 0) return { inputs, error: `The choice "${name}" needs at least one option.` };
      const chosen = row.default.trim();
      inputs.push({ name, kind: 'choice', options, default: options.includes(chosen) ? chosen : options[0]! });
    }
  }
  if (inputs.length > MAX_CI_ACTION_INPUTS) {
    return { inputs, error: `An action can have at most ${MAX_CI_ACTION_INPUTS} inputs.` };
  }
  return { inputs, error: null };
}

/** The target a draft sends, or what is missing from it. */
function targetFromDraft(
  draft: CiActionDraft,
  instanceUrl: string | null,
): { target: CiActionTarget; error: null } | { target: null; error: string } {
  if (draft.type === 'github') {
    const { workflow, ref, argsInput, dispatchIdInput } = draft.github;
    if (!workflow.trim()) return { target: null, error: 'GitHub needs the workflow file to dispatch.' };
    if (!ref.trim()) return { target: null, error: 'GitHub needs the ref the workflow runs on.' };
    if (!argsInput.trim()) return { target: null, error: 'GitHub needs the input that receives the arguments.' };
    return {
      target: {
        type: 'github',
        workflow: workflow.trim(),
        ref: ref.trim(),
        argsInput: argsInput.trim(),
        ...(dispatchIdInput.trim() ? { dispatchIdInput: dispatchIdInput.trim() } : {}),
      },
      error: null,
    };
  }
  if (draft.type === 'gitlab') {
    if (!draft.gitlab.ref.trim() || !draft.gitlab.argsVariable.trim()) {
      return { target: null, error: 'GitLab needs a ref and the variable that receives the arguments.' };
    }
    return {
      target: { type: 'gitlab', ref: draft.gitlab.ref.trim(), argsVariable: draft.gitlab.argsVariable.trim() },
      error: null,
    };
  }
  if (draft.type === 'bitbucket') {
    if (!draft.bitbucket.pipeline.trim() || !draft.bitbucket.argsVariable.trim()) {
      return {
        target: null,
        error: 'Bitbucket needs the custom pipeline and the variable that receives the arguments.',
      };
    }
    return {
      target: {
        type: 'bitbucket',
        pipeline: draft.bitbucket.pipeline.trim(),
        argsVariable: draft.bitbucket.argsVariable.trim(),
      },
      error: null,
    };
  }
  return ciActionTargetFromForm({ ...draft.ciServer, preset: draft.type }, { instanceUrl });
}

/**
 * The action a draft saves, or why it cannot be saved: a name no other action
 * has, a complete target, inputs with valid names, and at least one kind it
 * accepts.
 */
export function ciActionFromDraft(
  draft: CiActionDraft,
  opts: { otherNames: string[]; instanceUrl: string | null },
): { action: CiAction; error: null } | { action: null; error: string } {
  const name = draft.name.trim();
  if (!name) return { action: null, error: 'Give the action a name.' };
  if (opts.otherNames.some((other) => other.toLowerCase() === name.toLowerCase())) {
    return { action: null, error: `Another action is named "${name}": names must be unique.` };
  }
  const target = targetFromDraft(draft, opts.instanceUrl);
  if (!target.target) return { action: null, error: target.error };
  const inputs = inputsFromDraft(draft, target.target);
  if (inputs.error) return { action: null, error: inputs.error };
  if (draft.accepts.length === 0) return { action: null, error: 'Choose what the action accepts.' };
  const environment = draft.environment.trim();
  return {
    action: {
      id: draft.id,
      name,
      target: target.target,
      inputs: inputs.inputs,
      accepts: CI_ACTION_KINDS.filter((kind) => draft.accepts.includes(kind)),
      ...(environment ? { environment } : {}),
    },
    error: null,
  };
}
