/**
 * Images in an MCP tool result. A handler attaches them to its JSON with
 * `withToolImages`; `toContent` sends the JSON as a text block, then each image
 * as an MCP `image` block after a line naming it, so the client shows the model
 * the image itself. The images sit under a symbol key, which `JSON.stringify`
 * skips: the JSON never carries image data, in `/mcp` or in the assistant's
 * tool results.
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

/** The media types an image block carries as stored: the ones vision models read. */
const SENDABLE_AS_STORED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const JPEG_QUALITY = 80;
const JPEG_QUALITY_FLOOR = 60;
/** The smallest long edge an image is shrunk to before it is given up on. */
const MIN_EDGE = 320;

/** An image as `fitImageForAgent` sends it. Its size is null when the image could not be decoded. */
export interface FittedImage {
  data: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** The size of the stored image, null when it could not be decoded. */
  original: { width: number; height: number } | null;
  /** True when `data` is a re-encoded copy, not the stored bytes. */
  reencoded: boolean;
}

/**
 * The image an agent reads whole: the stored bytes when they fit within
 * `maxEdge` pixels on the long edge and `maxBytes` bytes, else a JPEG copy,
 * re-encoded at a lower quality and then a smaller size until it fits.
 * Transparent pixels turn white. An image sharp cannot decode is sent as stored
 * when it is small enough. Null when nothing fits.
 */
export async function fitImageForAgent(
  input: Buffer,
  mimeType: string,
  limits: { maxEdge: number; maxBytes: number },
): Promise<FittedImage | null> {
  const asStored = SENDABLE_AS_STORED.has(mimeType) && input.length <= limits.maxBytes;
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(input).metadata();
    const original = { width: meta.width ?? 0, height: meta.height ?? 0 };
    const longEdge = Math.max(original.width, original.height);
    if (longEdge === 0) throw new Error('no image size');
    if (asStored && longEdge <= limits.maxEdge) {
      return { data: input, mimeType, ...original, original, reencoded: false };
    }

    let edge = Math.min(limits.maxEdge, longEdge);
    let quality = JPEG_QUALITY;
    for (;;) {
      const { data, info } = await sharp(input)
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= limits.maxBytes) {
        return { data, mimeType: 'image/jpeg', width: info.width, height: info.height, original, reencoded: true };
      }
      if (quality > JPEG_QUALITY_FLOOR) quality = JPEG_QUALITY_FLOOR;
      else if (edge > MIN_EDGE) edge = Math.max(MIN_EDGE, Math.round(edge * 0.75));
      else return null;
    }
  } catch {
    return asStored ? { data: input, mimeType, width: null, height: null, original: null, reencoded: false } : null;
  }
}
