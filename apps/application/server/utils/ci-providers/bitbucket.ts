/**
 * The Bitbucket provider: a custom pipeline, started on the repository's
 * default branch unless a dispatch names one. Nothing it declares can be
 * checked without starting it; the listings read the custom pipelines and
 * their variables from `bitbucket-pipelines.yml` on the default branch.
 */
import { bitbucketCustomPipelines, bitbucketPipelineFields } from '#shared/ci-job-fields';
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
  check: async () => ({
    ok: null,
    missing: [],
    message:
      "Bitbucket pipelines can't be checked: Bitbucket reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
  }),

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
    return { fields, message: null };
  },
});
