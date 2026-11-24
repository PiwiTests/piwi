/**
 * What a CI action's target declares, read without starting it: the jobs it
 * can dispatch (a GitHub workflow with a `workflow_dispatch` trigger, a
 * Bitbucket custom pipeline, a Jenkins job) and the fields one of them takes
 * (a workflow's inputs, a pipeline's variables, a job's parameters). The CI
 * action editor offers them as choices, as the issue tracker binding offers a
 * Jira project's fields.
 *
 * Each reader takes a parsed document (a workflow or pipeline file's YAML, a
 * Jenkins answer's JSON) and keeps only names, types, defaults, options and
 * short descriptions. Pure and dependency-free: the server reads the files and
 * the CI server (`server/utils/ci-jobs.ts`), the demo answers from fixed
 * documents through the same readers.
 */

/** How a field's value is typed, as the editor offers it. */
export const CI_JOB_FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'choice', 'environment', 'secret'] as const;
export type CiJobFieldType = (typeof CI_JOB_FIELD_TYPES)[number];

/** One field a job declares: a workflow input, a pipeline variable or a job parameter. */
export interface CiJobField {
  name: string;
  type: CiJobFieldType;
  /** Whether the target marks it required (GitHub only): a dispatch must send it when it has no default. */
  required: boolean;
  /** The value the CI uses when a dispatch sends none; never kept for a secret. */
  default?: string;
  description?: string;
  /** A choice's options; `true` and `false` for a boolean. */
  options?: string[];
}

/** One job a target can dispatch. */
export interface CiJob {
  /** What the action stores: a workflow file name, a custom pipeline name or a Jenkins job path. */
  id: string;
  /** How the list names it: a workflow's `name`, else the same as `id`. */
  label: string;
  /** A second line: a workflow's file name when its label is its `name`. */
  description?: string;
}

/** The jobs a target lists. */
export interface CiJobListing {
  /** Null when the target has no jobs to pick (a GitLab pipeline) or could not be read. */
  jobs: CiJob[] | null;
  /** Whether the list stops at its limit. */
  truncated: boolean;
  /** What was not listed and why, for the user; null when everything was. */
  message: string | null;
}

/** The fields one job declares. */
export interface CiJobFieldListing {
  /** Null when the job could not be read. */
  fields: CiJobField[] | null;
  /** Why the fields could not be read, or what they leave out, for the user; null otherwise. */
  message: string | null;
}

/** Why a GitLab target lists no jobs. */
export const GITLAB_NO_JOBS = 'A GitLab pipeline runs the CI file of its ref: there is no job to pick.';

/** The most jobs a listing returns. */
export const MAX_CI_JOBS = 500;
/** The most workflow files a GitHub listing reads at one ref. */
export const MAX_CI_WORKFLOW_FILES = 40;
/** The most fields a job's listing returns. */
export const MAX_CI_JOB_FIELDS = 100;
/** The most of a description kept. */
export const MAX_CI_FIELD_DESCRIPTION_LENGTH = 300;
/** The most options a choice keeps. */
const MAX_CI_FIELD_OPTIONS = 50;
/** Whether a name is one a target may declare: 1 to 200 characters, no control character. */
const validFieldName = (name: string) => name.length > 0 && name.length <= 200 && !/\p{Cc}/u.test(name);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A YAML or JSON scalar as text: a number or a boolean as written, anything else absent. */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function description(value: unknown): { description?: string } {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? { description: text.slice(0, MAX_CI_FIELD_DESCRIPTION_LENGTH) } : {};
}

function optionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(scalar).filter((o): o is string => o !== undefined && o !== ''))].slice(
    0,
    MAX_CI_FIELD_OPTIONS,
  );
}

/** A field with its options: a choice keeps only a default that is one of them. */
function field(
  name: string,
  type: CiJobFieldType,
  required: boolean,
  raw: { default?: unknown; description?: unknown; options?: unknown },
): CiJobField {
  const options = type === 'boolean' ? ['true', 'false'] : type === 'choice' ? optionsOf(raw.options) : [];
  const fallback = type === 'secret' ? undefined : scalar(raw.default);
  const value = options.length > 0 && fallback !== undefined && !options.includes(fallback) ? undefined : fallback;
  return {
    name,
    type: type === 'choice' && options.length === 0 ? 'string' : type,
    required,
    ...(value !== undefined ? { default: value } : {}),
    ...description(raw.description),
    ...(options.length > 0 ? { options } : {}),
  };
}

