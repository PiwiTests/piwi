import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import FormData from 'form-data';
import { RUN_TOKEN_HEADER } from '@piwitests/core/wire';
import { Logger } from '../support/logger.js';

export { FormData };

/**
 * An HTTP response with a non-2xx status. Carries the numeric `status` so
 * callers can branch on a specific code (401, 404, 409, 422, …) via
 * `error instanceof HttpError && error.status === …` instead of sniffing the
 * message string.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string = `Request failed with status ${status}`,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Response from the unified `request()` core. */
interface HttpResponse {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/** The most characters of the server's word on a failed request that its `HttpError` carries. */
const FAILURE_DETAIL_MAX = 500;

/**
 * The server's own word on a failed request, on one line of at most `FAILURE_DETAIL_MAX` characters: the `message`, or
 * else the `statusMessage`, of a JSON body, or a plain-text body. Null for any other body, such as a proxy's HTML page.
 */
export function failureDetail(res: Pick<HttpResponse, 'text' | 'headers'>): string | null {
  let text: unknown = null;
  try {
    const body = JSON.parse(res.text) as { message?: unknown; statusMessage?: unknown } | null;
    text = typeof body?.message === 'string' ? body.message : body?.statusMessage;
  } catch {
    if (/^text\/plain\b/i.test(res.headers['content-type'] ?? '')) text = res.text;
  }
  if (typeof text !== 'string') return null;
  const line = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (!line) return null;
  return line.length > FAILURE_DETAIL_MAX ? `${line.slice(0, FAILURE_DETAIL_MAX - 1)}…` : line;
}

/** The error of an answer with a non-2xx status: it names the status, and the server's word on it when there is one. */
function failedRequest(res: HttpResponse): HttpError {
  const detail = failureDetail(res);
  return new HttpError(res.status, `Request failed with status ${res.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * The JSON body of a successful answer. A body that is not JSON (a sign-in page, a proxy's or a captive portal's
 * page) is not the dashboard's answer, so the request fails, naming the content type that came back.
 */
function parseAnswer(pathname: string, res: HttpResponse): any {
  try {
    return JSON.parse(res.text);
  } catch {
    const contentType = res.headers['content-type'] || 'no content type';
    throw new Error(
      `The answer to ${pathname} is not JSON (${contentType}): check that serverUrl is the dashboard's address and that no sign-in page or proxy answers in its place.`,
    );
  }
}

/**
 * The run a delivery's answer names. An answer that names none did not come from the dashboard, so the run was not
 * delivered.
 */
export function deliveredRunId(answer: unknown, pathname: string): number | string {
  const runId = (answer as { runId?: unknown } | null)?.runId;
  if (typeof runId === 'number' || (typeof runId === 'string' && runId !== '')) return runId;
  throw new Error(
    `The answer to ${pathname} names no run: check that serverUrl is the dashboard's address and that no proxy answers in its place.`,
  );
}

/**
 * Why `serverUrl` cannot be the dashboard's address: it must be a whole `http://` or `https://` URL. Null when it
 * can.
 */
export function serverUrlProblem(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return `serverUrl "${serverUrl}" is not a URL: give the dashboard's whole address, such as https://piwi.example.com.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `serverUrl "${serverUrl}" is not an http:// or https:// URL: give the dashboard's whole address, such as https://piwi.example.com.`;
  }
  return null;
}

/**
 * The header that carries a streaming run's token (`RUN_TOKEN_HEADER`), for a request that also carries it in its
 * body; none without a token.
 */
export function runTokenHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { [RUN_TOKEN_HEADER]: token } : {};
}

/** Options for the unified `request()` core. */
interface HttpRequestOptions {
  headers?: Record<string, string | number>;
  /** JSON body (written then the request is ended). Mutually exclusive with `form`. */
  body?: string;
  /** Multipart form (piped into the request). Mutually exclusive with `body`. */
  form?: FormData;
  auth?: string | null;
  /** Socket inactivity timeout for this request, in ms; the client's own by default. */
  timeout?: number;
  /** Ends the request, in flight or not sent yet, with the signal's reason. */
  signal?: AbortSignal;
}

