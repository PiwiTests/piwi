/**
 * Incremental SHA-256, for hashing something too big to hold.
 *
 * `crypto.subtle.digest` takes a `BufferSource` and has no streaming form, so
 * digesting a file with it means allocating the whole file first. This is the
 * same algorithm with an `update`/`digest` pair, so an import never
 * materializes the archive: a 500 MB upload is hashed 8 MB at a time.
 *
 * Browser halves only. The server hashes with `node:crypto`, which is both
 * incremental and faster.
 *
 * FIPS 180-4. Verified against `crypto.subtle.digest` in the unit tests,
 * including the block-boundary and length-encoding cases that a hand-written
 * implementation gets wrong.
 */

/** Round constants: the first 32 bits of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial state: the first 32 bits of the square roots of the first 8 primes. */
// prettier-ignore
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export class Sha256 {
  #h = new Uint32Array(H0);
  /** The 64-byte block being filled, for input that does not arrive aligned. */
  #block = new Uint8Array(64);
  #blockLength = 0;
  #totalBytes = 0;
  /** Message schedule, reused across blocks rather than reallocated per block. */
  #w = new Uint32Array(64);
  #done = false;

  /** Absorb the next chunk. Any length; blocks are assembled internally. */
  update(chunk: Uint8Array): this {
    if (this.#done) throw new Error('Sha256: update() after digest()');
    this.#totalBytes += chunk.length;

    let offset = 0;

    // Top up a partial block left by the previous chunk.
    if (this.#blockLength > 0) {
      const need = Math.min(64 - this.#blockLength, chunk.length);
      this.#block.set(chunk.subarray(0, need), this.#blockLength);
      this.#blockLength += need;
      offset = need;
      if (this.#blockLength < 64) return this;
      this.#compress(this.#block, 0);
      this.#blockLength = 0;
    }

    // Whole blocks straight out of the caller's buffer, without copying.
    for (; offset + 64 <= chunk.length; offset += 64) this.#compress(chunk, offset);

    // Keep the remainder for the next chunk, or for the padding.
    if (offset < chunk.length) {
      this.#block.set(chunk.subarray(offset), 0);
      this.#blockLength = chunk.length - offset;
    }

    return this;
  }

  /** Finish and return the 32-byte digest. The instance is spent afterwards. */
  digest(): Uint8Array {
    if (this.#done) throw new Error('Sha256: digest() called twice');
    this.#done = true;

    const bitLength = this.#totalBytes * 8;

    // A 0x80 byte, zeroes, then the length as a 64-bit big-endian count of
    // bits. When the length will not fit in this block, pad out and use another.
    this.#block[this.#blockLength++] = 0x80;
    if (this.#blockLength > 56) {
      this.#block.fill(0, this.#blockLength);
      this.#compress(this.#block, 0);
      this.#blockLength = 0;
    }
    this.#block.fill(0, this.#blockLength, 56);

    const view = new DataView(this.#block.buffer, this.#block.byteOffset, 64);
    // Split rather than using BigInt: a file long enough to overflow the low
    // word is 512 MB, well inside what an import can be.
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.#compress(this.#block, 0);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.#h[i]!, false);
    return out;
  }

  /** Finish and return the digest as lowercase hex. */
  hex(): string {
    const bytes = this.digest();
    let hex = '';
    for (let i = 0; i < 32; i++) hex += HEX[bytes[i]!];
    return hex;
  }

  /**
   * One 64-byte block, read big-endian out of `data` at `offset`.
   *
   * The eight rounds in the body are one round each, written out. A SHA-256
   * round ends by shifting all eight working variables along by one; unrolling
   * a full cycle of eight lets the shift happen by *naming* — round two reads
   * `d` where round one read `e` — so only the two variables that change are
   * written.
   *
   * The whole thing is checked against `crypto.subtle` in the unit tests; that
   * is the guard that keeps this readable-as-a-black-box.
   */
  #compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    const h = this.#h;

    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (data[p]! << 24) | (data[p + 1]! << 16) | (data[p + 2]! << 8) | data[p + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    let S0 = 0;
    let S1 = 0;
    let ch = 0;
    let maj = 0;
    let t1 = 0;
    let t2 = 0;

    for (let i = 0; i < 64; i += 8) {
      S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      ch = (e & f) ^ (~e & g);
      t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      maj = (a & b) ^ (a & c) ^ (b & c);
      t2 = (S0 + maj) | 0;
      d = (d + t1) | 0;
      hh = (t1 + t2) | 0;

      S1 = ((d >>> 6) | (d << 26)) ^ ((d >>> 11) | (d << 21)) ^ ((d >>> 25) | (d << 7));
      ch = (d & e) ^ (~d & f);
      t1 = (g + S1 + ch + K[i + 1]! + w[i + 1]!) | 0;
      S0 = ((hh >>> 2) | (hh << 30)) ^ ((hh >>> 13) | (hh << 19)) ^ ((hh >>> 22) | (hh << 10));
      maj = (hh & a) ^ (hh & b) ^ (a & b);
      t2 = (S0 + maj) | 0;
      c = (c + t1) | 0;
      g = (t1 + t2) | 0;

      S1 = ((c >>> 6) | (c << 26)) ^ ((c >>> 11) | (c << 21)) ^ ((c >>> 25) | (c << 7));
      ch = (c & d) ^ (~c & e);
      t1 = (f + S1 + ch + K[i + 2]! + w[i + 2]!) | 0;
      S0 = ((g >>> 2) | (g << 30)) ^ ((g >>> 13) | (g << 19)) ^ ((g >>> 22) | (g << 10));
      maj = (g & hh) ^ (g & a) ^ (hh & a);
      t2 = (S0 + maj) | 0;
      b = (b + t1) | 0;
      f = (t1 + t2) | 0;

      S1 = ((b >>> 6) | (b << 26)) ^ ((b >>> 11) | (b << 21)) ^ ((b >>> 25) | (b << 7));
      ch = (b & c) ^ (~b & d);
      t1 = (e + S1 + ch + K[i + 3]! + w[i + 3]!) | 0;
      S0 = ((f >>> 2) | (f << 30)) ^ ((f >>> 13) | (f << 19)) ^ ((f >>> 22) | (f << 10));
      maj = (f & g) ^ (f & hh) ^ (g & hh);
      t2 = (S0 + maj) | 0;
      a = (a + t1) | 0;
      e = (t1 + t2) | 0;

      S1 = ((a >>> 6) | (a << 26)) ^ ((a >>> 11) | (a << 21)) ^ ((a >>> 25) | (a << 7));
      ch = (a & b) ^ (~a & c);
      t1 = (d + S1 + ch + K[i + 4]! + w[i + 4]!) | 0;
      S0 = ((e >>> 2) | (e << 30)) ^ ((e >>> 13) | (e << 19)) ^ ((e >>> 22) | (e << 10));
      maj = (e & f) ^ (e & g) ^ (f & g);
      t2 = (S0 + maj) | 0;
      hh = (hh + t1) | 0;
      d = (t1 + t2) | 0;

      S1 = ((hh >>> 6) | (hh << 26)) ^ ((hh >>> 11) | (hh << 21)) ^ ((hh >>> 25) | (hh << 7));
      ch = (hh & a) ^ (~hh & b);
      t1 = (c + S1 + ch + K[i + 5]! + w[i + 5]!) | 0;
      S0 = ((d >>> 2) | (d << 30)) ^ ((d >>> 13) | (d << 19)) ^ ((d >>> 22) | (d << 10));
      maj = (d & e) ^ (d & f) ^ (e & f);
      t2 = (S0 + maj) | 0;
      g = (g + t1) | 0;
      c = (t1 + t2) | 0;

      S1 = ((g >>> 6) | (g << 26)) ^ ((g >>> 11) | (g << 21)) ^ ((g >>> 25) | (g << 7));
      ch = (g & hh) ^ (~g & a);
      t1 = (b + S1 + ch + K[i + 6]! + w[i + 6]!) | 0;
      S0 = ((c >>> 2) | (c << 30)) ^ ((c >>> 13) | (c << 19)) ^ ((c >>> 22) | (c << 10));
      maj = (c & d) ^ (c & e) ^ (d & e);
      t2 = (S0 + maj) | 0;
      f = (f + t1) | 0;
      b = (t1 + t2) | 0;

      S1 = ((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7));
      ch = (f & g) ^ (~f & hh);
      t1 = (a + S1 + ch + K[i + 7]! + w[i + 7]!) | 0;
      S0 = ((b >>> 2) | (b << 30)) ^ ((b >>> 13) | (b << 19)) ^ ((b >>> 22) | (b << 10));
      maj = (b & c) ^ (b & d) ^ (c & d);
      t2 = (S0 + maj) | 0;
      e = (e + t1) | 0;
      a = (t1 + t2) | 0;
    }

    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
}

/**
 * Hex SHA-256 of a blob, read as a stream.
 *
 * Nothing larger than one chunk is ever held, so the archive's size does not
 * bound what can be hashed. `onProgress` reports the fraction read, which is
 * the whole of the work — the digest finishes with the last chunk.
 */
export async function sha256Blob(blob: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  const hash = new Sha256();
  const reader = blob.stream().getReader();
  let read = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    read += value.length;
    if (onProgress) onProgress(blob.size ? read / blob.size : 1);
  }

  if (onProgress) onProgress(1);
  return hash.hex();
}
