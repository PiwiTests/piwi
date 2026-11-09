import { getDatabase } from '../../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../../utils/project-access';
import { dismissQuarantineProposal } from '#shared/handlers/quarantine';
import { isQuarantineProposal, normalizeDismissReason } from '#shared/quarantine-proposals';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Dismiss a quarantine proposal or a proposed release',
    description:
      'Turns down what Piwi proposed for a test: `quarantine` while the test is one of the `candidates` of `GET /api/projects/:id/quarantine`, or `release` while its quarantine entry has `releaseProposed`. Records the proposal’s `rejected` hand-back outcome (kind `quarantine-proposal`) with the optional `reason`; dismissing the same proposal again records nothing more. Nothing else changes: the test stays out of, or in, quarantine, and the proposal stays listed, marked `dismissed` or `releaseDismissed`. A candidate dismissed counts again once a newer run of those the candidates read arrives (a finished run on the default branch, or on none, that is no lab, bisect or reproduction run). Answers 404 when the test is not in the project or has no such proposal.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'testCaseId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              proposal: {
                type: 'string',
                enum: ['quarantine', 'release'],
                description: 'Which proposal: quarantining the test, or releasing it',
              },
              reason: { type: 'string', description: 'Why it is dismissed (capped at 500 chars).' },
            },
            required: ['proposal'],
          },
        },
      },
    },
    'x-required-permission': 'quarantine:write',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const testCaseId = requireRouteId(event, 'testCaseId', 'test case ID');
  const user = await requireProjectAccess(event, projectId);

  const body = (await readBody(event).catch(() => null)) as { proposal?: unknown; reason?: unknown } | null;
  if (!isQuarantineProposal(body?.proposal)) {
    throw apiError({ statusCode: 400, message: 'proposal must be quarantine or release' });
  }
  const proposal = body.proposal;
  const reason = normalizeDismissReason(body.reason);

  const db = await getDatabase();
  try {
    const dismissed = await dismissQuarantineProposal(
      db,
      projectId,
      testCaseId,
      proposal,
      { channel: 'ui', userId: user.id },
      reason,
    );
    if (!dismissed) throw apiError({ statusCode: 404, message: `No ${proposal} proposal for this test` });
    return { success: true, proposal, dismissed };
  } catch (e: any) {
    if (e?.message === 'Test case not found in this project') {
      throw apiError({ statusCode: 404, message: e.message });
    }
    throw e;
  }
});
