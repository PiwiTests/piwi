/**
 * The GitLab provider: a pipeline on a ref, which runs the project's CI file
 * there and takes any variable it is created with. Nothing it declares can be
 * checked without starting a pipeline; the listing suggests the variables the
 * CI file sets.
 */
import { GITLAB_NO_JOBS, gitlabVariableFields } from '#shared/ci-job-fields';
import { actionScmProvider, readAt, readFile, repositoryHostProvider, yamlDocuments } from './repository-host';

const GITLAB_CI_FILE = '.gitlab-ci.yml';

export const gitlabProvider = repositoryHostProvider('gitlab', {
  check: async () => ({
    ok: null,
    missing: [],
    message:
      "GitLab pipelines can't be checked: GitLab reports no variable declarations without starting a pipeline. Dispatch it once to confirm.",
  }),

  listJobs: async () => ({ jobs: null, truncated: false, message: GITLAB_NO_JOBS, complete: false }),

  async listFields(db, projectId, target, use) {
    const opened = await actionScmProvider(
      db,
      projectId,
      'gitlab',
      target.credentialId ?? null,
      use.actor,
      'its CI file',
    );
    if ('message' in opened) return { fields: null, message: opened.message };
    const file = await readFile(opened.scm, GITLAB_CI_FILE, await readAt(opened.scm, target.ref));
    if ('message' in file) {
      return { fields: null, message: `${file.message} Piwi reads the CI file at the repository's root only.` };
    }
    const parsed = yamlDocuments(file.text);
    if (!parsed) return { fields: null, message: `${GITLAB_CI_FILE} is not valid YAML at ${target.ref}.` };
    const includes = parsed.some((d) => typeof d === 'object' && d !== null && 'include' in d);
    const notes = [
      'GitLab takes any variable a pipeline is created with: these are the ones the CI file sets.',
      ...(includes ? ['Variables of the files it includes are not listed.'] : []),
    ];
    return { fields: gitlabVariableFields(parsed), message: notes.join(' ') };
  },
});
