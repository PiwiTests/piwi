/**
 * The GitHub provider: a workflow with a `workflow_dispatch` trigger, its
 * inputs read from the workflow file. Check reads that file and the listings
 * read the workflow files at the action's ref.
 */
import {
  githubDispatchFields,
  githubWorkflowName,
  MAX_CI_WORKFLOW_FILES,
  missingRequiredFields,
  type CiJob,
  type CiJobField,
} from '#shared/ci-job-fields';
import { ciActionSentNames } from '#shared/ci-actions';
import {
  actionScmProvider,
  readAt,
  readFile,
  repositoryHostProvider,
  yamlDocument,
  type ActionScm,
} from './repository-host';
import type { CiProviderJobListing } from './types';

/** A workflow file name: what GitHub runs, directly under `.github/workflows/`. */
const WORKFLOW_FILE_NAME = /^[^/]+\.ya?ml$/i;
const WORKFLOWS_DIRECTORY = '.github/workflows/';
/** How many workflow files a listing reads at once. */
const WORKFLOW_READS_AT_ONCE = 8;

/**
 * What a workflow file declares at a ref: the inputs of its `workflow_dispatch`
 * trigger. Else why they are not known, for the user: `refused` when GitHub
 * would refuse a dispatch (the workflow has no such trigger), not when the file
 * could not be read.
 */
async function readWorkflow(
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
  if (!WORKFLOW_FILE_NAME.test(workflow)) {
    return { refused: false, message: `"${workflow}" is not a workflow file name, such as e2e.yml.` };
  }
  const path = `${WORKFLOWS_DIRECTORY}${workflow}`;
  const file = await readFile(scm, path, await readAt(scm, ref));
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

const noJobs = (message: string): CiProviderJobListing => ({ jobs: null, truncated: false, message, complete: false });

/** The workflows at a ref that GitHub can dispatch, and whether a file could not be read (so the list may lack one). */
async function listWorkflows(scm: ActionScm, ref: string): Promise<CiProviderJobListing> {
  const at = await readAt(scm, ref);
  const tree = await scm.fetchTree(at.commit).catch(() => null);
  if (!tree) {
    return noJobs(
      `The repository's files could not be read at ${ref}: the ref is missing, or the SCM credential cannot read it.`,
    );
  }
  const files = tree
    .filter((path) => path.startsWith(WORKFLOWS_DIRECTORY))
    .map((path) => path.slice(WORKFLOWS_DIRECTORY.length))
    .filter((file) => WORKFLOW_FILE_NAME.test(file))
    .sort();
  const read = files.slice(0, MAX_CI_WORKFLOW_FILES);
  const jobs: CiJob[] = [];
  const unread: string[] = [];
  let firstFailure: string | null = null;
  for (let start = 0; start < read.length; start += WORKFLOW_READS_AT_ONCE) {
    const batch = read.slice(start, start + WORKFLOW_READS_AT_ONCE);
    const texts = await Promise.all(batch.map((file) => readFile(scm, `${WORKFLOWS_DIRECTORY}${file}`, at)));
    texts.forEach((text, index) => {
      const file = batch[index]!;
      if ('message' in text) {
        unread.push(file);
        firstFailure ??= text.message;
        return;
      }
      const workflow = yamlDocument(text.text);
      if (workflow === undefined || githubDispatchFields(workflow) === null) return;
      const name = githubWorkflowName(workflow);
      jobs.push(name ? { id: file, label: name, description: file } : { id: file, label: file });
    });
  }
  if (read.length > 0 && unread.length === read.length) {
    return noJobs(firstFailure ?? `The workflow files could not be read at ${ref}.`);
  }
  const truncated = files.length > read.length;
  const notes: string[] = [];
  if (unread.length > 0) notes.push(`${unread.join(', ')} could not be read, so the list may lack a workflow.`);
  if (truncated) {
    notes.push(`Only the first ${MAX_CI_WORKFLOW_FILES} workflow files are read: type the file name of another.`);
  } else if (jobs.length === 0 && unread.length === 0) {
    notes.push(`No workflow at ${ref} has a workflow_dispatch trigger: GitHub dispatches only such a workflow.`);
  }
  return { jobs, truncated, message: notes.join(' ') || null, complete: unread.length === 0 };
}

export const githubProvider = repositoryHostProvider('github', {
  /**
   * The workflow file, read at the action's ref, must declare every input a
   * dispatch sends, and a dispatch must send every input the workflow
   * requires without a default.
   */
  async check(db, projectId, action, use) {
    const { workflow, ref } = action.target;
    // The action's own credential is the one its dispatch carries: a refusal is the answer, never a public read.
    const opened = await actionScmProvider(
      db,
      projectId,
      'github',
      action.target.credentialId ?? null,
      use.actor,
      'its workflow',
    );
    if ('message' in opened) return { ok: null, missing: [], message: opened.message };
    const read = await readWorkflow(opened.scm, workflow, ref);
    if (!('fields' in read)) return { ok: read.refused ? false : null, missing: [], message: read.message };
    const sent = ciActionSentNames(action);
    const declared = read.fields.map((f) => f.name);
    const missing = sent.filter((name) => !declared.includes(name));
    const required = missingRequiredFields(read.fields, sent).map((f) => f.name);
    if (missing.length > 0) {
      return {
        ok: false,
        missing,
        message: `The workflow does not declare ${missing.join(', ')}: GitHub rejects a dispatch that sends an input the workflow does not declare.`,
      };
    }
    if (required.length > 0) {
      return {
        ok: false,
        missing: [],
        message: `The workflow requires ${required.join(', ')}, with no default, which this action does not send: add ${required.length > 1 ? 'them' : 'it'} as inputs, or GitHub rejects the dispatch.`,
      };
    }
    return { ok: true, missing, message: `The workflow declares ${sent.join(', ')}.` };
  },

  async listJobs(db, projectId, target, use) {
    const opened = await actionScmProvider(
      db,
      projectId,
      'github',
      target.credentialId ?? null,
      use.actor,
      'its workflows',
    );
    return 'message' in opened ? noJobs(opened.message) : listWorkflows(opened.scm, target.ref);
  },

  async listFields(db, projectId, target, use) {
    if (!target.workflow) return { fields: null, message: 'Pick a workflow first.' };
    const opened = await actionScmProvider(
      db,
      projectId,
      'github',
      target.credentialId ?? null,
      use.actor,
      'its workflows',
    );
    if ('message' in opened) return { fields: null, message: opened.message };
    const read = await readWorkflow(opened.scm, target.workflow, target.ref);
    return 'fields' in read ? { fields: read.fields, message: null } : { fields: null, message: read.message };
  },
});
