import { getRequestWebStream } from 'h3';
import { MAX_LIVE_MESSAGE, readWorkerToInstance } from '@piwitests/core/live-view';
import { readStreamWithin } from '../../../utils/body-limit';
import { liveViewKeyOf, liveViewRelay, refuseLiveViewKey } from '../../../utils/live-view';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Post to the live view of a run',
    description:
      "What a test worker sends the run page's live view while its run executes: a frame of its test's page (`{ type: 'frame', worker, shard, data, call, test }`, a JPEG in base64 of 192 KB at most, with the call it was taken at and the test's title), why none shows (`{ type: 'frame', refused }`), that its test stopped or went on (`{ type: 'stop', stop }`), the call its test is in as Playwright logs it, in a CI run while someone watches (`{ type: 'call-log', log }`: the call, its status, the call log's last 12 lines, the point an input action acts on, the elements its locator matches while it waits, the viewport, how long it has run and its error's first line, or null), that the test watched ended (`{ type: 'ended' }`), or that the developer stopped sharing the run (`{ type: 'unshared' }`): the worker's viewers hear why their view ended. A frame or a call log goes to the people watching that worker and is kept nowhere: not in the database, the logs or any export. Authenticated by the run's live view key (`Authorization: Bearer pdl_…`). 401 without a key of this run, 404 for a key that ended as the project turned its live view off, 410 for one that ended with its run, 409 for a worker that holds no stream, 413 for a message over its size, 429 past 8 frames or 4 call logs a second of one worker.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  liveViewRelay.noteRequest(id);
  const key = liveViewKeyOf(event);
  if (!liveViewRelay.authorize(id, key)) refuseLiveViewKey(id, key);
  const length = Number(getRequestHeader(event, 'content-length'));
  if (!Number.isFinite(length) || length > MAX_LIVE_MESSAGE) {
    throw apiError({ statusCode: 413, message: `A message is ${Math.round(MAX_LIVE_MESSAGE / 1024)} KB at most` });
  }
  const bytes = await readStreamWithin(getRequestWebStream(event), MAX_LIVE_MESSAGE);
  if (!bytes)
    throw apiError({ statusCode: 413, message: `A message is ${Math.round(MAX_LIVE_MESSAGE / 1024)} KB at most` });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw apiError({ statusCode: 400, message: 'The message is not JSON' });
  }
  const message = readWorkerToInstance(body);
  if (typeof message === 'string') throw apiError({ statusCode: 400, message });
  const refused = liveViewRelay.receive(id, message);
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
  return { success: true };
});
