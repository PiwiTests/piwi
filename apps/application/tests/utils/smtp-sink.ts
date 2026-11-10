/**
 * An SMTP server for the specs that read the email a Piwi server sends: it
 * accepts every message without authentication or TLS and keeps its raw text.
 * Enough of the protocol for nodemailer, nothing more.
 */
import { createServer, type AddressInfo, type Server } from 'node:net';

export interface SmtpSink {
  port: number;
  /** The raw text (headers and body) of each message received, in order. */
  messages: string[];
  /** The first message received that `match` accepts, waiting up to `timeoutMs` for it. */
  waitFor(match: (raw: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Forgets every message received so far. */
  clear(): void;
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: string[] = [];
  const server: Server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.setEncoding('utf8');
    socket.write('220 smtp-sink ready\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 OK\r\n');
          } else {
            data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 smtp-sink\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    messages,
    async waitFor(match, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(match);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`No matching email within ${timeoutMs / 1000} s (${messages.length} received)`);
    },
    clear: () => void messages.splice(0),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One leaf part of a message: its headers (names in lower case) and its decoded content. */
export interface MailPart {
  headers: Record<string, string>;
  /** The media type alone, in lower case: `text/html`, `image/png`. */
  contentType: string;
  /** The file name its `Content-Disposition` or `Content-Type` gives, null without one. */
  filename: string | null;
  /** Whether it is shown inline (`Content-Disposition: inline`) rather than attached. */
  inline: boolean;
  content: Buffer;
}

/** A message the sink received, read: its addresses, subject, text and HTML bodies, and every leaf part. */
export interface Mail {
  /** The addresses of its `To` header. */
  to: string[];
  from: string;
  subject: string;
  /** The first text/plain part, empty without one. */
  text: string;
  /** The first text/html part, empty without one. */
  html: string;
  parts: MailPart[];
}

/** The `To` header of a raw message names `address`. */
export function sentTo(address: string): (raw: string) => boolean {
  return (raw) => readMail(raw).to.includes(address.toLowerCase());
}

/** Reads a raw message: headers unfolded and their encoded words decoded, every multipart walked to its leaves. */
export function readMail(raw: string): Mail {
  const { headers, body } = splitHeaders(raw);
  const parts = leafParts(headers, body);
  const firstText = (type: string) => parts.find((p) => p.contentType === type)?.content.toString('utf8') ?? '';
  return {
    to: (headers.to ?? '').match(/[^\s<>,"]+@[^\s<>,"]+/g)?.map((a) => a.toLowerCase()) ?? [],
    from: headers.from ?? '',
    subject: headers.subject ?? '',
    text: firstText('text/plain'),
    html: firstText('text/html'),
    parts,
  };
}

/** The text/plain part of a raw message, decoded. */
export function plainTextPart(raw: string): string {
  const { parts } = readMail(raw);
  const part = parts.find((p) => p.contentType === 'text/plain');
  if (!part) throw new Error('The message has no text/plain part');
  return part.content.toString('utf8');
}

function splitHeaders(entity: string): { headers: Record<string, string>; body: string } {
  const end = entity.indexOf('\r\n\r\n');
  const head = end === -1 ? entity : entity.slice(0, end);
  const body = end === -1 ? '' : entity.slice(end + 4);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = decodeWords(line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/** RFC 2047 encoded words (`=?UTF-8?Q?…?=`, `=?UTF-8?B?…?=`), the space between two of them dropped. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, charset: string, encoding: string, text: string) => {
      const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qpBytes(text.replace(/_/g, ' '));
      return bytes.toString(/^utf-?8$/i.test(charset) ? 'utf8' : 'latin1');
    });
}

function qpBytes(text: string): Buffer {
  const bytes = text
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1');
}

function param(header: string | undefined, name: string): string | null {
  const match = new RegExp(`;\\s*${name}\\*?=("([^"]*)"|[^;\\s]+)`, 'i').exec(header ?? '');
  return match ? (match[2] ?? match[1]!) : null;
}

function leafParts(headers: Record<string, string>, body: string): MailPart[] {
  const type = (headers['content-type'] ?? 'text/plain').split(';')[0]!.trim().toLowerCase();
  const boundary = param(headers['content-type'], 'boundary');
  if (type.startsWith('multipart/') && boundary) {
    const segments = body.split(`--${boundary}`).slice(1);
    return segments
      .filter((segment) => !segment.startsWith('--'))
      .flatMap((segment) => {
        const part = splitHeaders(segment.replace(/^\r\n/, ''));
        return leafParts(part.headers, part.body.replace(/\r\n$/, ''));
      });
  }
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const content =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : encoding === 'quoted-printable'
        ? qpBytes(body)
        : Buffer.from(body, 'utf8');
  const disposition = headers['content-disposition'];
  return [
    {
      headers,
      contentType: type,
      filename: param(disposition, 'filename') ?? param(headers['content-type'], 'name'),
      inline: /^inline\b/i.test(disposition ?? ''),
      content,
    },
  ];
}
