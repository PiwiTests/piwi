import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { listCredentialUses, parseCredentialUsesFilter } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Read the log of every credential',
    description:
      'Returns the uses of every credential, deleted ones and the one the environment sets included, newest first, 50 at a time, as `GET /api/credentials/:id/uses` answers for one: `{ items, nextCursor }`, each row naming its credential (`credentialName`). `projectId`, `feature` and `result` filter the rows, and `nextCursor` is passed back as `before`. Requires `credentials:manage` (administrators only).',
    parameters: [
      { name: 'projectId', in: 'query', required: false, schema: { type: 'integer' } },
      {
        name: 'feature',
        in: 'query',
        required: false,
        schema: {
          type: 'string',
          enum: [
            'ci-dispatch',
            'ci-check',
            'ci-list',
            'scm-read',
            'scm-comment',
            'scm-status',
            'scm-pull-request',
            'ai-call',
            'integration-read',
            'integration-write',
            'notification',
            'credential-test',
          ],
        },
      },
      {
        name: 'result',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['sent', 'ok', 'failed', 'refused'] },
      },
      { name: 'before', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'credentials:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const db = await getDatabase();
  return listCredentialUses(db, null, parseCredentialUsesFilter(getQuery(event)));
});
