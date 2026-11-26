import type { H3Event } from 'nitro/h3';
import { testEvent } from './h3-event';

/** One part of a multipart body: a value field, or a file part when it has a filename. */
export interface MultipartPart {
  name: string;
  data: Buffer;
  filename?: string;
}

/**
 * A route event whose request streams `parts` as the reporter sends them: a
 * chunked `multipart/form-data` body that declares no length.
 */
export function multipartEvent(parts: MultipartPart[]): H3Event {
  const boundary = 'piwitestboundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${filename}\r\n\r\n`));
    chunks.push(part.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return testEvent({
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' },
    body: Buffer.concat(chunks),
  });
}
