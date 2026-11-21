import { eq } from 'drizzle-orm';
import { readLiveWorkerId } from '@piwitests/core/live-view';
import { liveWorkerName } from '#shared/live-view';
import { projects } from '../../../../database/schema';
import { isAuthEnabled } from '../../../../utils/auth';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Let a held CI test go',
    description:
      "**Let it go**: a CI test held at its failure for the people who may control its project's runs (the project's `liveViewHold` setting, while one of them watches its worker in full) ends its hold, then tears down as it would have, its result unchanged. `{ watch, worker, shard?, slot? }`: `watch` is the id the caller's own watch of the run opened with (`hello`), which must show that worker in full now. The instance sends the command on that worker's own live view stream, and logs it (the run, the worker and who asked) at info level; nothing is stored. Answers `{ success: true, message }`. 400 for a body that names no watch or no worker; 404 for a watch this person does not hold in this run; 409 while the project does not hold failing CI tests, for a watch that shows another worker, or a worker that holds no failing test (a worker of a reporter that cannot hold included). Requires `run:control` (Maintainer and above on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['watch', 'worker'],
            properties: {
              watch: { type: 'string' },
              worker: { type: 'integer', minimum: 0 },
              shard: { type: 'integer', minimum: 1, nullable: true },
              slot: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
    'x-required-permission': 'run:control',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null;
  const worker = body && typeof body === 'object' ? readLiveWorkerId(body.shard, body.worker, body.slot) : null;
  if (!body || typeof body.watch !== 'string' || !worker) {
    throw apiError({ statusCode: 400, message: 'Name your watch of the run, and the worker it shows' });
  }
  const [project] = await db.select({ hold: projects.liveViewHold }).from(projects).where(eq(projects.id, projectId));
  if (!project?.hold) {
    throw apiError({
      statusCode: 409,
      message:
        "The project's setting is off: a Project admin turns on Hold a failing CI test in Project → Settings → Live view.",
    });
  }
  const auth = isAuthEnabled(event);
  const answer = liveViewRelay.letGo(id, body.watch, auth ? user.id : null, worker);
  if ('status' in answer) throw apiError({ statusCode: answer.status, message: answer.message });
  const who = auth ? `${user.name || user.username} (user #${user.id})` : 'a viewer (authentication off)';
  console.info(`[live-view] Let it go: run #${id}, ${liveWorkerName(answer.worker)}, by ${who}`);
  return { success: true, message: 'The test goes on: it tears down as it would have, its result unchanged.' };
});
