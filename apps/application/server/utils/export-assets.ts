import {
  clampNumber,
  DEFAULT_EXPORT_MAX_BYTES,
  DEFAULT_EXPORT_MAX_CASES,
  DEFAULT_EXPORT_MAX_INLINE_BYTES,
  MAX_EXPORT_MAX_BYTES,
  MAX_EXPORT_MAX_CASES,
  MAX_EXPORT_MAX_INLINE_BYTES,
  MIN_EXPORT_MAX_BYTES,
  MIN_EXPORT_MAX_CASES,
  MIN_EXPORT_MAX_INLINE_BYTES,
} from '#shared/export/limits';
import type { ExportAsset, ExportAssetReader, ExportBudget } from '#shared/export/types';
import { readFileResolvingTrace } from './trace-reconstruct';
import { escapesStorageRoot } from './sanitize-filename';

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clampNumber(parsed, min, max);
}

export function resolveExportBudget(): ExportBudget {
  return {
    maxInlineBytes: envNumber(
      'PIWI_EXPORT_MAX_INLINE_BYTES',
      DEFAULT_EXPORT_MAX_INLINE_BYTES,
      MIN_EXPORT_MAX_INLINE_BYTES,
      MAX_EXPORT_MAX_INLINE_BYTES,
    ),
    maxTotalBytes: envNumber(
      'PIWI_EXPORT_MAX_BYTES',
      DEFAULT_EXPORT_MAX_BYTES,
      MIN_EXPORT_MAX_BYTES,
      MAX_EXPORT_MAX_BYTES,
    ),
  };
}

export function resolveExportMaxCases(): number {
  return envNumber('PIWI_EXPORT_MAX_CASES', DEFAULT_EXPORT_MAX_CASES, MIN_EXPORT_MAX_CASES, MAX_EXPORT_MAX_CASES);
}

/**
 * Reads evidence out of the configured storage backend. Trace blobs are
 * rebuilt into complete archives on the way out, so an exported trace opens in
 * a trace viewer instead of failing on missing resources.
 */
export const serverAssetReader: ExportAssetReader = {
  async read(asset: ExportAsset): Promise<Uint8Array | null> {
    // The paths come from `files` rows, but an export is a bulk read of many of
    // them — keep the same traversal guard the file endpoint applies.
    if (escapesStorageRoot(asset.storagePath)) return null;

    const buffer = await readFileResolvingTrace(asset.storagePath);
    if (!buffer) return null;
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  },
};
