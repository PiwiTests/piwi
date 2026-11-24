/**
 * CI action listings: the jobs a target can dispatch and the fields one job
 * declares, read without starting anything, for the CI action editor. A
 * repository host's come from its workflow or pipeline file, read at the ref
 * with the action's SCM credential, else the project's; a CI server's from the
 * CI server, with the credential a dispatch would carry
 * (`ci-server-dispatch.ts`). An answer that listed something is kept five
 * minutes, by project and target.
 */
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { TtlCache } from './ttl-cache';
import { createScmProvider } from './scm';
import { CredentialRefusedError, type CredentialActor } from './credentials';
import { readProjectRepositoryUrl } from './scm/project-repository';
import { listCiServerJobs, readCiServerJobFields, type CiServerUse } from './ci-server-dispatch';
import { configuredGitlabHosts } from './scm/gitlab-hosts';
import { ciServerTargetOfListing, resolveCiListingTarget, type CiListingTarget } from '#shared/ci-actions';
import { ciActionsCredentialProblem } from '#shared/handlers/credentials';
import {
  bitbucketCustomPipelines,
  bitbucketPipelineFields,
  githubDispatchFields,
  githubWorkflowName,
  GITLAB_NO_JOBS,
  gitlabVariableFields,
  MAX_CI_JOB_FIELDS,
  MAX_CI_WORKFLOW_FILES,
  type CiJob,
  type CiJobField,
  type CiJobFieldListing,
  type CiJobListing,
} from '#shared/ci-job-fields';
import type { ScmProviderName } from '#shared/scm-urls';
import type { DbClient } from '../database';

type ActionScm = NonNullable<Awaited<ReturnType<typeof createScmProvider>>>;

const HOST_LABEL: Record<ScmProviderName, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
const GITLAB_CI_FILE = '.gitlab-ci.yml';
const BITBUCKET_PIPELINES_FILE = 'bitbucket-pipelines.yml';
const WORKFLOW_FILE = /^\.github\/workflows\/([^/]+\.ya?ml)$/i;
/** How many workflow files a GitHub listing reads at once. */
const WORKFLOW_READS_AT_ONCE = 8;

const jobsCache = new TtlCache<CiJobListing>(5 * 60 * 1000);
const fieldsCache = new TtlCache<CiJobFieldListing>(5 * 60 * 1000);

/**
 * The SCM provider an action on `host` reads through: the action's own
 * credential when it names one (a refusal is the answer, never a public read),
 * else the project's. Or why it cannot read, for the user: `what` names what
 * would have been read ("its workflow").
 */
export async function actionScmProvider(
  db: DbClient,
  projectId: number,
  host: ScmProviderName,
  credentialId: number | null,
  actor: CredentialActor,
  what: string,
): Promise<{ scm: ActionScm } | { message: string }> {
  const repositoryUrl = await readProjectRepositoryUrl(db, projectId);
  let scm: Awaited<ReturnType<typeof createScmProvider>>;
  try {
    scm = repositoryUrl
      ? await createScmProvider(repositoryUrl, db, projectId, { actor, credentialId, strict: !!credentialId })
      : null;
  } catch (e) {
    if (!(e instanceof CredentialRefusedError)) throw e;
    return { message: e.message };
  }
  if (!scm || scm.provider !== host) {
    return { message: `This project's repository is not on ${HOST_LABEL[host]}, so ${what} can't be read.` };
  }
  return { scm };
}

/** A file's text at a ref, or why it could not be read, for the user. */
async function readFile(scm: ActionScm, path: string, ref: string): Promise<{ text: string } | { message: string }> {
  try {
    const file = await scm.fetchFileAtRef(path, ref);
    if (file) return { text: file.content };
    return {
      message: `${path} could not be read at ${ref}: it is missing there, or the SCM credential cannot read it.`,
    };
  } catch (e) {
    return { message: `${path} could not be read at ${ref}: ${e instanceof Error ? e.message : String(e)}.` };
  }
}

