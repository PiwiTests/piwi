import { decompressEntrySync, parseZipDirectory, type ZipEntry } from '../../server/utils/trace-zip';

/** Every readable entry of a ZIP archive, inflated on the calling thread; a corrupt or unsupported entry is skipped. */
export function parseZipSync(data: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (const meta of parseZipDirectory(data)) {
    try {
      entries.push({ name: meta.name, data: decompressEntrySync(data, meta, Number.POSITIVE_INFINITY) });
    } catch {
      // Skip a corrupt or unsupported entry.
    }
  }
  return entries;
}
