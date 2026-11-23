import { getDatabase } from '../../database';
import { getRunsInProgress, type InstanceActivity } from '#shared/handlers/admin-activity';
import { requireAuth } from '../../utils/auth';
import { diagnosesInProgress } from '../../utils/ai-diagnosis';
import { assistantAnswersInProgress } from '../../utils/assistant/running';
import { eventStreams, runRequests } from '../../utils/instance-activity';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Get what the instance is doing now',
    description:
      "What a restart would cut, so an upgrade can wait for it. `runsInProgress`: the runs of every project initializing, running or finalizing, each with its `status` and `lastActivityAt`, when its reporter was last heard, most recent first. A streaming reporter is heard at least every 15 seconds; a run quiet for longer is probably abandoned, and the instance interrupts it 2 minutes after its last activity, or after an hour while it is initializing (its global setup) or a sharded run waits for a shard, and settles a finalizing one after 10 minutes. The counts are this server process's: `requestsInProgress`, the requests that receive a run's results or files or end a run (`submit`, `upload`, `upload/results`, `import`, a run's `case-files`, `coverage` and `finish`, the desktop app's local imports, and a project's `coverage-reports` and `bug-reports`); `diagnosesInProgress`, the AI diagnoses running, a run's automatic ones included; `assistantAnswersInProgress`, the answers the assistant is writing; and `openEventStreams`, the event streams of pages, live views, connected apps and the desktop app, for information, since they reconnect after a restart (a diagnosis's stream counts as its diagnosis, an answer's as its answer, and MCP clients' streams are not counted). Not counted: the other work a run's end leaves running once `finish` has answered (notifications, issue tracker automation, pull-request feedback, auto-heal). The instance has nothing to wait for when `runsInProgress` is empty and the three counts after it are 0. Requires `settings:manage` (administrators only), with a session or an API key.",
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event): Promise<InstanceActivity> => {
  await requireAuth(event);
  return {
    runsInProgress: await getRunsInProgress(await getDatabase()),
    requestsInProgress: runRequests.value,
    diagnosesInProgress: diagnosesInProgress(),
    assistantAnswersInProgress: assistantAnswersInProgress(),
    openEventStreams: eventStreams.value,
  };
});
