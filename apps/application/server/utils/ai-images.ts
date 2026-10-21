/**
 * Screenshot downscaling for the AI diagnosis context. Current Claude models
 * accept high-resolution images but bill up to ~3× more tokens for them, and
 * failure screenshots rarely need more than ~1080p to be readable. Images are
 * resized (long edge ≤ `maxEdge`, aspect ratio kept, format preserved) before
 * being base64-attached; any failure falls back to the original image.
 */

import type { AiAttachedImage } from './ai-provider';

export async function downscaleImages(images: AiAttachedImage[], maxEdge: number): Promise<AiAttachedImage[]> {
  if (images.length === 0 || !Number.isFinite(maxEdge) || maxEdge <= 0) return images;

  return Promise.all(
    images.map(async (img) => {
      try {
        const input = Buffer.from(img.data, 'base64');
        const { default: sharp } = await import('sharp');
        const meta = await sharp(input).metadata();
        const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (edge <= maxEdge) return img;
        const resized = await sharp(input)
          .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
          .toBuffer();
        return { ...img, data: resized.toString('base64') };
      } catch {
        return img;
      }
    }),
  );
}
