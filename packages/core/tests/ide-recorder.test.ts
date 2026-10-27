import { describe, expect, test } from 'vitest';
import {
  MAX_HANDOFF_LINE,
  formatRecordChannel,
  lineReader,
  parseHandoffToEditor,
  parseHandoffToTest,
  parseRecordChannel,
} from '../src/ide-recorder';

describe('the record channel', () => {
  const token = 'a'.repeat(24);

  test('names a socket path and a token, a named pipe on Windows too', () => {
    expect(parseRecordChannel(formatRecordChannel({ path: '/tmp/piwi/record.sock', token }))).toEqual({
      path: '/tmp/piwi/record.sock',
      token,
    });
    expect(parseRecordChannel(`\\\\.\\pipe\\piwi-record-1#${token}`)).toEqual({
      path: '\\\\.\\pipe\\piwi-record-1',
      token,
    });
    expect(parseRecordChannel('/tmp/piwi/record.sock#short')).toBeNull();
    expect(parseRecordChannel(`#${token}`)).toBeNull();
    expect(parseRecordChannel(undefined)).toBeNull();
  });

  test('reads what the test sends, field by field', () => {
    const attach = {
      type: 'attach',
      token,
      file: '/w/tests/cart.spec.ts',
      line: 12,
      reason: 'breakpoint',
      testIdAttribute: '',
      baseURL: 'http://localhost:3000',
    };
    expect(parseHandoffToEditor(JSON.stringify(attach))).toEqual({ ...attach, testIdAttribute: null });
    expect(parseHandoffToEditor(JSON.stringify({ ...attach, line: 0 }))).toBeNull();
    expect(parseHandoffToEditor(JSON.stringify({ ...attach, reason: 'other' }))).toBeNull();
    expect(parseHandoffToEditor(JSON.stringify({ type: 'binding', call: 3, payload: { kind: 'local-get' } }))).toEqual({
      type: 'binding',
      call: 3,
      outside: false,
      payload: { kind: 'local-get' },
    });
    expect(parseHandoffToEditor('{"type":"loaded"}')).toEqual({ type: 'loaded' });
    expect(parseHandoffToEditor('not json')).toBeNull();
    expect(parseHandoffToEditor('{"type":"launch"}')).toBeNull();
  });

  test('reads what the editor sends, field by field', () => {
    expect(parseHandoffToTest('{"type":"load","bundle":"/x/record-ide.js"}')).toEqual({
      type: 'load',
      bundle: '/x/record-ide.js',
    });
    expect(parseHandoffToTest('{"type":"answer","call":1,"value":{"ok":true}}')).toEqual({
      type: 'answer',
      call: 1,
      value: { ok: true },
    });
    expect(parseHandoffToTest('{"type":"refused","message":"No editor."}')).toEqual({
      type: 'refused',
      message: 'No editor.',
    });
    expect(parseHandoffToTest('{"type":"load"}')).toBeNull();
    expect(parseHandoffToTest('[]')).toBeNull();
  });

  test('splits a stream into its lines as they arrive, and gives up on a line too long', () => {
    const lines: string[] = [];
    let overflowed = 0;
    const read = lineReader(
      (line) => lines.push(line),
      () => overflowed++,
    );
    read('{"a":1}\n{"b"');
    read(':2}\n\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    read('x'.repeat(MAX_HANDOFF_LINE + 1));
    expect(overflowed).toBe(1);
    read('{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