/** The error a request ended by `signal` fails with. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The request was cancelled');
}

/**
 * Low-level HTTP client for communicating with the Piwi Dashboard server.
 * Supports JSON requests, multipart form-data uploads, and session-based login.
 *
 * All three public methods (`login`, `postJSON`, `postFormData`) delegate to a
 * single `request()` core that owns the transport selection, header/auth
 * application, response accumulation, and socket timeout. The package stays on
 * the single `form-data` runtime dependency — no HTTP client library.
 */
export class HttpClient {
  /** Requests in flight, so `close` can abort them. */
  private readonly inFlight = new Set<http.ClientRequest>();
  /** Set by `close`: every later request fails with this reason. */
  private closedReason: string | null = null;

  /**
   * @param serverUrl Base URL of the Piwi Dashboard server (e.g. `http://localhost:3000`).
   * @param logger    Prefixed logger for verbose diagnostics.
   * @param timeout   Socket inactivity timeout in ms (default 30s), so a hung
   *                  server fails fast rather than stalling the reporter.
   * @param uploadTimeout Socket inactivity timeout of a multipart upload, or of
   *                  a run's results sent as JSON, in ms (default 10 min): the
   *                  dashboard answers one only once it has stored all of it.
   */
  constructor(
    private readonly serverUrl: string,
    private readonly logger: Logger = new Logger(),
    private readonly timeout = 30000,
    private readonly uploadTimeout = 10 * 60 * 1000,
  ) {
    this.warnIfInsecureTransport();
  }

  /**
   * Warn once when the dashboard URL is plaintext `http://` to a non-loopback
   * host. The reporter sends the API key as a Bearer token — and uploads
   * captured test data, including request URLs whose query strings the server
   * only strips after receipt — over this connection, so a non-TLS remote
   * endpoint exposes the key and payloads on the wire. Loopback (localhost /
   * 127.0.0.1 / ::1) is exempt: that traffic never leaves the machine. This
   * warns rather than refuses so internal HTTP deployments (e.g. behind a VPN)
   * work, while the exposure is still reported.
   */
  private warnIfInsecureTransport(): void {
    let url: URL;
    try {
      url = new URL(this.serverUrl);
    } catch {
      return; // a malformed URL surfaces on the first request instead
    }
    if (url.protocol !== 'http:') return;
    const host = url.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (isLoopback) return;
    this.logger.warn(
      `Dashboard URL ${this.serverUrl} uses plaintext http:// — the API key and captured test data are transmitted unencrypted. Use https:// for any non-local server.`,
    );
  }

  /** Base URL of the Piwi Dashboard server this client talks to (used to print run links). */
  get baseUrl(): string {
    return this.serverUrl;
  }

  /** Whether `close` was called. */
  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Abort every request in flight and fail every later one with `reason`. */
  close(reason: string): void {
    this.closedReason = reason;
    for (const req of this.inFlight) req.destroy(new Error(reason));
    this.inFlight.clear();
  }

  /**
   * Resolve an auth credential: prefer `apiKey`, fall back to `username`/`password` login,
   * or return `null` when neither is configured.
   */
  async resolveAuth(options: {
    apiKey?: string | null;
    username?: string | null;
    password?: string | null;
  }): Promise<string | null> {
    if (options.apiKey) return options.apiKey;
    if (options.username && options.password) {
      this.logger.info(`Authenticating as ${options.username}...`);
      return this.login(options.username, options.password);
    }
    return null;
  }

  /** Authenticate with username/password and return the session cookie string */
  async login(username: string, password: string): Promise<string> {
    const body = JSON.stringify({ username, password });
    const res = await this.request('POST', '/api/auth/login', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      this.logger.debugError(`Login response: ${res.text}`);
      throw new HttpError(res.status, `Login failed with status ${res.status}`);
    }
    const setCookie = res.headers['set-cookie'];
    if (!setCookie || setCookie.length === 0) {
      throw new Error('Login succeeded but no session cookie was returned');
    }
    const cookie = setCookie.map((c: string) => c.split(';')[0]).join('; ');
    this.logger.debug('Logged in successfully');
    return cookie;
  }

  /**
   * Send a JSON GET request, returning the parsed body, or `null` on any non-2xx
   * status or parse failure. Unlike `postJSON` this never throws — its callers
   * treat a missing or unreachable endpoint as "feature unavailable".
   */
  async getJSON(pathname: string, auth?: string | null): Promise<any> {
    let res: HttpResponse;
    try {
      res = await this.request('GET', pathname, { auth });
    } catch (error) {
      this.logger.debug(`GET ${pathname} failed: ${(error as Error).message}`);
      return null;
    }
    if (res.status < 200 || res.status >= 300) {
      this.logger.debug(`GET ${pathname} returned ${res.status}`);
      return null;
    }
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }

