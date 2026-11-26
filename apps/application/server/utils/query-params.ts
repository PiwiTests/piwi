import { getQuery, type H3Event } from 'nitro/h3';
import { apiError } from './api-error';

/**
 * Query-parameter parsing helpers. Every route that uses them gets the same
 * **clamp-and-400** semantics:
 *
 * - a value that is present but not the expected type is a 400 (never a silent
 *   default, never a dropped filter);
 * - an absent value falls back to the declared default (or `undefined`);
 * - integers are clamped into `[min, max]` when bounds are given.
 */

function firstValue(raw: unknown): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function toInt(s: string, name: string): number {
  const n = Number(s);
  if (!Number.isInteger(n)) {
    throw apiError({ statusCode: 400, message: `Invalid query parameter "${name}": expected an integer` });
  }
  return n;
}

function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Required integer query param. 400 when absent or non-integer; clamped to `[min, max]`. */
export function requireIntQuery(event: H3Event, name: string, opts: { min?: number; max?: number } = {}): number {
  const s = firstValue(getQuery(event)[name]);
  if (s === undefined) {
    throw apiError({ statusCode: 400, message: `Missing required query parameter "${name}"` });
  }
  return clamp(toInt(s, name), opts.min, opts.max);
}

/**
 * Optional integer query param. Absent → the declared default (or `undefined`);
 * present-but-non-integer → 400; clamped to `[min, max]`.
 */
export function optionalIntQuery(
  event: H3Event,
  name: string,
  opts: { default: number; min?: number; max?: number },
): number;
export function optionalIntQuery(
  event: H3Event,
  name: string,
  opts?: { min?: number; max?: number },
): number | undefined;
export function optionalIntQuery(
  event: H3Event,
  name: string,
  opts: { default?: number; min?: number; max?: number } = {},
): number | undefined {
  const s = firstValue(getQuery(event)[name]);
  if (s === undefined) return opts.default;
  return clamp(toInt(s, name), opts.min, opts.max);
}

/**
 * Boolean query flag. Absent → the declared default (or `false`); `true`/`1` →
 * true, `false`/`0` → false; any other value → 400.
 */
export function queryFlag(event: H3Event, name: string, opts: { default?: boolean } = {}): boolean {
  const s = firstValue(getQuery(event)[name]);
  if (s === undefined) return opts.default ?? false;
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw apiError({ statusCode: 400, message: `Invalid query parameter "${name}": expected a boolean` });
}
