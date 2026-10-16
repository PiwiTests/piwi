import * as http from 'node:http';
import * as https from 'node:https';

/** A backend's answer: its status, headers and body. */
export interface BackendAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/**
 * One HTTP request to a backend under test, on a connection of its own, so a
 * connection the backend closed is never reused, ended by `signal`. It follows
 * no redirect: a redirect is answered as is. `insecure` accepts any certificate,
 * as the run's browsers do with `ignoreHTTPSErrors`. Rejects on a network error,
 * an abort, or an answer over `maxBytes`.
 */
export function backendRequest(
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    insecure: boolean;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<BackendAnswer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers: Record<string, string | number> = { ...init.headers };
    if (init.body !== undefined) headers['Content-Length'] = Buffer.byteLength(init.body);
    const options = { method: init.method, headers, agent: false as const };
    const onAnswer = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > init.maxBytes) req.destroy(new Error(`the answer exceeds ${init.maxBytes} bytes`));
        else chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('the connection closed before the answer completed'));
      });
    };
    const req =
      target.protocol === 'https:'
        ? https.request(target, { ...options, rejectUnauthorized: !init.insecure }, onAnswer)
        : http.request(target, options, onAnswer);
    const onAbort = () => req.destroy(init.signal.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => init.signal.removeEventListener('abort', onAbort));
    req.on('error', reject);
    req.end(init.body);
  });
}