/** The fields, each name once (the first wins). */
function unique(fields: CiJobField[]): CiJobField[] {
  const seen = new Set<string>();
  const out: CiJobField[] = [];
  for (const f of fields) {
    if (!validFieldName(f.name) || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

const GITHUB_INPUT_TYPES = new Map<unknown, CiJobFieldType>([
  ['string', 'string'],
  ['boolean', 'boolean'],
  ['choice', 'choice'],
  ['number', 'number'],
  ['environment', 'environment'],
]);

/**
 * The inputs a GitHub workflow's `workflow_dispatch` trigger declares, or null
 * when the workflow has no such trigger. `on` may be the event name, a list of
 * events, or a map of them.
 */
export function githubDispatchFields(workflow: unknown): CiJobField[] | null {
  const on = isRecord(workflow) ? workflow.on : undefined;
  if (on === 'workflow_dispatch') return [];
  if (Array.isArray(on)) return on.includes('workflow_dispatch') ? [] : null;
  if (!isRecord(on) || !('workflow_dispatch' in on)) return null;
  const trigger = on.workflow_dispatch;
  const inputs = isRecord(trigger) && isRecord(trigger.inputs) ? trigger.inputs : {};
  return unique(
    Object.entries(inputs).map(([name, raw]) => {
      const spec = isRecord(raw) ? raw : {};
      const type = GITHUB_INPUT_TYPES.get(spec.type) ?? 'string';
      return field(name, type, spec.required === true || spec.required === 'true', spec);
    }),
  );
}

/** A GitHub workflow's `name`, or null. */
export function githubWorkflowName(workflow: unknown): string | null {
  const name = isRecord(workflow) && typeof workflow.name === 'string' ? workflow.name.trim() : '';
  return name || null;
}

/** The top-level keys of a GitLab CI file that are keywords, not jobs. */
const GITLAB_KEYWORDS = new Set([
  'after_script',
  'before_script',
  'cache',
  'default',
  'image',
  'include',
  'services',
  'spec',
  'stages',
  'types',
  'variables',
  'workflow',
]);

/** One GitLab variable: a scalar value, or `{ value, description, options }`. */
function gitlabVariable(name: string, raw: unknown, job: string | null): CiJobField {
  if (!isRecord(raw)) {
    return field(name, 'string', false, {
      default: raw,
      description: job ? `Set in the job ${job}.` : undefined,
    });
  }
  const options = optionsOf(raw.options);
  return field(name, options.length > 0 ? 'choice' : 'string', false, {
    default: raw.value,
    description: raw.description ?? (job ? `Set in the job ${job}.` : undefined),
    options,
  });
}

/**
 * The variables a GitLab CI file sets: its top-level `variables`, then each
 * job's, each name once. `documents` are the file's YAML documents: a header
 * holding only `spec` is skipped. A pipeline created through the API takes any
 * variable, so these are suggestions, not a declaration the dispatch must
 * match.
 */
export function gitlabVariableFields(documents: unknown[]): CiJobField[] {
  const fields: CiJobField[] = [];
  for (const document of documents) {
    if (!isRecord(document)) continue;
    const keys = Object.keys(document);
    if (keys.length === 1 && keys[0] === 'spec') continue;
    if (isRecord(document.variables)) {
      for (const [name, raw] of Object.entries(document.variables)) fields.push(gitlabVariable(name, raw, null));
    }
    for (const [job, body] of Object.entries(document)) {
      if (GITLAB_KEYWORDS.has(job) || !isRecord(body) || !isRecord(body.variables)) continue;
      for (const [name, raw] of Object.entries(body.variables)) fields.push(gitlabVariable(name, raw, job));
    }
  }
  return unique(fields);
}

/** The custom pipelines of a Bitbucket Pipelines file, by name. */
function bitbucketCustom(document: unknown): Record<string, unknown> {
  const pipelines = isRecord(document) ? document.pipelines : null;
  return isRecord(pipelines) && isRecord(pipelines.custom) ? pipelines.custom : {};
}

/** The custom pipelines a Bitbucket Pipelines file declares, in its order. */
export function bitbucketCustomPipelines(document: unknown): CiJob[] {
  return Object.keys(bitbucketCustom(document))
    .slice(0, MAX_CI_JOBS)
    .map((name) => ({ id: name, label: name }));
}

/**
 * The variables a Bitbucket custom pipeline declares (its `- variables:` item),
 * or null when the file has no custom pipeline of that name. A pipeline
 * imported from another repository declares none here.
 */
export function bitbucketPipelineFields(document: unknown, pipeline: string): CiJobField[] | null {
  const custom = bitbucketCustom(document);
  if (!Object.prototype.hasOwnProperty.call(custom, pipeline)) return null;
  const steps = custom[pipeline];
  const fields: CiJobField[] = [];
  for (const item of Array.isArray(steps) ? steps : []) {
    if (!isRecord(item) || !Array.isArray(item.variables)) continue;
    for (const raw of item.variables) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      const options = optionsOf(raw['allowed-values']);
      fields.push(
        field(raw.name, options.length > 0 ? 'choice' : 'string', false, {
          default: raw.default,
          description: raw.description,
          options,
        }),
      );
    }
  }
  return unique(fields);
}

/** The `tree` of a Jenkins job read: its parameters, with what the editor shows of each. */
export const JENKINS_PARAMETERS_TREE =
  'property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]';

/** How deep a Jenkins listing reads folders: three levels of `jobs`. */
const JENKINS_JOB_LEVELS = 3;
const jenkinsJobsTree = (levels: number): string =>
  `jobs[name,_class,buildable${levels > 1 ? `,${jenkinsJobsTree(levels - 1)}` : ''}]`;
/** The `tree` of a Jenkins listing: the jobs under the base URL, folders read three levels deep. */
export const JENKINS_JOBS_TREE = jenkinsJobsTree(JENKINS_JOB_LEVELS);

const JENKINS_PARAMETER_TYPES = new Map<unknown, CiJobFieldType>([
  ['StringParameterDefinition', 'string'],
  ['TextParameterDefinition', 'text'],
  ['ChoiceParameterDefinition', 'choice'],
  ['BooleanParameterDefinition', 'boolean'],
  ['PasswordParameterDefinition', 'secret'],
]);

/**
 * The parameters a Jenkins job's JSON (read with {@link JENKINS_PARAMETERS_TREE})
 * declares: none for a job that takes no parameters, null when the answer is
 * not a job. A password parameter's default is never kept.
 */
export function jenkinsParameterFields(json: unknown): CiJobField[] | null {
  if (!isRecord(json) || !('property' in json)) return null;
  const fields: CiJobField[] = [];
  for (const property of Array.isArray(json.property) ? json.property : []) {
    const definitions = isRecord(property) ? property.parameterDefinitions : null;
    for (const definition of Array.isArray(definitions) ? definitions : []) {
      if (!isRecord(definition) || typeof definition.name !== 'string') continue;
      const type = JENKINS_PARAMETER_TYPES.get(definition.type) ?? 'string';
      const fallback = isRecord(definition.defaultParameterValue) ? definition.defaultParameterValue.value : undefined;
      fields.push(
        field(definition.name, type, false, {
          default: fallback,
          description: definition.description,
          options: definition.choices,
        }),
      );
    }
  }
  return unique(fields);
}

/** The Jenkins item classes that hold jobs of their own: a folder, an organization folder. */
const isJenkinsFolder = (cls: string) => /(?:^|\.)(?:Folder|OrganizationFolder)$/.test(cls);
/** The Jenkins item class of a multibranch pipeline, whose jobs are its branches. */
const isJenkinsMultibranch = (cls: string) => /MultiBranchProject$/.test(cls);

/**
 * The jobs a Jenkins listing (read with {@link JENKINS_JOBS_TREE}) holds, as the
 * paths a CI action names (`polaris/e2e`), a multibranch pipeline as
 * `polaris/e2e/{branch}`; a disabled job is left out. `truncated` when a folder
 * lies deeper than the listing reads or the list reaches its limit. Null when
 * the answer lists no jobs at all (not a Jenkins).
 */
export function jenkinsJobs(json: unknown): { jobs: CiJob[]; truncated: boolean } | null {
  if (!isRecord(json) || !Array.isArray(json.jobs)) return null;
  const jobs: CiJob[] = [];
  let truncated = false;
  const add = (id: string) => {
    if (jobs.length < MAX_CI_JOBS) jobs.push({ id, label: id });
    else truncated = true;
  };
  const visit = (items: unknown[], prefix: string) => {
    for (const item of items) {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name) continue;
      const path = `${prefix}${item.name}`;
      const cls = typeof item._class === 'string' ? item._class : '';
      if (isJenkinsMultibranch(cls)) add(`${path}/{branch}`);
      else if (Array.isArray(item.jobs)) visit(item.jobs, `${path}/`);
      else if (isJenkinsFolder(cls)) truncated = true;
      else if (item.buildable !== false) add(path);
    }
  };
  visit(json.jobs, '');
  return { jobs, truncated };
}

/** The required fields with no default that `sent` leaves out: a GitHub dispatch without them is refused. */
export function missingRequiredFields(fields: CiJobField[], sent: string[]): CiJobField[] {
  const names = new Set(sent);
  return fields.filter((f) => f.required && f.default === undefined && !names.has(f.name));
}

/** The names in `sent` that no field declares. */
export function undeclaredNames(fields: CiJobField[], sent: string[]): string[] {
  const declared = new Set(fields.map((f) => f.name));
  return sent.filter((name) => !declared.has(name));
}
