import { getDatabase } from '../../database';
import { getRunsInProgress, type InstanceActivity } from '#shared/handlers/admin-activity';
import { requireAuth } from '../../utils/auth';
import { eventStreams, runUploads } from '../../utils/instance-activity';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Get what the instance is doing now',
    description:
      'What a restart would cut, across every project, so an upgrade can wait for it: `runsInProgress`, the runs initializing, running or finalizing, each with its `status` and `lastActivityAt` (when its reporter was last heard, most recent first); `uploadsInProgress`, the requests of this server process receiving the results or files of a run (a submit, an upload, case files, coverage, an import); and `openEventStreams`, the event streams it holds open (pages, live views, connected apps), for information, since they reconnect after a restart. The instance has nothing to wait for when `runsInProgress` is empty and `uploadsInProgress` is 0. Requires `settings:manage` (administrators only), with a session or an API key.',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event): Promise<InstanceActivity> => {
  await requireAuth(event);
  return {
    runsInProgress: await getRunsInProgress(await getDatabase()),
    uploadsInProgress: runUploads.value,
    openEventStreams: eventStreams.value,
  };
});
