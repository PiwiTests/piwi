import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { readChangeCoverage } from '../../../../utils/scm/change-coverage';
import { isValidGitRef } from '../../../../utils/scm/refs';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Change coverage for a run or commit range',
    description:
      'Joins the files a change touched to the tests that observably reach them, grouped by ticket. Pass `run` to diff a run against its baseline, or `base` and `head` to diff an explicit commit range. Degrades to an empty result when no SCM token or diff is available. Reach is observed reach; when the head commit has combined coverage, a file a suite ran one of the changed lines of counts as reached and lists those `suites`, and `patchCoverage` counts the changed lines that ran (null without that coverage, or without the provider’s patches).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'run', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'base', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'head', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const query = getQuery(event);
  const runId = Number(query.run);
  const base = typeof query.base === 'string' ? query.base : null;
  const head = typeof query.head === 'string' ? query.head : null;

  if (!Number.isFinite(runId) && !(base && head)) {
    throw apiError({ statusCode: 400, message: 'Pass ?run=<id> or ?base=<sha>&head=<sha>' });
  }

  // Refs go into SCM API URLs with the project's token, so reject anything that
  // is not a plausible SHA or ref before it can climb out of the repo path.
  if ((base != null && !isValidGitRef(base)) || (head != null && !isValidGitRef(head))) {
    throw apiError({ statusCode: 400, message: 'Invalid base or head ref' });
  }

  const db = await getDatabase();
  return readChangeCoverage(db, projectId, {
    runId: Number.isFinite(runId) ? runId : null,
    baseSha: base,
    headSha: head,
  });
});
