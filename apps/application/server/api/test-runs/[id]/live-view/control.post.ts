import { eq } from 'drizzle-orm';
import { isLiveControlCommand, readLiveWorkerId } from '@piwitests/core/live-view';
import { CONTROL_DONE, PAUSE_SETTING_OFF, liveWorkerName } from '#shared/live-view';
import { projects } from '../../../../database/schema';
import { isAuthEnabled } from '../../../../utils/auth';
import { liveViewRelay } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Pause, resume or end a CI test',
    description:
      "**Pause**, **Resume** and **End the test** of a CI test, for the people who may control its project's runs, while the project lets them (`liveViewPause`, beside `liveViewHold`). `{ watch, worker, shard?, slot?, command }`: `watch` is the id the caller's own watch of the run opened with (`hello`), which must show that worker in full now; `command` is `pause` (the test stops before its next call and waits there, its timeout suspended, for the project's `liveViewHoldMinutes` at most, or until the last controller stops watching it in full), `resume` (a paused test goes on; before the test paused, it takes the Pause back) or `end` (a paused test fails there at once with `Ended from Piwi by <name>`, its retries running as after any failure, the call it stopped before never running). The worker says on its stream whether it took a Pause or dropped it and why (no test running, its function ended, nobody who may control the run watching it in full), which the run page hears with the worker; one Pause waits at a time. The instance sends the command on that worker's own live view stream, and logs it (the run, the worker, the command and who asked) at info level; nothing is stored. The paused stop reaches the run page with the name of who paused it. Answers `{ success: true, message }`. 400 for a body that names no watch, no worker or another command; 404 for a watch this person does not hold in this run; 409 while the project does not let its controllers pause a CI test, for a watch that shows another worker, a worker whose reporter cannot pause, `pause` while the test stands at a stop or while another Pause waits (naming who asked it), `resume` while neither paused nor asked to pause, and `end` while it is not paused. Requires `run:control` (Maintainer and above on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['watch', 'worker', 'command'],
            properties: {
              watch: { type: 'string' },
              worker: { type: 'integer', minimum: 0 },
              shard: { type: 'integer', minimum: 1, nullable: true },
              slot: { type: 'integer', minimum: 0 },
              command: { type: 'string', enum: ['pause', 'resume', 'end'] },
            },
          },
        },
      },
    },
    'x-required-permission': 'run:control',
  },
});

/** How the log names each command. */
const LOGGED = { pause: 'Pause', resume: 'Resume', end: 'End the test' } as const;

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(
    event,
    id,
    resolveRunProjectId,
    'Test run',
    'run:control',
  );
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null;
  const worker = body && typeof body === 'object' ? readLiveWorkerId(body.shard, body.worker, body.slot) : null;
  const command = body?.command;
  if (!body || typeof body.watch !== 'string' || !worker || !isLiveControlCommand(command)) {
    throw apiError({
      statusCode: 400,
      message: 'Name your watch of the run, the worker it shows, and the command: pause, resume or end',
    });
  }
  const [project] = await db
    .select({ hold: projects.liveViewHold, pause: projects.liveViewPause })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project?.hold || !project.pause) throw apiError({ statusCode: 409, message: PAUSE_SETTING_OFF });
  const auth = isAuthEnabled();
  const answer = liveViewRelay.control(id, body.watch, auth ? user.id : null, worker, command);
  if ('status' in answer) throw apiError({ statusCode: answer.status, message: answer.message });
  const who = auth ? `${user.name || user.username} (user #${user.id})` : 'a viewer (authentication off)';
  console.info(`[live-view] ${LOGGED[command]}: run #${id}, ${liveWorkerName(answer.worker)}, by ${who}`);
  return { success: true, message: CONTROL_DONE[command] };
});
