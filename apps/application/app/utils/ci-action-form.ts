/**
 * The editable form of one CI action: the draft an action opens as, and the
 * action a save sends, or why it cannot be saved.
 */
import {
  CI_ACTION_DEFAULT_KEYS,
  CI_ACTION_KINDS,
  CI_INPUT_NAME,
  MAX_CI_ACTION_INPUTS,
  MAX_CI_ACTION_NAME_LENGTH,
  MAX_CI_CHOICE_OPTIONS,
  MAX_CI_ENVIRONMENT_LENGTH,
  MAX_CI_INPUT_VALUE_LENGTH,
  builtInInputNames,
  isReservedVariableName,
  newCiActionId,
  reservedInputMessage,
  reservedInputName,
  type CiAction,
  type CiActionCheckResult,
  type CiActionInput,
  type CiActionKind,
  type CiActionTarget,
  type CiActionsSettings,
} from '#shared/ci-actions';
import { DEFAULT_ARGS_PARAMETER, DEFAULT_DISPATCH_PARAMETER } from '#shared/ci-server';
import { missingRequiredFields, type CiJob, type CiJobField } from '#shared/ci-job-fields';
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
  /** The SCM credential a GitHub, GitLab or Bitbucket action's dispatch carries; null for the project's. */
  scmCredentialId: number | null;
  ciServer: CiServerFormState;
  inputs: CiActionInputDraft[];
  accepts: CiActionKind[];
  /** The environment's label as written: its key when picked from the project's environments. */
  environment: string;
  /** The environment picked, one of the project's; null for any environment. */
  environmentId: number | null;
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

/**
 * The input row a declared field adds: a choice or a boolean as a choice of
 * its options with its default, any other field as a fixed value holding its
 * default (empty for a secret, whose default is never read).
 */
export function inputDraftFromField(field: CiJobField): CiActionInputDraft {
  const row = inputDraft();
  row.name = field.name;
  if (field.options?.length) {
    row.kind = 'choice';
    row.options = field.options.join('\n');
    row.default = field.default ?? '';
  } else {
    row.value = field.default ?? '';
  }
  return row;
}

/** One choice of a value the target declares, as the editor's menus list it. */
export interface CiDeclaredItem {
  label: string;
  value: string;
  description?: string;
}

/** A job as a menu lists it: its label, and its file name when the label is a workflow's name. */
export function jobItem(job: CiJob): CiDeclaredItem {
  return { label: job.label, value: job.id, ...(job.description ? { description: job.description } : {}) };
}

/** What a menu says of a field beside its name: its type, whether it is required, and its description. */
export function fieldSummary(field: CiJobField): string {
  return [field.type, field.required ? 'required' : null, field.description].filter(Boolean).join(' · ');
}

/** A field as a menu lists it. */
export function fieldItem(field: CiJobField): CiDeclaredItem {
  return { label: field.name, value: field.name, description: fieldSummary(field) };
}

/** The targets the editor posts to read what the draft's target declares. */
export interface CiListingRequests {
  /** The draft's target type: another type lists other things. */
  type: CiActionFormType;
  /** The target to list the jobs of, without the job picked; null when the target has no job to pick (GitLab). */
  jobs: Record<string, unknown> | null;
  /** The target to list the fields of: once a job is picked, and always for GitLab, whose fields are its CI file's. */
  fields: Record<string, unknown> | null;
}

