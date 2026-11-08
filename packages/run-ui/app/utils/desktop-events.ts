/**
 * The desktop app window's event stream from the bundled server
 * (`/api/desktop/events`): live run progress and `open-page` requests.
 *
 * Every listener shares one EventSource, because the webview keeps only a few
 * connections open per origin and each stream holds one. EventSource is used
 * (not polling) because it keeps delivering while the window is hidden, where
 * background timers are throttled to ~1/min; it reconnects on its own after an
 * error, and the server resends its run snapshot on each connection.
 */

/** One message on the stream; `type` tells them apart, the other fields depend on it. */
export interface DesktopEventMessage {
  type: string;
  [field: string]: unknown;
}

type DesktopEventListener = (message: DesktopEventMessage) => void;

const listeners = new Set<DesktopEventListener>();
let source: EventSource | null = null;

/** Receive every message on the desktop event stream, opening it on first use; returns the unsubscribe function. */
export function subscribeDesktopEvents(listener: DesktopEventListener): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource('/api/desktop/events');
    source.onmessage = (event) => {
      let message: DesktopEventMessage;
      try {
        message = JSON.parse(event.data) as DesktopEventMessage;
      } catch {
        return; // a malformed frame
      }
      for (const each of listeners) {
        try {
          each(message);
        } catch {
          // One listener failing must not starve the others.
        }
      }
    };
  }
  return () => {
    listeners.delete(listener);
  };
}
