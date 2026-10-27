import { inflateRaw, inflateRawSync, deflateRawSync } from 'zlib';
import { promisify } from 'util';

const inflateRawAsync = promisify(inflateRaw);

/**
 * Deflate level for {@link buildZip}'s optional per-entry compression. Level 6
 * is zlib's default — most of the ratio for a fraction of level 9's CPU, which
 * matters because the slim blob is built on the ingest hot path.
 */
const DEFLATE_LEVEL = 6;

/**
 * Entries below this many bytes are stored, never deflated: deflate's own
 * overhead (a few bytes of block framing) can make a tiny payload grow, and the
 * saving on it would be noise.
 */
const MIN_DEFLATE_BYTES = 64;

/**
 * Upper bound on the decompressed size of a single ZIP entry. Deflate can
 * expand its input by up to ~1000×, so an attacker-supplied trace archive
 * (uploads are open when auth is disabled) could pair a few kilobytes of
 * compressed data with gigabytes of output and exhaust server memory. Real
 * trace files — events, network log, screenshots — never approach this ceiling.
 * zlib throws ERR_BUFFER_TOO_LARGE once one entry's output would exceed the
 * cap, or the size the entry declares.
 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MiB

/**
 * Default upper bound on what all the entries of one archive declare they
 * inflate to (see {@link parseZipDirectory}). Every entry inflates to at most
 * its declared size, so this bounds what any number of reads of one archive
 * hold at once. It comfortably exceeds any real trace.
 */
const MAX_ARCHIVE_INFLATED_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Upper bound on the total size of a ZIP produced by {@link buildZip}. The
 * output length is the sum of every entry's decompressed data, so a corrupt or
 * hostile archive whose entries expand to gigabytes would drive a single
 * unbounded allocation and OOM-kill the process. 1 GiB comfortably exceeds any
 * real trace (event streams plus a fully reconstructed resource pool) while
 * turning a bogus total into a thrown error the caller can recover from.
 */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Metadata from the ZIP central directory — no decompression performed. */
export interface ZipEntryMeta {
  name: string;
  /** Compression method: 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  /** The size the central directory declares; the entry never inflates past it. */
  uncompressedSize: number;
  /** Byte offset in the source buffer where compressed data begins. */
  dataStart: number;
}

/**
 * An archive refused before anything is inflated: its entries share or overlap
 * bytes, or together declare more than the archive's budget. Unlike a merely
 * malformed archive, it is never stored.
 */
export class ZipLimitError extends Error {}

