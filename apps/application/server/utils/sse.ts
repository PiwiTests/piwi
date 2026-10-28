import type { H3Event } from 'h3';

const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * A stream of server-sent events: `onSubscribe` enqueues them and returns its unsubscribe, called once the client
 * leaves. With `strategy`, the queue counts what the client has not read yet as the strategy measures it
 * (`ByteLengthQueuingStrategy`: bytes, read as `-controller.desiredSize` with a high-water mark of 0).
 */
export function createSSEEndpoint(
  event: H3Event,
  onSubscribe: (controller: ReadableStreamDefaultController, encoder: TextEncoder) => (() => void) | undefined,
  strategy?: QueuingStrategy<Uint8Array>,
): Response {
  const encoder = new TextEncoder();
  const source: UnderlyingDefaultSource<Uint8Array> = {
    start(controller) {
      const unsubscribe = onSubscribe(controller, encoder) ?? (() => {});

      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      }, HEARTBEAT_INTERVAL_MS);

      event.node.req.on('close', () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  };
  const stream = new ReadableStream<Uint8Array>(source, strategy);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
