import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createSSEEndpoint } from '../../server/utils/sse';
import { openEventStream } from '../../server/utils/event-stream';

/** The request and response of an event, as Node holds them once the handler's awaits are done. */
function nodeEvent(clientGone: boolean) {
  const req = Object.assign(new EventEmitter(), { destroyed: clientGone });
  const res = Object.assign(new EventEmitter(), {
    closed: clientGone,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  return { node: { req, res } } as never as Parameters<typeof createSSEEndpoint>[0] & {
    node: { req: EventEmitter; res: EventEmitter };
  };
}

describe('an event stream whose client left before it opened', () => {
  test('subscribes nothing, so no listener or heartbeat outlives the request', () => {
    const unsubscribe = vi.fn();
    const onSubscribe = vi.fn(() => unsubscribe);

    createSSEEndpoint(nodeEvent(true), onSubscribe);

    expect(onSubscribe).not.toHaveBeenCalled();
  });

  test('a client still there is subscribed, and unsubscribed when it leaves', () => {
    const unsubscribe = vi.fn();
    const event = nodeEvent(false);

    createSSEEndpoint(event, () => unsubscribe);
    expect(unsubscribe).not.toHaveBeenCalled();
    event.node.req.emit('close');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('a stream written to the response is closed from the start, and tells its listeners at once', () => {
    const sink = openEventStream(nodeEvent(true));
    const onClose = vi.fn();
    sink.onClose(onClose);

    expect(sink.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
