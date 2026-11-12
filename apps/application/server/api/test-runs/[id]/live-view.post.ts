import { getRequestWebStream } from 'h3';
import {
  LIVE_FRAME_TYPE,
  MAX_LIVE_FRAME,
  MAX_LIVE_FRAME_MESSAGE,
  MAX_LIVE_MESSAGE,
  decodeLiveMessage,
  readLiveWorkerFrame,
  readWorkerToInstance,
} from '@piwitests/core/live-view';
import { getDatabase } from '../../../database';
import { readStreamWithin } from '../../../utils/body-limit';
import { authorizeLiveViewKey, liveViewKeyOf, liveViewRelay, type LiveRelayMessage } from '../../../utils/live-view';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Post to the live view of a run',
    description:
      "What a test worker sends the run page's live view while its run executes. A frame of its test's page goes as one live message (`Content-Type: application/vnd.piwi.live-frame`: the header's length as a 32-bit big-endian number, the header as JSON `{ type: 'frame', worker, shard, slot, call, test, at }`, the data's length the same way, then the JPEG's bytes, 192 KB at most), to an instance that says what its viewers ask on the worker's stream; a reporter that predates it posts the frame as JSON (`{ type: 'frame', worker, shard, data, call, test }`, the JPEG in base64). Every other message is JSON: why no frame shows (`{ type: 'frame', refused }`), that its test stopped or went on (`{ type: 'stop', stop }`), the call its test is in as Playwright logs it, in a CI run while someone watches (`{ type: 'call-log', log, test }`: the call, its status, the call log's last lines as Playwright folds a failed call's, the point an input action acts on, the elements its locator matches while it waits, the viewport, how long it has run and its error's first line, with the test's title), that the test watched ended (`{ type: 'ended' }`), or that the developer stopped sharing the run (`{ type: 'unshared' }`): the worker's viewers hear why their view ended. A frame or a call log goes to the people watching that worker and is kept nowhere: not in the database, the logs or any export. Authenticated by the run's live view key (`Authorization: Bearer pdl_…`). 401 without a key of this run, 404 while the project has its live view off, 410 for one that ended with its run, 409 for a worker that holds no stream, 413 for a message over its size, 429 past 8 frames or 8 call logs a second of one worker, or past 4 MB of images a second of the run's workers together.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  liveViewRelay.noteRequest(id);
  await authorizeLiveViewKey(await getDatabase(), id, liveViewKeyOf(event));
  const binary = (getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim() === LIVE_FRAME_TYPE;
  const max = binary ? MAX_LIVE_FRAME_MESSAGE : MAX_LIVE_MESSAGE;
  const tooLong = `A message is ${Math.round(max / 1024)} KB at most`;
  const length = Number(getRequestHeader(event, 'content-length'));
  if (!Number.isFinite(length) || length > max) throw apiError({ statusCode: 413, message: tooLong });
  const bytes = await readStreamWithin(getRequestWebStream(event), max);
  if (!bytes) throw apiError({ statusCode: 413, message: tooLong });
  const message = binary ? readBinary(bytes) : readJson(bytes);
  if (typeof message === 'string') throw apiError({ statusCode: 400, message });
  const refused = liveViewRelay.receive(id, message);
  if (refused) throw apiError({ statusCode: refused.status, message: refused.message });
  return { success: true };
});

/** A frame posted as one live message, its JPEG the data. */
function readBinary(bytes: Uint8Array): LiveRelayMessage | string {
  const message = decodeLiveMessage(bytes, { maxData: MAX_LIVE_FRAME });
  return typeof message === 'string' ? message : readLiveWorkerFrame(message);
}

/** A message posted as JSON: a frame's image in base64, as a reporter that predates live messages sends it. */
function readJson(bytes: Uint8Array): LiveRelayMessage | string {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return 'The message is not JSON';
  }
  const message = readWorkerToInstance(body);
  if (typeof message === 'string' || message.type !== 'frame' || !('data' in message)) return message;
  const { data, ...frame } = message;
  return { ...frame, image: new Uint8Array(Buffer.from(data, 'base64')) };
}
