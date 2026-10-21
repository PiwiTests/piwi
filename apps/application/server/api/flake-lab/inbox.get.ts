import { requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { cachedFlakeProfileSummaries } from '../../utils/flake-profile-cache';
import { FLAKE_LAB_INBOX_MAX, listFlakeLabInbox } from '#shared/handlers/flake-lab';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Flaky tests waiting in the Flake Lab, across projects',
    description: `The flaky tests Home links to, in the most recently run projects the caller can see that did not decline the Flake Lab: each test the lab reproduced that waits for a verify (\`step: verify\`, \`detail\` the condition that reproduced it), then each test whose top suspect the lab has not tested (\`step: reproduce\`, \`detail\` that suspect, \`untestedSuspects\` how many are untested). Each item carries its project, title, path, the \`command\` the step needs and its \`flakeRate\`. At most ${FLAKE_LAB_INBOX_MAX}.`,
    parameters: [],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any);
  return {
    items: await listFlakeLabInbox(db, scope === 'all' ? 'all' : [...scope], {
      profiles: (projectId, testCaseIds) => cachedFlakeProfileSummaries(db, projectId, testCaseIds),
    }),
  };
});
