import { getRequestWebStream } from 'h3';
import {
  LIVE_FRAME_TYPE,
  LIVE_WORKER_POST_LIMITS,
  MAX_LIVE_INSPECT_MESSAGE,
  MAX_LIVE_MESSAGE,
  decodeLiveMessage,
  readLiveWorkerPost,
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
      "What a test worker sends the run page's live view while its run executes. A frame of its test's page goes as one live message (`Content-Type: application/vnd.piwi.live-frame`: the header's length as a 32-bit big-endian number, the header as JSON `{ type: 'frame', worker, shard, slot, call, test, at }`, the data's length the same way, then the JPEG's bytes, 192 KB at most), to an instance that says what its viewers ask on the worker's stream; a reporter that predates it posts the frame as JSON (`{ type: 'frame', worker, shard, data, call, test }`, the JPEG in base64). Either form's image starts as a JPEG does (`FF D8 FF`). Every other message is JSON: why no frame shows (`{ type: 'frame', refused }`), that its test stopped or went on (`{ type: 'stop', stop }`), the call its test is in as Playwright logs it, in a CI run while someone watches it in full (`{ type: 'call-log', log, test }`: the call, its status, the call log's last lines as Playwright folds a failed call's, the point an input action acts on, the elements its locator matches while it waits, the viewport, how long it has run and its error's first line, with the test's title), that the test watched ended (`{ type: 'ended' }`), or that the developer stopped sharing the run (`{ type: 'unshared' }`): the worker's viewers hear why their view ended. While a full view asks for the worker's layers (the stream's `view` names them), it also posts what its page and its test's requests said (`{ type: 'page-event', event, at, test }`: a console error, an uncaught error, a failed request, a request pending long, the backend's logged error, an API call), the page's text (`{ type: 'text', text, test }`: its ARIA snapshot, 96 K characters at most, each field that holds a secret and each element the project masks hidden, or `{ type: 'text', refused }`), and the images of its test's filmstrip, each as one live message (`Content-Type: application/vnd.piwi.live-frame`, the header `{ type: 'thumb', worker, shard, slot, thumb, test }`, `thumb` naming the call, its title, its place in the strip, the image's size and when it was taken, then the JPEG's bytes, 128 KB at most). A frame, a call log or a layer goes to the people watching that worker who asked for it and is kept nowhere: not in the database, the logs or any export. While a full view has Inspect open (the stream's `view` says `inspect`), it also posts, each as one live message, the DOM snapshots its page's trace takes (`{ type: 'snapshot', worker, shard, slot, call, title, phase, page, frame, main, full, at, resources, test }`, `phase` one of `before`, `action` and `after`, `resources` each address the snapshot names with the file of the trace's resources it is, then the snapshot's JSON, 4 MB at most, the values of its secret fields removed), why it sends none (`{ type: 'snapshot', refused, test }`, no data), and the stylesheets, fonts and images other than SVG those snapshots name (`{ type: 'resource', worker, shard, slot, sha1, contentType }`, then the file's bytes, 2 MB at most; never a script, a document or an SVG). The instance takes them only while a watch has Inspect open on the worker and the project masks no element; it keeps a worker's snapshots of its pages' main frames, of its running test alone, its latest 32 MB, and the run's resources, the 64 MB used last, in memory only, until the run ends, and tells the watches with Inspect open of each snapshot, without its JSON. A frame of a worker nobody watches, or that only tiles show past 2 a second or past 48 KB, goes to nobody and counts against no rate of the run. Authenticated by the run's live view key (`Authorization: Bearer pdl_…`). 401 without a key of this run, 404 while the project has its live view off, 410 for one that ended with its run, 409 for a worker that holds no stream, and for a snapshot or a resource of a worker no watch has Inspect open on or of a project that masks elements, 413 for a message over its size, 429 past 8 frames, 8 call logs, 40 page events, 4 texts, 16 images of a filmstrip, 24 snapshots or 8 MB of resources a second of one worker, past 4 MB of images a second of the run's workers together, or, apart, past 16 MB of their snapshots and resources, 503 past the 512 MB the instance keeps of every run's Inspect.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/vnd.piwi.live-frame': {
          schema: {
            type: 'string',
            format: 'binary',
            description:
              "One live message: the header's length (32-bit big-endian), the header as JSON (a frame's, an image of the test's filmstrip, `type: 'thumb'`, a snapshot of the page, `type: 'snapshot'`, or a resource it names, `type: 'resource'`), the data's length the same way, then the data: the JPEG, the snapshot's JSON or the resource's bytes.",
          },
        },
        'application/json': {
          schema: {
            type: 'object',
            required: ['type', 'worker'],
            properties: {
              type: { type: 'string', enum: ['frame', 'stop', 'call-log', 'ended', 'unshared', 'page-event', 'text'] },
              worker: { type: 'integer', minimum: 0 },
              shard: { type: 'integer', minimum: 1, nullable: true },
              slot: { type: 'integer', minimum: 0 },
              data: {
                type: 'string',
                description: "A frame's JPEG in base64, from a reporter that predates live messages.",
              },
              refused: { type: 'string' },
              call: { type: 'object', nullable: true },
              test: { type: 'string', nullable: true },
              at: { type: 'number' },
              stop: { type: 'object', nullable: true },
              log: { type: 'object' },
              outcome: { type: 'object', nullable: true },
              event: { type: 'object', description: 'What the page or a request of the test said (`page-event`).' },
              text: { type: 'object', description: "The page's text, an ARIA snapshot, masked (`text`)." },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  liveViewRelay.noteRequest(id);
  await authorizeLiveViewKey(await getDatabase(), id, liveViewKeyOf(event));
  const binary = (getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim() === LIVE_FRAME_TYPE;
  const max = binary ? MAX_LIVE_INSPECT_MESSAGE : MAX_LIVE_MESSAGE;
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

/**
 * What comes as one live message: a frame, or an image of the test's filmstrip, its JPEG the data; a snapshot of the
 * page, its JSON the data, or why none goes; a resource a snapshot names, its bytes the data. Each type's data is held
 * to its own bound.
 */
function readBinary(bytes: Uint8Array): LiveRelayMessage | string {
  const message = decodeLiveMessage(bytes, LIVE_WORKER_POST_LIMITS);
  return typeof message === 'string' ? message : readLiveWorkerPost(message);
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
