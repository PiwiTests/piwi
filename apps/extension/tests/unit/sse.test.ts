import { describe, expect, it } from 'vitest';
import { EventParser, MAX_EVENT } from '../../src/background/sse';

describe('the events of a server-sent events body', () => {
  it('reads each event’s data, its lines joined, across chunks and line breaks', () => {
    const parser = new EventParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\ndata: b\r\n\r\n: heartbeat\n\nid: 3\ndata:c\n')).toEqual(['a\nb']);
    expect(parser.push('\n')).toEqual(['c']);
  });

  it('drops an over-long line to its end, never reading its tail as a line of its own', () => {
    const parser = new EventParser();
    const half = 'x'.repeat(MAX_EVENT / 2 + 1);
    // An over-long line whose tail looks like a field: the tail is part of the line dropped.
    expect(parser.push(`data: before\n\ndata: ${half}`)).toEqual(['before']);
    expect(parser.push(half)).toEqual([]);
    expect(parser.push(`${half}\ndata: tail\n\n`)).toEqual([]);
    expect(parser.push('data: next\n\n')).toEqual(['next']);
    // Its end a carriage return that waits for its line feed.
    expect(parser.push(`data: ${half}${half}${half}\r`)).toEqual([]);
    expect(parser.push('\n\ndata: after\n\n')).toEqual(['after']);
  });
});
