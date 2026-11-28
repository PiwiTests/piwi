import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { findCiDispatch } from '#shared/handlers/ci-dispatches';
import { ciDispatchForReader } from '#shared/ci-dispatches';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['CI dispatches'],
    summary: 'Read a CI dispatch',
    description:
      "One CI dispatch, by the 16-hex-digit id `POST /api/projects/{id}/ci-dispatches` answered (the id the run it starts hands back as `PIWI_ORIGIN_REF`): `actionId` and `actionName` (the action, and its name when it was dispatched), `kind` (`tests`, `suite`, `tags`, `flakeLab`), `origin` (`page`, `mcp`, `api`), `provider` and `preset`, `url` (the provider's run once known, else its runs list), `args` (the arguments handed to CI), `ref` (the branch; null when the target runs its configured branch), `tests` (how many tests the arguments name; null for a whole suite and tagged tests), `state`, `detail` (the provider's error for a refused dispatch, to a caller who holds `run:control` on its project, else null), `runId` and `run` (the matched run as it stands: `id`, `status`, `totalTests`, `passedTests`, `failedTests`), `at` (epoch ms), `byName` and `byUserId`. `state` is `dispatched` until a run reports, `running` once one is matched, `ended` once it finishes, `unreported` when none reported within six hours, and `refused` when the provider refused it. An unknown id, and a dispatch of a project the caller cannot read, answer 404.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'The dispatch' },
      404: { description: 'No dispatch the caller can read has this id' },
    },
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = getRouterParam(event, 'id') ?? '';
  const found = /^[0-9a-f]{16}$/.test(id) ? await findCiDispatch(await getDatabase(), id) : null;
  const access = await getRequestAccess(event);
  // A dispatch of a project the caller cannot read answers as one that does not exist.
  if (!found || !can(access, 'project:read', found.projectId)) {
    throw apiError({ statusCode: 404, message: 'CI dispatch not found' });
  }
  return ciDispatchForReader(found.dispatch, can(access, 'run:control', found.projectId));
});
