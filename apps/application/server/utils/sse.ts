import type { H3Event } from 'h3';

const HEARTBEAT_INTERVAL_MS = 15000;

export function createSSEEndpoint(
  event: H3Event,
  onSubscribe: (controller: ReadableStreamDefaultController, encoder: TextEncoder) => (() => void) | undefined,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
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
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
