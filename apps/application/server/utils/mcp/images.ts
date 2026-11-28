/**
 * Images in an MCP tool result. A handler attaches them to its JSON with
 * `withToolImages`; `toContent` sends the JSON as a text block, then each image
 * as an MCP `image` block after a line naming it, so the client shows the model
 * the image itself. The images sit under a symbol key, which `JSON.stringify`
 * skips: the JSON never carries image data.
 */

/** One image of a tool result. */
export interface ToolImage {
  /** The text block sent before the image, naming what it shows. */
  caption: string;
  /** Base64 image data. */
  data: string;
  mimeType: string;
}

const TOOL_IMAGES = Symbol('mcp-tool-images');

/** `json` with `images` attached, sent after it as image blocks. */
export function withToolImages<T extends object>(json: T, images: ToolImage[]): T {
  return images.length === 0 ? json : Object.assign(json, { [TOOL_IMAGES]: images });
}

/** The images attached to a tool result with `withToolImages`, none for any other value. */
export function toolImagesOf(data: unknown): ToolImage[] {
  if (data === null || typeof data !== 'object') return [];
  return (data as { [TOOL_IMAGES]?: ToolImage[] })[TOOL_IMAGES] ?? [];
}

/** The formats an image block carries, as sharp names them, with their media types. */
const RASTER_MEDIA_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
type RasterFormat = keyof typeof RASTER_MEDIA_TYPES;

/** The raster format `bytes` start as, from their signature alone; null for any other file. */
function rasterFormatOf(bytes: Uint8Array): RasterFormat | null {
  const startsWith = (offset: number, signature: number[]) =>
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(0, [0x47, 0x49, 0x46, 0x38]) && (startsWith(4, [0x37, 0x61]) || startsWith(4, [0x39, 0x61]))) {
    return 'gif';
  }
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

/** The media type of a PNG, JPEG, GIF or WebP file, read from its bytes; null for any other file. */
export function imageMediaTypeOf(bytes: Uint8Array): string | null {
  const format = rasterFormatOf(bytes);
  return format ? RASTER_MEDIA_TYPES[format] : null;
}

/** The most pixels an image may hold to be decoded. */
export const MAX_DECODED_PIXELS = 50_000_000;

const JPEG_QUALITY = 80;
const JPEG_QUALITY_FLOOR = 60;
/** The smallest long edge an image is shrunk to before it is given up on. */
const MIN_EDGE = 320;

/** An image as `fitImageForAgent` sends it. Its size is null when no image library could read it. */
export interface FittedImage {
  data: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** The size of the stored image, null when no image library could read it. */
  original: { width: number; height: number } | null;
  /** True when `data` is a re-encoded copy, not the stored bytes. */
  reencoded: boolean;
}

/** Why an image is not sent, as the tool result says it. */
export interface NotSent {
  notSent: string;
}

/** The image library, null on a server that has none. */
async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

const NOT_RASTER: NotSent = { notSent: 'The stored file is not a PNG, JPEG, GIF or WebP image.' };
const UNDECODABLE: NotSent = { notSent: 'The stored file could not be decoded as an image.' };

/**
 * The image an agent reads whole, from a PNG, JPEG, GIF or WebP file (told by
 * its bytes, never its name): the stored bytes when they decode and fit within
 * `maxEdge` pixels on the long edge and `maxBytes` bytes, else a JPEG copy,
 * re-encoded at a lower quality and then a smaller size until it fits. The file
 * is decoded once, past a header check of its size (at most
 * {@link MAX_DECODED_PIXELS}); transparent pixels turn white. On a server
 * without sharp, a file small enough is sent as stored, unchecked.
 */
export async function fitImageForAgent(
  input: Buffer,
  limits: { maxEdge: number; maxBytes: number },
): Promise<FittedImage | NotSent> {
  const format = rasterFormatOf(input);
  if (!format) return NOT_RASTER;
  const mimeType = RASTER_MEDIA_TYPES[format];

  const sharp = await loadSharp();
  if (!sharp) {
    return input.length <= limits.maxBytes
      ? { data: input, mimeType, width: null, height: null, original: null, reencoded: false }
      : { notSent: 'This server cannot decode images, and the stored file is too large to send as it is.' };
  }

  try {
    // The header alone gives the format and the size: no pixel limit applies to reading it.
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    const original = { width: meta.width ?? 0, height: meta.height ?? 0 };
    if (meta.format !== format || original.width === 0 || original.height === 0) return UNDECODABLE;
    if (original.width * original.height > MAX_DECODED_PIXELS) {
      return {
        notSent: `The image is too large to decode (over ${MAX_DECODED_PIXELS.toLocaleString('en-US')} pixels).`,
      };
    }

    const longEdge = Math.max(original.width, original.height);
    const pixels = await sharp(input, { limitInputPixels: MAX_DECODED_PIXELS })
      .resize({ width: limits.maxEdge, height: limits.maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (longEdge <= limits.maxEdge && input.length <= limits.maxBytes) {
      return { data: input, mimeType, ...original, original, reencoded: false };
    }

    const raw = { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels };
    let edge = Math.max(raw.width, raw.height);
    let quality = JPEG_QUALITY;
    for (;;) {
      const { data, info } = await sharp(pixels.data, { raw })
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= limits.maxBytes) {
        return { data, mimeType: 'image/jpeg', width: info.width, height: info.height, original, reencoded: true };
      }
      if (quality > JPEG_QUALITY_FLOOR) quality = JPEG_QUALITY_FLOOR;
      else if (edge > MIN_EDGE) edge = Math.max(MIN_EDGE, Math.round(edge * 0.75));
      else return { notSent: 'The image could not be made small enough to send.' };
    }
  } catch {
    return UNDECODABLE;
  }
}
