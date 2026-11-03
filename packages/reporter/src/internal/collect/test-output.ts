import { StringDecoder } from 'node:string_decoder';
import { boundTestOutput } from '@piwitests/core/test-output';

/**
 * What an attempt wrote to one stream (Playwright's `TestResult.stdout` or `stderr`), as the run keeps it: its chunks,
 * text or bytes read as UTF-8, joined in order, bounded and with what may be a secret hidden (`boundTestOutput`).
 * The bytes are decoded as one stream, so a character split across two chunks stays whole. Null when it wrote nothing
 * but white space.
 */
export function testOutputOf(chunks: ReadonlyArray<string | Uint8Array> | null | undefined): string | null {
  if (!chunks?.length) return null;
  const decoder = new StringDecoder('utf8');
  let text = '';
  for (const chunk of chunks) {
    text +=
      typeof chunk === 'string'
        ? decoder.end() + chunk
        : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return boundTestOutput(text + decoder.end());
}
