import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createSSEEndpoint } from '../../server/utils/sse';
import { openEventStream } from '../../server/utils/event-stream';
import { testEvent } from './h3-event';

/** An event, its request and response as Node holds them once the handler's awaits are done, and its client leaving. */
function nodeEvent(clientGone: boolean) {
  const gone = new AbortController();
  if (clientGone) gone.abort();
  const req = Object.assign(new EventEmitter(), { destroyed: clientGone });
  const res = Object.assign(new EventEmitter(), {
    closed: clientGone,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  return { event: testEvent({ signal: gone.signal, node: { req, res } }), leave: () => gone.abort() };
}

describe('an event stream whose client left before it opened', () => {
  test('subscribes nothing, so no listener or heartbeat outlives the request', () => {
    const unsubscribe = vi.fn();
    const onSubscribe = vi.fn(() => unsubscribe);

    createSSEEndpoint(nodeEvent(true).event, onSubscribe);

    expect(onSubscribe).not.toHaveBeenCalled();
  });

  test('a client still there is subscribed, and unsubscribed when it leaves', () => {
    const unsubscribe = vi.fn();
    const { event, leave } = nodeEvent(false);

    createSSEEndpoint(event, () => unsubscribe);
    expect(unsubscribe).not.toHaveBeenCalled();
    leave();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('a stream written to the response is closed from the start, and tells its listeners at once', () => {
    const sink = openEventStream(nodeEvent(true).event);
    const onClose = vi.fn();
    sink.onClose(onClose);

    expect(sink.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
