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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The text/plain part of a raw message, quoted-printable decoded. */
export function plainTextPart(raw: string): string {
  const part = /Content-Type: text\/plain[^\r\n]*\r\n((?:[^\r\n]+\r\n)*)\r\n([\s\S]*?)\r\n--/i.exec(raw);
  if (!part) throw new Error('The message has no text/plain part');
  const [, headers, body] = part;
  if (!/quoted-printable/i.test(headers!)) return body!;
  const bytes = body!
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}