  /**
   * Send a JSON POST request. `auth` can be an API key (prefix `pd_`) or a session cookie string. Resolves to the
   * answer's JSON; an answer that is not JSON fails, and `signal` ends the request. With `upload`, the answer may come
   * as late as a multipart upload's: the body is a run's results, which the dashboard stores before it answers.
   * `headers` go with the request beside its own.
   */
  async postJSON(
    pathname: string,
    payload: unknown,
    auth?: string | null,
    signal?: AbortSignal,
    { upload = false, headers = {} }: { upload?: boolean; headers?: Record<string, string> } = {},
  ): Promise<any> {
    const body = JSON.stringify(payload);
    const res = await this.request('POST', pathname, {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      auth,
      signal,
      ...(upload && { timeout: this.uploadTimeout }),
    });
    if (res.status < 200 || res.status >= 300) {
      this.logger.debugError(`Response: ${res.text}`);
      throw failedRequest(res);
    }
    return parseAnswer(pathname, res);
  }

  /** Send a JSON PUT request. Used for the declared-surface manifest upload. An answer that is not JSON fails. */
  async putJSON(pathname: string, payload: unknown, auth?: string | null): Promise<any> {
    const body = JSON.stringify(payload);
    const res = await this.request('PUT', pathname, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      auth,
    });
    if (res.status < 200 || res.status >= 300) {
      this.logger.debugError(`Response: ${res.text}`);
      throw failedRequest(res);
    }
    return parseAnswer(pathname, res);
  }

  /**
   * Send a multipart form-data POST request. Used for report and trace uploads. An answer that is not JSON fails, and
   * `signal` ends the upload.
   */
  async postFormData(pathname: string, form: FormData, auth?: string | null, signal?: AbortSignal): Promise<any> {
    const headers = form.getHeaders() as Record<string, string>;
    const res = await this.request('POST', pathname, { headers, form, auth, timeout: this.uploadTimeout, signal });
    if (res.status < 200 || res.status >= 300) {
      this.logger.debugError(`Response: ${res.text}`);
      throw failedRequest(res);
    }
    return parseAnswer(pathname, res);
  }

  /**
   * Unified request core: transport, headers, auth, response accumulation, timeout. Nothing is sent to a `serverUrl`
   * that is not an `http://` or `https://` URL.
   */
  private request(method: string, pathname: string, opts: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      if (this.closedReason !== null) {
        reject(new Error(this.closedReason));
        return;
      }
      const problem = serverUrlProblem(this.serverUrl);
      if (problem) {
        reject(new Error(problem));
        return;
      }
      const signal = opts.signal;
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const url = new URL(pathname, this.serverUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string | number> = { ...opts.headers };
      this.applyAuth(headers, opts.auth);

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          // Decoded once whole: a character can span two chunks.
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
          // A connection dropped after the headers closes the response without
          // `end`; an incomplete body is a failed request, not a pending one.
          res.on('error', reject);
          res.on('close', () => {
            if (!res.complete) {
              reject(new Error(`Connection to ${pathname} closed before the response completed`));
            }
          });
        },
      );

      this.inFlight.add(req);
      const onAbort = () => req.destroy(abortError(signal!));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        this.inFlight.delete(req);
        signal?.removeEventListener('abort', onAbort);
      });
      req.on('error', reject);
      const timeout = opts.timeout ?? this.timeout;
      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Request to ${pathname} timed out after ${timeout}ms`));
      });

      if (opts.form) {
        // A file in the form that cannot be read fails the request.
        opts.form.on('error', (error) => req.destroy(error));
        opts.form.pipe(req);
      } else if (opts.body !== undefined) {
        req.write(opts.body);
        req.end();
      } else {
        req.end();
      }
    });
  }

  private applyAuth(headers: Record<string, string | number>, auth?: string | null): void {
    if (!auth) return;
    if (auth.startsWith('pd_')) {
      headers['Authorization'] = `Bearer ${auth}`;
    } else {
      headers['Cookie'] = auth;
    }
  }
}
