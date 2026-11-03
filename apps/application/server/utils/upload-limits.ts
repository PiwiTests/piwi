import {
  DEFAULT_MAX_SUBMIT_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_IMPORT_MAX_BYTES,
  MAX_SUBMIT_MAX_BYTES,
  MIN_IMPORT_MAX_BYTES,
  MIN_SUBMIT_MAX_BYTES,
} from '#shared/upload-limits';

/** A byte count read from an environment variable, clamped to `[min, max]`; `fallback` when unset, blank or not a number. */
function bytesFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/**
 * Resolve the effective multipart size ceiling: the default, overridable with
 * `PIWI_IMPORT_MAX_BYTES` (clamped to the allowed range).
 *
 * Env-only by design, like the ingest caps: a self-hoster sets it to match
 * whatever their reverse proxy allows, so the import page's pre-flight rejects
 * the same archives the proxy would.
 */
export function resolveMaxUploadBytes(): number {
  return bytesFromEnv(
    process.env.PIWI_IMPORT_MAX_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
    MIN_IMPORT_MAX_BYTES,
    MAX_IMPORT_MAX_BYTES,
  );
}

/**
 * The size ceiling of a run's results sent as one JSON document: the default,
 * overridable with `PIWI_SUBMIT_MAX_BYTES` (clamped to the allowed range).
 */
export function resolveMaxSubmitBytes(): number {
  return bytesFromEnv(
    process.env.PIWI_SUBMIT_MAX_BYTES,
    DEFAULT_MAX_SUBMIT_BYTES,
    MIN_SUBMIT_MAX_BYTES,
    MAX_SUBMIT_MAX_BYTES,
  );
}

/** The largest file Node reads whole: an imported archive is read into memory at once. */
const MAX_READABLE_BYTES = 2 ** 31 - 1;

/**
 * The size ceiling of one imported archive: {@link resolveMaxUploadBytes}, held
 * under 2 GiB since an import reads its archive whole, so a larger one is
 * refused before it is uploaded rather than after.
 */
export function resolveMaxImportBytes(): number {
  return Math.min(resolveMaxUploadBytes(), MAX_READABLE_BYTES);
}
