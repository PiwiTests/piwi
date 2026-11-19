import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { LIVE_STREAM_TYPE } from '@piwitests/core/live-view';
import { ASSISTANT_STREAM_HEADERS } from '#shared/assistant';
import { streamHeaders } from '#shared/stream-headers';
import { openEventStream, openLiveStream } from '../../server/utils/event-stream';
import { createSSEEndpoint } from '../../server/utils/sse';

/** What every response read as it arrives carries, so a proxy in front passes it on unbuffered and untouched. */
const UNBUFFERED = {
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

/** The request and response of an event whose client is still there. */
function nodeEvent() {
  const req = Object.assign(new EventEmitter(), { destroyed: false });
  const res = Object.assign(new EventEmitter(), {
    closed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  return { node: { req, res } } as never as Parameters<typeof openEventStream>[0] & {
    node: { res: { writeHead: ReturnType<typeof vi.fn> } };
  };
}

describe('the headers of a streamed response', () => {
  test('streamHeaders names the type and tells a proxy not to buffer or transform the body', () => {
    expect(streamHeaders('text/event-stream')).toEqual({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      ...UNBUFFERED,
    });
  });

  test.each([
    ['an event stream written to the response (a worker of the live view)', openEventStream, 'text/event-stream'],
    ['a live stream (a watch of the live view)', openLiveStream, LIVE_STREAM_TYPE],
  ])('%s opens with them', (_name, open, type) => {
    const event = nodeEvent();
    open(event).close();

    expect(event.node.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': type }));
    expect(event.node.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining(UNBUFFERED));
  });

  test('an event stream returned as a response (live runs, notifications, the desktop hubs) carries them', () => {
    const response = createSSEEndpoint(nodeEvent(), () => undefined);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe(UNBUFFERED['Cache-Control']);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    void response.body?.cancel();
  });

  test("the assistant's answer stream carries them", () => {
    expect(ASSISTANT_STREAM_HEADERS).toMatchObject({ 'Content-Type': 'text/event-stream', ...UNBUFFERED });
  });
});

const root = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

/** A Content-Type set by hand to a type read as it arrives, as a header object's key or `setResponseHeader`'s. */
const STREAM_TYPE_BY_HAND =
  /['"]Content-Type['"]\s*[:,]\s*(?:['"](?:text\/event-stream|application\/vnd\.piwi\.live-stream)|LIVE_STREAM_TYPE)/i;

test('every streamed response takes its headers from streamHeaders', () => {
  const byHand = ['server', 'shared', join('app', 'demo')]
    .flatMap((dir) => sources(join(root, dir)))
    .filter((path) => STREAM_TYPE_BY_HAND.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path));

  expect(byHand, 'set these headers with streamHeaders (#shared/stream-headers)').toEqual([]);
});
