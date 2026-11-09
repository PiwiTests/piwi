/** A run of bytes of a file, both ends included. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The bytes a `Range` header asks of a file of `size` bytes: one range, its
 * end held to the file's last byte. `unsatisfiable` when it starts past the
 * end of the file (answered 416). Null when the whole file is to be sent:
 * no header, another unit, several ranges, or a header that does not parse,
 * which a server may ignore.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const match = header?.trim().match(/^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i);
  if (!match) return null;
  const [, first, last] = match;
  if (!first && !last) return null;
  if (!first) {
    // A suffix: the last N bytes.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last ? Number(last) : size - 1;
  if (last && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