/** What the editor posts to read the draft's target; null for a Custom request, which lists nothing. */
export function ciListingRequestsOfDraft(draft: CiActionDraft): CiListingRequests | null {
  const credentialId = draft.scmCredentialId ?? undefined;
  switch (draft.type) {
    case 'github': {
      const workflow = draft.github.workflow.trim();
      const target = { type: 'github', ref: draft.github.ref.trim(), workflow, credentialId };
      return { type: draft.type, jobs: { ...target, workflow: '' }, fields: workflow ? target : null };
    }
    case 'gitlab':
      return {
        type: draft.type,
        jobs: null,
        fields: { type: 'gitlab', ref: draft.gitlab.ref.trim(), credentialId },
      };
    case 'bitbucket': {
      const pipeline = draft.bitbucket.pipeline.trim();
      const target = { type: 'bitbucket', pipeline, credentialId };
      return { type: draft.type, jobs: { ...target, pipeline: '' }, fields: pipeline ? target : null };
    }
    case 'jenkins': {
      const job = draft.ciServer.rerun.job.trim();
      const server = {
        type: 'ci-server',
        preset: 'jenkins',
        baseUrl: draft.ciServer.baseUrl.trim(),
        credentialId: draft.ciServer.credentialId ?? undefined,
      };
      return {
        type: draft.type,
        // The jobs under the base URL, whichever job and branch are typed.
        jobs: { ...server, fields: { job: '', ref: '' } },
        fields: job ? { ...server, fields: { job, ref: draft.ciServer.rerun.ref.trim() } } : null,
      };
    }
    case 'custom':
      return null;
  }
}

/** The job the draft names (a workflow, a custom pipeline, a Jenkins job), empty when none is picked or the target has none. */
export function draftJob(draft: CiActionDraft): string {
  if (draft.type === 'github') return draft.github.workflow.trim();
  if (draft.type === 'bitbucket') return draft.bitbucket.pipeline.trim();
  if (draft.type === 'jenkins') return draft.ciServer.rerun.job.trim();
  return '';
}

/** The names that receive the arguments and the dispatch id in the draft, as a dispatch sends them. */
export function draftBuiltInNames(draft: CiActionDraft): string[] {
  switch (draft.type) {
    case 'github':
      return [draft.github.argsInput.trim(), draft.github.dispatchIdInput.trim()].filter(Boolean);
    case 'gitlab':
      return [draft.gitlab.argsVariable.trim()].filter(Boolean);
    case 'bitbucket':
      return [draft.bitbucket.argsVariable.trim()].filter(Boolean);
    case 'jenkins':
      return [
        draft.ciServer.rerun.argsParameter.trim() || DEFAULT_ARGS_PARAMETER,
        draft.ciServer.rerun.dispatchParameter.trim() || DEFAULT_DISPATCH_PARAMETER,
      ];
    case 'custom':
      return [];
  }
}

/** Every name a dispatch of the draft sends: the arguments and dispatch id inputs, then its inputs. */
export function draftSentNames(draft: CiActionDraft): string[] {
  return [...draftBuiltInNames(draft), ...draft.inputs.map((row) => row.name.trim()).filter(Boolean)];
}

/** The declared fields an input row may still name: valid input names the draft does not send yet, none the CI reserves. */
export function fieldsToAdd(draft: CiActionDraft, fields: CiJobField[]): CiJobField[] {
  const sent = new Set(draftSentNames(draft).map((name) => name.toLowerCase()));
  const reservedHost = draft.type === 'gitlab' || draft.type === 'bitbucket';
  return fields.filter(
    (f) =>
      CI_INPUT_NAME.test(f.name) &&
      !sent.has(f.name.toLowerCase()) &&
      !(reservedHost && isReservedVariableName(f.name)),
  );
}

/** The name that receives the arguments in the draft: empty when unset, the reporter's variable for an empty Jenkins one. */
export function draftArgsName(draft: CiActionDraft): string {
  switch (draft.type) {
    case 'github':
      return draft.github.argsInput.trim();
    case 'gitlab':
      return draft.gitlab.argsVariable.trim();
    case 'bitbucket':
      return draft.bitbucket.argsVariable.trim();
    case 'jenkins':
      return draft.ciServer.rerun.argsParameter.trim() || DEFAULT_ARGS_PARAMETER;
    case 'custom':
      return '';
  }
}