// CRC-32 lookup table (standard polynomial 0xEDB88320)
function crc32(buf: Buffer): number {
  // prettier-ignore
  const CRC32_TABLE = [
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
    0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
    0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
    0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
    0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
    0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
    0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
    0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
    0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
    0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
    0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
    0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
    0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
    0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
    0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
    0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
    0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
    0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
    0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
    0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
    0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
    0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
  ] as const;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE.at((c ^ buf.readUInt8(i)) & 0xff)! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Read the ZIP central directory and return entry metadata without decompressing
 * any data.  Use this when you only need file names and byte offsets, e.g. to
 * decide which resources are new before committing to decompression.
 *
 * Throws {@link ZipLimitError} when two entries share or overlap their bytes (a
 * few compressed bytes then stand for any number of entries), or when the
 * entries together declare more than `maxInflatedBytes`.
 */
export function parseZipDirectory(
  data: Buffer,
  { maxInflatedBytes = MAX_ARCHIVE_INFLATED_BYTES }: { maxInflatedBytes?: number } = {},
): ZipEntryMeta[] {
  const scanFrom = Math.max(0, data.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= scanFrom; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a valid ZIP (EOCD not found)');

  const entryCount = data.readUInt16LE(eocdOffset + 10);
  const cdOffset = data.readUInt32LE(eocdOffset + 16);
  if (cdOffset > data.length) throw new Error('Invalid central directory offset');

  const metas: ZipEntryMeta[] = [];
  // Where each entry's local header starts and its data ends.
  const spans: Array<{ start: number; end: number }> = [];
  let declaredBytes = 0;
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > data.length) throw new Error('Truncated central directory');
    if (data.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid CD entry signature');

    const method = data.readUInt16LE(pos + 10);
    const compressedSize = data.readUInt32LE(pos + 20);
    const uncompressedSize = data.readUInt32LE(pos + 24);
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const localOffset = data.readUInt32LE(pos + 42);
    const name = data.toString('utf8', pos + 46, pos + 46 + nameLen);

    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || compressedSize === 0xffffffff) continue;

    if (localOffset + 30 > data.length) throw new Error(`Bad local offset for "${name}"`);
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Bad local header for "${name}"`);

    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    // An entry whose data runs past the archive is never read (see compressedBytes).
    if (dataStart + compressedSize <= data.length) {
      declaredBytes += method === 0 ? compressedSize : uncompressedSize;
      if (declaredBytes > maxInflatedBytes) {
        throw new ZipLimitError(`ZIP entries inflate past ${maxInflatedBytes} bytes`);
      }
      spans.push({ start: localOffset, end: dataStart + compressedSize });
    }
    metas.push({ name, method, compressedSize, uncompressedSize, dataStart });
  }

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) throw new ZipLimitError('ZIP entries share or overlap their bytes');
  }

  return metas;
}

/** The output cap for inflating one entry: its declared size, within the per-entry ceiling. */
function inflateCap(meta: ZipEntryMeta, maxBytes = MAX_ENTRY_BYTES): number {
  return Math.min(meta.uncompressedSize, maxBytes, MAX_ENTRY_BYTES);
}

/** The compressed bytes of one entry, checked against the archive's length. */
function compressedBytes(data: Buffer, meta: ZipEntryMeta): Buffer {
  if (meta.dataStart + meta.compressedSize > data.length) {
    throw new Error(`Truncated data for "${meta.name}"`);
  }
  if (meta.method !== 0 && meta.method !== 8) {
    throw new Error(`Unsupported ZIP compression method ${meta.method} for "${meta.name}"`);
  }
  return data.subarray(meta.dataStart, meta.dataStart + meta.compressedSize);
}

/**
 * Decompress a single ZIP entry identified by its central-directory metadata.
 * Uses async decompression so it does not block the event loop.
 */
export async function decompressEntry(data: Buffer, meta: ZipEntryMeta): Promise<Buffer> {
  const compressed = compressedBytes(data, meta);
  if (meta.method === 0) return Buffer.from(compressed);
  if (meta.uncompressedSize === 0) return Buffer.alloc(0);
  return inflateRawAsync(compressed, { maxOutputLength: inflateCap(meta) });
}

/**
 * Decompress a single ZIP entry on the calling thread, for a reader that must
 * answer synchronously (the aria reader the snapshot view builds from), with
 * its own cap on the output. {@link decompressEntry} is the default.
 */
export function decompressEntrySync(data: Buffer, meta: ZipEntryMeta, maxBytes: number): Buffer {
  const compressed = compressedBytes(data, meta);
  if (meta.method === 0) return Buffer.from(compressed);
  if (meta.uncompressedSize === 0) return Buffer.alloc(0);
  return inflateRawSync(compressed, { maxOutputLength: inflateCap(meta, maxBytes) });
}

/** Decompress text entries, in the order given, skipping one that is corrupt or uses an unknown method. */
export async function decompressTextEntries(data: Buffer, metas: ZipEntryMeta[]): Promise<string[]> {
  const texts: string[] = [];
  for (const meta of metas) {
    try {
      texts.push((await decompressEntry(data, meta)).toString('utf8'));
    } catch {
      // Skip a corrupt entry rather than fail the whole archive.
    }
  }
  return texts;
}

/**
 * Parse a ZIP archive and return all file entries with their decompressed data.
 * Reads via the central directory so data descriptors and flag variations don't
 * affect correctness.
 *
 * Prefer `parseZipDirectory` + `decompressEntry` when you only need a subset of
 * entries, to avoid decompressing data you'll discard.
 */
export async function parseZip(data: Buffer): Promise<ZipEntry[]> {
  const metas = parseZipDirectory(data);
  const entries: ZipEntry[] = [];
  for (const meta of metas) {
    try {
      entries.push({ name: meta.name, data: await decompressEntry(data, meta) });
    } catch {
      // Unknown compression or corrupt entry — skip rather than crash
    }
  }
  return entries;
}

/**
 * Build a ZIP archive from a list of entries.
 *
 * Entries are stored uncompressed (method 0) by default — the right choice when
 * the archive is reconstructed and served on demand and speed beats size. Pass
 * `{ compress: true }` to deflate each entry that actually shrinks (method 8),
 * leaving already-compressed payloads (PNG screen snapshots, fonts) stored so no
 * CPU is spent growing them. A ZIP freely mixes the two methods per entry —
 * exactly what Playwright's own traces do — so the trace viewer and
 * {@link parseZip} read the result unchanged. Use it when the archive is written
 * once and kept, such as the persisted slim trace blob.
 */
export function buildZip(entries: ZipEntry[], options: { compress?: boolean } = {}): Buffer {
  const nameBuffers = entries.map((entry) => Buffer.from(entry.name, 'utf8'));

  // Resolve each entry's on-disk payload and method up front: the CRC is always
  // over the uncompressed data, so validate the raw size first (a negative,
  // non-integer or absurd length must fail here, not drive an allocation), then
  // deflate only when it wins. Sizing the output from the resolved payloads
  // keeps the single allocation exact and bounded whether or not we compressed.
  const payloads: Buffer[] = [];
  const methods: number[] = [];
  const crcs: number[] = [];

  let total = 22; // EOCD
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i]!.data;
    if (!Number.isSafeInteger(raw.length) || raw.length < 0) {
      throw new Error(`Invalid entry size for "${entries[i]!.name}"`);
    }
    // Reject against the cap using the raw length — the compressed payload can
    // only be smaller — so a hostile or corrupt entry is refused before any CRC
    // or deflate work touches its bytes.
    if (total + 30 + nameBuffers[i]!.length + raw.length + 46 + nameBuffers[i]!.length > MAX_ZIP_BYTES) {
      throw new Error(`ZIP exceeds ${MAX_ZIP_BYTES} bytes`);
    }

    crcs.push(crc32(raw));

    let payload = raw;
    let method = 0;
    if (options.compress && raw.length >= MIN_DEFLATE_BYTES) {
      const deflated = deflateRawSync(raw, { level: DEFLATE_LEVEL });
      if (deflated.length < raw.length) {
        payload = deflated;
        method = 8;
      }
    }
    payloads.push(payload);
    methods.push(method);

    total += 30 + nameBuffers[i]!.length + payload.length + 46 + nameBuffers[i]!.length;
  }

  const out = Buffer.allocUnsafe(total);
  const localOffsets: number[] = [];
  let pos = 0;

  // Local file headers (30 bytes + filename) followed by the entry payload.
  for (let i = 0; i < entries.length; i++) {
    const nameBytes = nameBuffers[i]!;
    const payload = payloads[i]!;
    const rawSize = entries[i]!.data.length;
    localOffsets.push(pos);

    out.writeUInt32LE(0x04034b50, pos); // signature
    out.writeUInt16LE(20, pos + 4); // version needed (2.0)
    out.writeUInt16LE(0, pos + 6); // flags
    out.writeUInt16LE(methods[i]!, pos + 8); // method: stored (0) or deflated (8)
    out.writeUInt16LE(0, pos + 10); // mod time
    out.writeUInt16LE(0, pos + 12); // mod date
    out.writeUInt32LE(crcs[i]!, pos + 14); // crc-32 (over uncompressed data)
    out.writeUInt32LE(payload.length, pos + 18); // compressed size
    out.writeUInt32LE(rawSize, pos + 22); // uncompressed size
    out.writeUInt16LE(nameBytes.length, pos + 26); // filename length
    out.writeUInt16LE(0, pos + 28); // extra field length
    nameBytes.copy(out, pos + 30);
    pos += 30 + nameBytes.length;
    payload.copy(out, pos);
    pos += payload.length;
  }

  // Central directory file headers (46 bytes + filename).
  const cdStart = pos;
  for (let i = 0; i < entries.length; i++) {
    const nameBytes = nameBuffers[i]!;
    const payload = payloads[i]!;
    const rawSize = entries[i]!.data.length;

    out.writeUInt32LE(0x02014b50, pos); // signature
    out.writeUInt16LE(20, pos + 4); // version made by
    out.writeUInt16LE(20, pos + 6); // version needed
    out.writeUInt16LE(0, pos + 8); // flags
    out.writeUInt16LE(methods[i]!, pos + 10); // method: stored (0) or deflated (8)
    out.writeUInt16LE(0, pos + 12); // mod time
    out.writeUInt16LE(0, pos + 14); // mod date
    out.writeUInt32LE(crcs[i]!, pos + 16); // crc-32
    out.writeUInt32LE(payload.length, pos + 20); // compressed size
    out.writeUInt32LE(rawSize, pos + 24); // uncompressed size
    out.writeUInt16LE(nameBytes.length, pos + 28); // filename length
    out.writeUInt16LE(0, pos + 30); // extra field length
    out.writeUInt16LE(0, pos + 32); // file comment length
    out.writeUInt16LE(0, pos + 34); // disk number start
    out.writeUInt16LE(0, pos + 36); // internal file attributes
    out.writeUInt32LE(0, pos + 38); // external file attributes
    out.writeUInt32LE(localOffsets[i]!, pos + 42); // relative offset of local header
    nameBytes.copy(out, pos + 46);
    pos += 46 + nameBytes.length;
  }
  const cdSize = pos - cdStart;

  // End of central directory record (22 bytes).
  const entryCount16 = Math.min(entries.length, 0xffff);
  out.writeUInt32LE(0x06054b50, pos); // signature
  out.writeUInt16LE(0, pos + 4); // disk number
  out.writeUInt16LE(0, pos + 6); // disk with central directory
  out.writeUInt16LE(entryCount16, pos + 8); // entries on this disk
  out.writeUInt16LE(entryCount16, pos + 10); // total entries
  out.writeUInt32LE(cdSize, pos + 12); // central directory size
  out.writeUInt32LE(cdStart, pos + 16); // central directory offset
  out.writeUInt16LE(0, pos + 20); // comment length

  return out;
}