/** One YAML document, or undefined when the text is not valid YAML. */
function yamlDocument(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

/**
 * What a GitHub workflow file declares at a ref: the inputs of its
 * `workflow_dispatch` trigger. Else why they are not known, for the user:
 * `refused` when GitHub would refuse a dispatch (the workflow has no such
 * trigger), not when the file could not be read.
 */
export async function readGithubWorkflow(
  scm: ActionScm,
  workflow: string,
  ref: string,
): Promise<{ fields: CiJobField[] } | { refused: boolean; message: string }> {
  if (/^\d+$/.test(workflow)) {
    return {
      refused: false,
      message: `A workflow named by its numeric id (${workflow}) can't be read by id: name its file, such as e2e.yml.`,
    };
  }
  if (!/^[\w.-]+\.ya?ml$/i.test(workflow)) {
    return { refused: false, message: `"${workflow}" is not a workflow file name, such as e2e.yml.` };
  }
  const path = `.github/workflows/${workflow}`;
  const file = await readFile(scm, path, ref);
  if ('message' in file) return { refused: false, message: file.message };
  const document = yamlDocument(file.text);
  if (document === undefined) return { refused: false, message: `${path} is not valid YAML at ${ref}.` };
  const fields = githubDispatchFields(document);
  if (!fields) {
    return {
      refused: true,
      message: `The workflow has no workflow_dispatch trigger, so GitHub rejects a dispatch of ${workflow}.`,
    };
  }
  return { fields };
}

const noJobs = (message: string): CiJobListing => ({ jobs: null, truncated: false, message });

/** The workflows at a ref that GitHub can dispatch: those with a `workflow_dispatch` trigger. */
async function listGithubWorkflows(scm: ActionScm, ref: string): Promise<CiJobListing> {
  const tree = await scm.fetchTree(ref).catch(() => null);
  if (!tree) {
    return noJobs(
      `The repository's files could not be read at ${ref}: the ref is missing, or the SCM credential cannot read it.`,
    );
  }
  const files = tree
    .map((path) => WORKFLOW_FILE.exec(path)?.[1])
    .filter((file): file is string => !!file)
    .sort();
  const read = files.slice(0, MAX_CI_WORKFLOW_FILES);
  const jobs: CiJob[] = [];
  for (let at = 0; at < read.length; at += WORKFLOW_READS_AT_ONCE) {
    const batch = read.slice(at, at + WORKFLOW_READS_AT_ONCE);
    const texts = await Promise.all(batch.map((file) => readFile(scm, `.github/workflows/${file}`, ref)));
    texts.forEach((text, index) => {
      const file = batch[index]!;
      const workflow = 'text' in text ? yamlDocument(text.text) : undefined;
      if (workflow === undefined || githubDispatchFields(workflow) === null) return;
      const name = githubWorkflowName(workflow);
      jobs.push(name ? { id: file, label: name, description: file } : { id: file, label: file });
    });
  }
  const truncated = files.length > read.length;
  let message: string | null = null;
  if (truncated)
    message = `Only the first ${MAX_CI_WORKFLOW_FILES} workflow files are read: type the file name of another.`;
  else if (jobs.length === 0) {
    message = `No workflow at ${ref} has a workflow_dispatch trigger: GitHub dispatches only such a workflow.`;
  }
  return { jobs, truncated, message };
}

/** The variables a GitLab CI file at a ref sets. */
async function gitlabFields(scm: ActionScm, ref: string): Promise<CiJobFieldListing> {
  const file = await readFile(scm, GITLAB_CI_FILE, ref);
  if ('message' in file) {
    return { fields: null, message: `${file.message} Piwi reads the CI file at the repository's root only.` };
  }
  const documents = parseAllDocuments(file.text);
  const list = Array.isArray(documents) ? documents : [];
  if (list.some((d) => d.errors.length > 0)) {
    return { fields: null, message: `${GITLAB_CI_FILE} is not valid YAML at ${ref}.` };
  }
  const parsed: unknown[] = list.map((d) => d.toJS());
  const fields = gitlabVariableFields(parsed);
  const includes = parsed.some((d) => typeof d === 'object' && d !== null && 'include' in d);
  const notes = [
    'GitLab takes any variable a pipeline is created with: these are the ones the CI file sets.',
    ...(includes ? ['Variables of the files it includes are not listed.'] : []),
  ];
  return { fields, message: notes.join(' ') };
}

/** A Bitbucket Pipelines file, read on the branch a dispatch with no branch runs on. */
async function bitbucketDocument(scm: ActionScm): Promise<{ document: unknown; branch: string } | { message: string }> {
  const branch = (await scm.getDefaultBranch().catch(() => null)) || 'main';
  const file = await readFile(scm, BITBUCKET_PIPELINES_FILE, branch);
  if ('message' in file) return file;
  const document = yamlDocument(file.text);
  if (document === undefined) return { message: `${BITBUCKET_PIPELINES_FILE} is not valid YAML at ${branch}.` };
  return { document, branch };
}

async function listBitbucketPipelines(scm: ActionScm): Promise<CiJobListing> {
  const read = await bitbucketDocument(scm);
  if ('message' in read) return noJobs(read.message);
  const jobs = bitbucketCustomPipelines(read.document);
  return {
    jobs,
    truncated: false,
    message:
      jobs.length === 0
        ? `${BITBUCKET_PIPELINES_FILE} declares no custom pipeline at ${read.branch}: Bitbucket starts only a custom pipeline for Piwi.`
        : null,
  };
}

async function bitbucketFields(scm: ActionScm, pipeline: string): Promise<CiJobFieldListing> {
  if (!pipeline) return { fields: null, message: 'Pick a custom pipeline first.' };
  const read = await bitbucketDocument(scm);
  if ('message' in read) return { fields: null, message: read.message };
  const fields = bitbucketPipelineFields(read.document, pipeline);
  if (!fields) {
    return {
      fields: null,
      message: `${BITBUCKET_PIPELINES_FILE} has no custom pipeline named "${pipeline}" at ${read.branch}.`,
    };
  }
  return { fields, message: null };
}

/** What `what` names for each host, in a sentence about a file that cannot be read. */
const READ_WHAT: Record<ScmProviderName, string> = {
  github: 'its workflows',
  gitlab: 'its CI file',
  bitbucket: 'its pipelines file',
};

const cacheKey = (projectId: number, target: CiListingTarget) => `${projectId}:${JSON.stringify(target)}`;
/** What a job listing depends on: the target, whichever job is picked. */
const jobsKey = (projectId: number, target: CiListingTarget) =>
  `${projectId}:${JSON.stringify({ ...target, workflow: '', pipeline: '', job: '' })}`;

/**
 * The jobs a target lists, for the CI action editor: a repository's
 * dispatchable workflows or custom pipelines, or a CI server's jobs. A GitLab
 * pipeline runs the CI file of its ref, so it lists none. `refresh` reads
 * again instead of answering from what was kept.
 */
export async function listCiJobs(
  db: DbClient,
  projectId: number,
  target: CiListingTarget,
  use: CiServerUse,
  options: { refresh?: boolean } = {},
): Promise<CiJobListing> {
  if (target.type === 'gitlab') return noJobs(GITLAB_NO_JOBS);
  const key = jobsKey(projectId, target);
  if (options.refresh) jobsCache.delete(key);
  const hit = jobsCache.get(key);
  if (hit) return hit;

  let listing: CiJobListing;
  if (target.type === 'ci-server') {
    listing = await listCiServerJobs(db, projectId, ciServerTargetOfListing(target), use);
  } else {
    const opened = await actionScmProvider(
      db,
      projectId,
      target.type,
      target.credentialId ?? null,
      use.actor,
      READ_WHAT[target.type],
    );
    if ('message' in opened) listing = noJobs(opened.message);
    else if (target.type === 'github') listing = await listGithubWorkflows(opened.scm, target.ref);
    else listing = await listBitbucketPipelines(opened.scm);
  }
  if (listing.jobs) jobsCache.set(key, listing);
  return listing;
}

/**
 * The fields the target's job declares, for the CI action editor: a GitHub
 * workflow's inputs, a GitLab CI file's variables, a Bitbucket custom
 * pipeline's variables, or a Jenkins job's parameters. `refresh` reads again
 * instead of answering from what was kept.
 */
export async function listCiJobFields(
  db: DbClient,
  projectId: number,
  target: CiListingTarget,
  use: CiServerUse,
  options: { refresh?: boolean } = {},
): Promise<CiJobFieldListing> {
  const key = cacheKey(projectId, target);
  if (options.refresh) fieldsCache.delete(key);
  const hit = fieldsCache.get(key);
  if (hit) return hit;

  let listing: CiJobFieldListing;
  if (target.type === 'ci-server') {
    listing = target.job
      ? await readCiServerJobFields(db, projectId, ciServerTargetOfListing(target), use)
      : { fields: null, message: 'Pick a job first.' };
  } else if (target.type === 'github' && !target.workflow) {
    listing = { fields: null, message: 'Pick a workflow first.' };
  } else {
    const opened = await actionScmProvider(
      db,
      projectId,
      target.type,
      target.credentialId ?? null,
      use.actor,
      READ_WHAT[target.type],
    );
    if ('message' in opened) listing = { fields: null, message: opened.message };
    else if (target.type === 'github') {
      const read = await readGithubWorkflow(opened.scm, target.workflow, target.ref);
      listing = 'fields' in read ? { fields: read.fields, message: null } : { fields: null, message: read.message };
    } else if (target.type === 'gitlab') listing = await gitlabFields(opened.scm, target.ref);
    else listing = await bitbucketFields(opened.scm, target.pipeline);
  }
  if (listing.fields && listing.fields.length > MAX_CI_JOB_FIELDS) {
    listing = {
      fields: listing.fields.slice(0, MAX_CI_JOB_FIELDS),
      message: `Only the first ${MAX_CI_JOB_FIELDS} fields are listed.`,
    };
  }
  if (listing.fields) fieldsCache.set(key, listing);
  return listing;
}

/**
 * A listing request's body (`{ target, name?, refresh? }`, the target as an
 * action's, its job optional) as the target to list from, or why it cannot be
 * listed from: a target that names nothing to read, or a credential the
 * project may not name (refused as a save of the action would refuse it).
 */
export async function resolveCiListingRequest(
  db: DbClient,
  projectId: number,
  body: unknown,
): Promise<{ target: CiListingTarget; refresh: boolean } | { error: string }> {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const resolved = resolveCiListingTarget(raw.target);
  if ('error' in resolved) return resolved;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'This CI action';
  const problem = await ciActionsCredentialProblem(
    db,
    projectId,
    { actions: [{ name, target: resolved.target }] },
    [],
    configuredGitlabHosts(),
    await readProjectRepositoryUrl(db, projectId),
  );
  if (problem) return { error: problem };
  return { target: resolved.target, refresh: raw.refresh === true };
}