function setDraftArgsName(draft: CiActionDraft, name: string) {
  if (draft.type === 'github') draft.github.argsInput = name;
  else if (draft.type === 'gitlab') draft.gitlab.argsVariable = name;
  else if (draft.type === 'bitbucket') draft.bitbucket.argsVariable = name;
  else if (draft.type === 'jenkins') draft.ciServer.rerun.argsParameter = name;
}

/** The fields the job requires with no default that the draft does not send and can add as inputs. */
export function requiredFieldsToAdd(draft: CiActionDraft, fields: CiJobField[]): CiJobField[] {
  return fieldsToAdd(draft, missingRequiredFields(fields, draftSentNames(draft)));
}

/**
 * Fill the draft from what a job picked in the editor declares: the arguments
 * input, when the draft's is not one the job declares and the job declares
 * `args` or the reporter's variable; then the inputs it requires with no
 * default that the draft can send.
 */
export function fillFromDeclared(draft: CiActionDraft, fields: CiJobField[]): void {
  const current = draftArgsName(draft);
  if (!fields.some((f) => f.name === current)) {
    const declared = fields.find((f) => f.name === 'args' || f.name === DEFAULT_ARGS_PARAMETER)?.name;
    if (declared) setDraftArgsName(draft, declared);
  }
  for (const field of requiredFieldsToAdd(draft, fields)) draft.inputs.push(inputDraftFromField(field));
}

/**
 * The inputs a request preview shows: each named row with the value a
 * dispatch that picks none sends; none for a Custom request, which sends none.
 */
