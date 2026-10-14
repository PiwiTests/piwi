/**
 * Reads the headers a backend's Piwi integration adds to its responses, so the specs can check what a backend sends.
 * The reporter reads the same headers on its own; a test never has to.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PROBE_SECRET } from '../backends';

/** One entry of `X-Piwi-Logs`. */
export interface BackendLogEntry {
  timestamp: number;
  level: 'Warning' | 'Error' | 'Critical';
  category: string;
  message: string;
  stack?: string;
}

/** One span of `X-Piwi-Trace`. */
export interface ServerSpan {
  name: string;
  status: 'ok' | 'error';
  attrs: Record<string, unknown>;
}

/** A gzip-compressed, Base64-encoded JSON header value, decoded. */
const decode = <T>(header: string | undefined): T | null =>
  header ? (JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf8')) as T) : null;

/** The entries of an `X-Piwi-Logs` header, or null when the response has none. */
export const backendLogs = (header: string | undefined) => decode<BackendLogEntry[]>(header);

/** The spans of an `X-Piwi-Trace` header, or null when the response has none. */
export const serverSpans = (header: string | undefined) => decode<ServerSpan[]>(header);

/**
 * An `X-Piwi-Probe` header asking the backend to apply `fault` to the request `route` names (`GET /api/items`),
 * signed with the sample's probe secret the way a probe run signs it.
 */
export function probeHeader(route: string, fault: string): string {
  const nonce = randomBytes(8).toString('hex');
  const ts = Date.now();
  const specJson = JSON.stringify({ route, fault });
  const sig = createHmac('sha256', PROBE_SECRET).update(`${nonce}.${ts}.${specJson}`).digest('hex');
  return Buffer.from(JSON.stringify({ nonce, ts, specJson, sig })).toString('base64');
}
