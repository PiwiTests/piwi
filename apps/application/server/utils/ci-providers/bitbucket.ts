/**
 * The Bitbucket provider: a custom pipeline, started on the repository's
 * default branch unless a dispatch names one. Check and the listings read the
 * custom pipelines and their variables from `bitbucket-pipelines.yml` on the
 * default branch. Bitbucket's documentation does not say what a pipeline does
 * with a variable it does not declare, so Check names those without failing.
 */
import { ciActionSentNames } from '#shared/ci-actions';
import {
  bitbucketCustomPipelines,
  bitbucketPipelineFields,
  bitbucketPipelineImported,
  undeclaredNames,
} from '#shared/ci-job-fields';
import {
  actionScmProvider,
  readAt,
  readFile,
  repositoryHostProvider,
  yamlDocument,
  type ActionScm,
} from './repository-host';

const BITBUCKET_PIPELINES_FILE = 'bitbucket-pipelines.yml';

/** The pipelines file, read on the branch a dispatch with no branch runs on. */
async function pipelinesFile(scm: ActionScm): Promise<{ document: unknown; branch: string } | { message: string }> {
  const branch = (await scm.getDefaultBranch().catch(() => null)) || 'main';
  const file = await readFile(scm, BITBUCKET_PIPELINES_FILE, await readAt(scm, branch));
  if ('message' in file) return file;
  const document = yamlDocument(file.text);
  if (document === undefined) return { message: `${BITBUCKET_PIPELINES_FILE} is not valid YAML at ${branch}.` };
  return { document, branch };
}

export const bitbucketProvider = repositoryHostProvider('bitbucket', {
  /**
   * The custom pipeline must be in the pipelines file of the default branch,
   * where a dispatch with no branch runs it; the names a dispatch sends that it
   * does not declare are named.
   */
  async check(db, projectId, action, use) {
    const { pipeline } = action.target;
    const opened = await actionScmProvider(
      db,
      projectId,
      'bitbucket',
      action.target.credentialId ?? null,
      use.actor,
      'its pipelines file',
    );
    const read = 'message' in opened ? opened : await pipelinesFile(opened.scm);
    if ('message' in read) return { ok: null, missing: [], message: read.message };
    const fields = bitbucketPipelineFields(read.document, pipeline);
    if (!fields) {
      return {
        ok: false,
        missing: [],
        message: `${BITBUCKET_PIPELINES_FILE} on ${read.branch}, the default branch, has no custom pipeline named "${pipeline}": Bitbucket cannot start it there.`,
      };
    }
    if (bitbucketPipelineImported(read.document, pipeline)) {
      return {
        ok: null,
        missing: [],
        message: `The custom pipeline "${pipeline}" is imported from another repository, whose file declares its variables.`,
      };
    }
    const sent = ciActionSentNames(action);
    const missing = undeclaredNames(fields, sent);
    if (missing.length === 0) {
      return { ok: true, missing, message: `The custom pipeline declares ${sent.join(', ')} on ${read.branch}.` };
    }
    return {
      ok: null,
      missing,
      message: `The custom pipeline "${pipeline}" does not declare ${missing.join(', ')} on ${read.branch}: declare ${missing.length > 1 ? 'them' : 'it'} under its variables, so the pipeline is sure to receive ${missing.length > 1 ? 'them' : 'it'}.`,
    };
  },

  async listJobs(db, projectId, target, use) {
    const opened = await actionScmProvider(
      db,
      projectId,
      'bitbucket',
      target.credentialId ?? null,
      use.actor,
      'its pipelines file',
    );
    const read = 'message' in opened ? opened : await pipelinesFile(opened.scm);
    if ('message' in read) return { jobs: null, truncated: false, message: read.message, complete: false };
    const jobs = bitbucketCustomPipelines(read.document);
    return {
      jobs,
      truncated: false,
      message:
        jobs.length === 0
          ? `${BITBUCKET_PIPELINES_FILE} declares no custom pipeline at ${read.branch}: Bitbucket starts only a custom pipeline for Piwi.`
          : null,
      complete: true,
    };
  },

  async listFields(db, projectId, target, use) {
    if (!target.pipeline) return { fields: null, message: 'Pick a custom pipeline first.' };
    const opened = await actionScmProvider(
      db,
      projectId,
      'bitbucket',
      target.credentialId ?? null,
      use.actor,
      'its pipelines file',
    );
    const read = 'message' in opened ? opened : await pipelinesFile(opened.scm);
    if ('message' in read) return { fields: null, message: read.message };
    const fields = bitbucketPipelineFields(read.document, target.pipeline);
    if (!fields) {
      return {
        fields: null,
        message: `${BITBUCKET_PIPELINES_FILE} has no custom pipeline named "${target.pipeline}" at ${read.branch}.`,
      };
    }
    // Its variables are declared in the other repository: none is known here, so none is named undeclared.
    if (bitbucketPipelineImported(read.document, target.pipeline)) {
      return {
        fields: null,
        message: `The custom pipeline "${target.pipeline}" is imported from another repository, whose file declares its variables.`,
      };
    }
    return { fields, message: null };
  },
});
