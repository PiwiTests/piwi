/**
 * Node-side archive access for the import parsers.
 *
 * `blob-report.ts` and `trace-import.ts` are deliberately free of `node:`
 * imports so demo mode can run them in a service worker against
 * `DecompressionStream`. This module is the server's half: the central
 * directory is walked once, and entries are inflated one at a time only when
 * the parser asks for them, so a large archive never lands in memory whole a
 * second time.
 */

import { parseZipDirectory, decompressEntry, type ZipEntryMeta } from './trace-zip';

export interface OpenedArchive {
  /** Every file entry in the archive, in central-directory order. */
  entryNames: string[];
  /**
   * Node inflation yields a `Buffer`, so the type is kept narrow here — server
   * callers hand entries straight to `Buffer`-taking helpers, and a `Buffer` is
   * still a `Uint8Array` where the parsers expect one.
   */
  readEntry: (name: string) => Promise<Buffer | null>;
}

/** Raised when the bytes are not a ZIP at all. */
export class ArchiveError extends Error {}

/**
 * What the entries of an imported archive may declare together. A blob report
 * holds a whole run's traces and attachments, read one entry at a time, each
 * within its declared size; every trace in it is checked again when stored.
 */
const MAX_IMPORT_INFLATED_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

export function openArchive(data: Buffer): OpenedArchive {
  let directory: ZipEntryMeta[];
  try {
    directory = parseZipDirectory(data, { maxInflatedBytes: MAX_IMPORT_INFLATED_BYTES });
  } catch (error) {
    throw new ArchiveError(`Not a readable ZIP archive: ${(error as Error).message}`);
  }

  const entries = new Map(directory.map((meta) => [meta.name, meta]));

  return {
    entryNames: directory.map((meta) => meta.name),
    async readEntry(name) {
      const meta = entries.get(name);
      if (!meta) return null;
      try {
        return await decompressEntry(data, meta);
      } catch {
        // Unsupported compression or a corrupt entry — the caller decides
        // whether that entry mattered.
        return null;
      }
    },
  };
}
