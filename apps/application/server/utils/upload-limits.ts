import {
  heldOperatorLimits,
  importMaxBytesSetting,
  submitMaxBytesSetting,
  type LimitSetting,
} from '#shared/operator-limits';

/**
 * Resolve the effective multipart size ceiling: the operator's (`/api/operator/limits`), else
 * `PIWI_IMPORT_MAX_BYTES` (clamped to the allowed range), else the default.
 *
 * A self-hoster sets it to match whatever their reverse proxy allows, so the
 * import page's pre-flight rejects the same archives the proxy would.
 */
export function resolveMaxUploadBytes(): number {
  return importMaxBytesSetting(heldOperatorLimits(), process.env).value;
}

/**
 * The size ceiling of a run's results sent as one JSON document, and where it comes from: the operator's, else
 * `PIWI_SUBMIT_MAX_BYTES` (clamped to the allowed range), else the default.
 */
export function maxSubmitBytesSetting(): LimitSetting<number> {
  return submitMaxBytesSetting(heldOperatorLimits(), process.env);
}

/** The size ceiling of a run's results sent as one JSON document ({@link maxSubmitBytesSetting}). */
export function resolveMaxSubmitBytes(): number {
  return maxSubmitBytesSetting().value;
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