export function previewInputPairs(draft: CiActionDraft): [string, string][] {
  if (draft.type === 'custom') return [];
  return draft.inputs.flatMap((row): [string, string][] => {
    const name = row.name.trim();
    if (!name) return [];
    if (row.kind === 'fixed') return [[name, row.value.trim()]];
    const options = lines(row.options);
    return [[name, options.includes(row.default.trim()) ? row.default.trim() : (options[0] ?? '')]];
  });
}

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
    scmCredentialId: target && target.type !== 'ci-server' ? (target.credentialId ?? null) : null,
    ciServer: target?.type === 'ci-server' ? ciServerFormFromAction(target) : ciServerFormState(null),
    inputs: (action?.inputs ?? []).map(inputDraft),
    accepts: action ? [...action.accepts] : ['tests'],
    environment: action?.environment ?? '',
    environmentId: action?.environmentId ?? null,
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
    if (!CI_INPUT_NAME.test(name)) {
      return {
        inputs,
        error: `"${name}" is not a valid input name: start with a letter or "_", then letters, digits and "_" (at most 100).`,
      };
    }
    if (taken.has(name.toLowerCase())) {
      return { inputs, error: `The input "${name}" is already sent by this action: names must be unique.` };
    }
    taken.add(name.toLowerCase());
    if (row.kind === 'fixed') {
      if (row.value.trim().length > MAX_CI_INPUT_VALUE_LENGTH) {
        return { inputs, error: `The value of "${name}" is at most ${MAX_CI_INPUT_VALUE_LENGTH} characters.` };
      }
      inputs.push({ name, kind: 'fixed', value: row.value.trim() });
    } else {
      const options = lines(row.options);
      if (options.length === 0) return { inputs, error: `The choice "${name}" needs at least one option.` };
      if (options.length > MAX_CI_CHOICE_OPTIONS) {
        return { inputs, error: `The choice "${name}" has at most ${MAX_CI_CHOICE_OPTIONS} options.` };
      }
      if (options.some((option) => option.length > MAX_CI_INPUT_VALUE_LENGTH)) {
        return { inputs, error: `An option of "${name}" is at most ${MAX_CI_INPUT_VALUE_LENGTH} characters.` };
      }
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
  const scmCredential = draft.scmCredentialId ? { credentialId: draft.scmCredentialId } : {};
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
        ...scmCredential,
      },
      error: null,
    };
  }
  if (draft.type === 'gitlab') {
    if (!draft.gitlab.ref.trim() || !draft.gitlab.argsVariable.trim()) {
      return { target: null, error: 'GitLab needs a ref and the variable that receives the arguments.' };
    }
    return {
      target: {
        type: 'gitlab',
        ref: draft.gitlab.ref.trim(),
        argsVariable: draft.gitlab.argsVariable.trim(),
        ...scmCredential,
      },
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
        ...scmCredential,
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
  if (name.length > MAX_CI_ACTION_NAME_LENGTH) {
    return { action: null, error: `A name is at most ${MAX_CI_ACTION_NAME_LENGTH} characters.` };
  }
  if (opts.otherNames.some((other) => other.toLowerCase() === name.toLowerCase())) {
    return { action: null, error: `Another action is named "${name}": names must be unique.` };
  }
  const target = targetFromDraft(draft, opts.instanceUrl);
  if (!target.target) return { action: null, error: target.error };
  const inputs = inputsFromDraft(draft, target.target);
  if (inputs.error) return { action: null, error: inputs.error };
  if (draft.accepts.length === 0) return { action: null, error: 'Choose what the action accepts.' };
  const environment = draft.environment.trim();
  if (environment.length > MAX_CI_ENVIRONMENT_LENGTH) {
    return { action: null, error: `An environment is at most ${MAX_CI_ENVIRONMENT_LENGTH} characters.` };
  }
  const action: CiAction = {
    id: draft.id,
    name,
    target: target.target,
    inputs: inputs.inputs,
    accepts: CI_ACTION_KINDS.filter((kind) => draft.accepts.includes(kind)),
    ...(environment ? { environment } : {}),
    ...(draft.environmentId != null ? { environmentId: draft.environmentId } : {}),
  };
  const reserved = reservedInputName(action);
  if (reserved) {
    return {
      action: null,
      error: reservedInputMessage(reserved, target.target),
    };
  }
  return { action, error: null };
}

/**
 * How a Check answer reads in the list: a pass, a problem, a warning (read,
 * but not settled: the target does not say what it does with a name it does
 * not declare), or "could not be checked", which is not a pass.
 */
export function ciCheckResultView(result: CiActionCheckResult | { error: string }): {
  tone: 'ok' | 'error' | 'warning' | 'muted';
  icon: string;
  message: string;
} {
  if ('error' in result) return { tone: 'error', icon: 'i-lucide-circle-alert', message: result.error };
  if (result.ok === true) return { tone: 'ok', icon: 'i-lucide-circle-check', message: result.message };
  if (result.ok === false) return { tone: 'error', icon: 'i-lucide-circle-alert', message: result.message };
  if (result.missing.length > 0) return { tone: 'warning', icon: 'i-lucide-triangle-alert', message: result.message };
  return { tone: 'muted', icon: 'i-lucide-circle-help', message: `Not checked: ${result.message}` };
}

/** The name a duplicate of an action gets: `name (copy)`, or `(copy 2)` and up, within the name limit and unlike any taken name. */
export function duplicateCiActionName(name: string, taken: string[]): string {
  const used = new Set(taken.map((other) => other.toLowerCase()));
  const named = (suffix: string) => `${name.slice(0, MAX_CI_ACTION_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  let candidate = named(' (copy)');
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = named(` (copy ${n})`);
  return candidate;
}

/**
 * A duplicate of an action: a new id, a name unlike any `taken` one (`duplicateCiActionName`), and every other field
 * copied, except an environment `archived` says is archived, which the duplicate leaves for any environment.
 */
export function duplicateCiAction(
  action: CiAction,
  taken: string[],
  archived: (environmentId: number) => boolean,
): CiAction {
  const { environment, environmentId, ...fields } = structuredClone(action);
  const keepsEnvironment = environmentId === undefined || !archived(environmentId);
  return {
    ...fields,
    ...(keepsEnvironment && environment !== undefined ? { environment } : {}),
    ...(keepsEnvironment && environmentId !== undefined ? { environmentId } : {}),
    id: newCiActionId(),
    name: duplicateCiActionName(action.name, taken),
  };
}
