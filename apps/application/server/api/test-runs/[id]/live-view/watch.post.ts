import { readLiveViewSize, readLiveWorkerId } from '@piwitests/core/live-view';
import { readLaneLayers } from '@piwitests/core/live-layers';
import { isAuthEnabled } from '../../../../utils/auth';
import { liveViewRelay, type LiveWatchAsk } from '../../../../utils/live-view';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Change what a watch of a live run shows',
    description:
      "Changes what a page's watch of a live run (`GET` on this path) shows, on the stream it holds, without opening another: `{ watch, focus?, tiles?, width?, height?, layers?, text? }`. `watch` is the id the watch's stream opened with (`hello`). `focus` names the worker to show in full (`{ worker, shard?, slot? }`, with `slot` the worker's lane, which the view follows, waiting 30 s for the worker Playwright starts in it again), or `null` for none; `tiles` shows every other worker's image as a tile, one a second, or stops; `width` and `height`, both or neither, are the size the page shows the full view at, in device pixels from 1, held within 320 by 200 and 1280 by 800; `layers` the layers the full view takes beside the images (`events`, `text`, `filmstrip`: the page's events, its text, the test's filmstrip, which the worker sends again to a watch that takes it anew); `text: true` asks the worker shown in full for its page's text now, for a watch that takes `text`. A field left out stays as it was. The worker shown before hears it is watched less, the one shown now that it is watched, and what its viewers ask of its images. Answers what the watch shows then (`watch`: `focus` as asked, or `null`, `tiles`, `width`, `height` and `layers`). 400 for a body that names none of them or names one wrongly; 404 for a watch this person does not hold in this run, or a full view of a worker not in the run's live view, nor of a lane waiting for its next worker: the watch then shows no full view, the other fields applied, and the answer's `data.watch` says what it shows; 429 past 5 changes of a watch a second (the watch stays as it was).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['watch'],
            properties: {
              watch: { type: 'string' },
              focus: {
                type: 'object',
                nullable: true,
                properties: {
                  worker: { type: 'integer', minimum: 0 },
                  shard: { type: 'integer', minimum: 1, nullable: true },
                  slot: { type: 'integer', minimum: 0 },
                },
              },
              tiles: { type: 'boolean' },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
              layers: { type: 'array', items: { type: 'string', enum: ['events', 'text', 'filmstrip'] } },
              text: { type: 'boolean', enum: [true] },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'What the watch shows now.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                watch: {
                  type: 'object',
                  properties: {
                    focus: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        worker: { type: 'integer' },
                        shard: { type: 'integer', nullable: true },
                        slot: { type: 'integer' },
                      },
                    },
                    tiles: { type: 'boolean' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    layers: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { user } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || typeof body.watch !== 'string') {
    throw apiError({ statusCode: 400, message: 'Name the watch by the id its stream opened with' });
  }
  const ask: LiveWatchAsk = {};
  if (body.focus === null) ask.focus = null;
  else if (body.focus !== undefined) {
    const focus = body.focus as Record<string, unknown> | null;
    const worker = focus && typeof focus === 'object' ? readLiveWorkerId(focus.shard, focus.worker, focus.slot) : null;
    if (!worker) throw apiError({ statusCode: 400, message: 'focus names a worker from 0, and a shard from 1' });
    ask.focus = worker;
  }
  if (body.tiles !== undefined) {
    if (typeof body.tiles !== 'boolean') throw apiError({ statusCode: 400, message: 'tiles is true or false' });
    ask.tiles = body.tiles;
  }
  if (body.width !== undefined || body.height !== undefined) {
    const size =
      typeof body.width === 'number' && typeof body.height === 'number'
        ? readLiveViewSize(body.width, body.height)
        : null;
    if (!size) throw apiError({ statusCode: 400, message: 'width and height are whole numbers of device pixels' });
    ask.size = size;
  }
  if (body.layers !== undefined) {
    const layers = readLaneLayers(body.layers);
    if (!layers) throw apiError({ statusCode: 400, message: 'layers is a list of events, text and filmstrip' });
    ask.layers = layers;
  }
  if (body.text !== undefined) {
    if (body.text !== true)
      throw apiError({ statusCode: 400, message: 'text is true, to ask for the page’s text now' });
    ask.text = true;
  }
  if (!Object.keys(ask).length)
    throw apiError({ statusCode: 400, message: 'Say what the watch shows: focus, tiles, size, layers or text' });
  const person = isAuthEnabled(event) ? user.id : null;
  const { refused, shown } = liveViewRelay.changeWatch(id, body.watch, person, ask);
  if (refused) {
    throw apiError({
      statusCode: refused.status,
      message: refused.message,
      ...(shown ? { data: { watch: shown } } : {}),
    });
  }
  return { success: true, watch: shown };
});
