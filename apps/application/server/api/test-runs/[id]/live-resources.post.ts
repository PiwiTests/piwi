import { getDatabase } from '../../../database';
import { authorizeStreamToken } from '../../../utils/stream-auth';
import { runEventBus } from '../../../utils/run-events';
import { isPassiveCapabilityDeclined } from '#shared/handlers/capabilities';
import { sanitizeLiveResources } from '#shared/live-resources';
import type { WireLiveResourcesAnswer } from '#shared/types';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Send what a streaming run used so far',
    description:
      "While someone has a streaming run open, the reporter posts what its run sampler and the capture fixtures measured since its last post: the machine's CPU, the run's memory, each worker's CPU and memory, and each worker's open pages, on the same clock as the run's resource timeline. The server keeps them in memory until the run ends and streams each post to the run's live viewers, so the workers timeline draws them as the run goes; nothing is stored, the run's report still comes with `finish`. With `reset` the post holds every point so far and replaces what the server holds for that reporter; without it, it adds the points read since the last post, and replaces the open pages of each worker it names. The answer's `watched` says whether anyone still has the run open, `resync` that the server holds nothing for this reporter, so its next post carries every point, and `declined` that the project declined the resources capability, so the reporter posts nothing more. Requires the stream token.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              streamToken: { type: 'string' },
              shardIndex: { type: 'integer', nullable: true },
              reset: { type: 'boolean' },
              timeline: { type: 'object' },
              memoryCapacityBytes: { type: 'number', nullable: true },
              memoryKind: { type: 'string', enum: ['pss', 'rss'], nullable: true },
            },
            required: ['streamToken', 'timeline'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event): Promise<WireLiveResourcesAnswer> => {
  const id = parseInt(getRouterParam(event, 'id') || '0');
  if (!id) throw apiError({ statusCode: 400, message: 'Invalid test run ID' });

  const body = await readBody(event);
  if (!body?.streamToken) throw apiError({ statusCode: 401, message: 'Missing stream token' });

  const db = await getDatabase();
  const { projectId } = await authorizeStreamToken(db, id, body.streamToken);

  let declined = runEventBus.liveResourcesDeclinedFor(id);
  if (declined === undefined) {
    declined = await isPassiveCapabilityDeclined(db, projectId, 'resources');
    runEventBus.noteLiveResourcesDeclined(id, declined);
  }
  if (declined) return { watched: false, declined: true };

  const post = sanitizeLiveResources(body);
  if (!post) throw apiError({ statusCode: 400, message: 'The post carries no resource series' });

  const applied = runEventBus.applyLiveResources(id, post);
  if (applied) runEventBus.publish(id, { type: 'resources', data: post });
  return applied ? { watched: runEventBus.isWatched(id) } : { watched: runEventBus.isWatched(id), resync: true };
});
