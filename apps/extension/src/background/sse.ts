/**
 * The `data` of each event of a server-sent events body, chunk by chunk: an event's `data:` lines joined with a line
 * break. Comments, such as the instance's heartbeat, and the other fields are skipped; an event without data is none.
 * At most `MAX_EVENT` characters wait for an event's end: past it, the event is dropped.
 */
export const MAX_EVENT = 1024 * 1024;

export class EventParser {
  private rest = '';
  private data: string[] = [];
  private size = 0;

  /** The events this chunk completes. */
  push(chunk: string): string[] {
    let text = this.rest + chunk;
    // A carriage return at the end may be the first half of a CRLF: it waits for the next chunk.
    const held = text.endsWith('\r') ? '\r' : '';
    if (held) text = text.slice(0, -1);
    const lines = text.split(/\r\n|\r|\n/);
    this.rest = lines.pop()! + held;
    if (this.rest.length > MAX_EVENT) this.rest = '';
    const events: string[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length && this.size <= MAX_EVENT) events.push(this.data.join('\n'));
        this.data = [];
        this.size = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      if ((colon < 0 ? line : line.slice(0, colon)) !== 'data') continue;
      const value = colon < 0 ? '' : line.slice(colon + 1);
      this.size += value.length;
      if (this.size <= MAX_EVENT) this.data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    return events;
  }
}
