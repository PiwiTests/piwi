import { boundTestOutput } from '@piwitests/core/test-output';

/**
 * What an attempt wrote to one stream (Playwright's `TestResult.stdout` or `stderr`), as the run keeps it: its chunks,
 * text or bytes read as UTF-8, joined in order, bounded and with what may be a secret hidden (`boundTestOutput`).
 * Null when it wrote nothing but white space.
 */
export function testOutputOf(chunks: ReadonlyArray<string | Uint8Array> | null | undefined): string | null {
  if (!chunks?.length) return null;
  const text = chunks
    .map((chunk) =>
      typeof chunk === 'string'
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8'),
    )
    .join('');
  return boundTestOutput(text);
}
