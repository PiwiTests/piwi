import type { H3Event } from 'nitro/h3';
import { streamHeaders } from '#shared/stream-headers';
import { eventStreams } from './instance-activity';

const HEARTBEAT_INTERVAL_MS = 15000;

export function createSSEEndpoint(
  event: H3Event,
  onSubscribe: (controller: ReadableStreamDefaultController, encoder: TextEncoder) => (() => void) | undefined,
): Response {
  const encoder = new TextEncoder();
  // Aborted once the client is gone, the moment its connection closes or at once when it left before the stream opens.
  const gone = event.req.signal;
  let end: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      // A client that left while the handler awaited its checks is gone before the stream starts: subscribing it would
      // keep its listener and heartbeat for the life of the process.
      if (gone.aborted) {
        controller.close();
        return;
      }
      const unsubscribe = onSubscribe(controller, encoder) ?? (() => {});
      const uncount = eventStreams.open();

      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      }, HEARTBEAT_INTERVAL_MS);

      let ended = false;
      end = () => {
        if (ended) return;
        ended = true;
        uncount();
        clearInterval(heartbeatInterval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };
      gone.addEventListener('abort', end, { once: true });
    },
    cancel() {
      end?.();
    },
  });

  return new Response(stream, {
    headers: streamHeaders('text/event-stream'),
  });
}
