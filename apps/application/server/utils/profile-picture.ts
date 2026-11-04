import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { users } from '../database/schema';
import { getStorage } from '../storage';
import { apiError } from './api-error';
import type { PublicImage } from './public-image';
import {
  PROFILE_PICTURE_MAX_BYTES,
  PROFILE_PICTURE_MAX_SIDE,
  PROFILE_PICTURE_STORED_SIDE,
  PROFILE_PICTURE_TOO_HEAVY,
} from '#shared/profile-picture';

/** The formats an upload may be, as sharp names them: raster only, never SVG. */
const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

const WRONG_FORMAT = 'The picture must be a PNG, JPEG or WebP image';

/** How many times an upload retries its swap when other uploads keep replacing the picture. */
const SAVE_ATTEMPTS = 5;

/**
 * Whether `bytes` start as a PNG, JPEG or WebP file. Checked before sharp sees
 * the upload, so no other decoder (SVG, HEIF, TIFF, GIF) ever parses it.
 */
export function hasAcceptedSignature(bytes: Uint8Array): boolean {
  const startsWith = (offset: number, signature: number[]) =>
    bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);
  return (
    startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(0, [0xff, 0xd8, 0xff]) ||
    (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50]))
  );
}

/**
 * An uploaded picture as it is stored: checked from its bytes alone (PNG, JPEG
 * or WebP, at most {@link PROFILE_PICTURE_MAX_BYTES} bytes and at most
 * {@link PROFILE_PICTURE_MAX_SIDE} pixels a side), then re-encoded as a square
 * WebP with no metadata, so EXIF and GPS data never reach storage. Throws a 400
 * or 413 for a refused upload, and a 503 when the server cannot decode images.
 */
export async function normalizeProfilePicture(input: Buffer): Promise<Buffer> {
  if (input.byteLength === 0) throw apiError({ statusCode: 400, message: 'The picture is empty' });
  if (input.byteLength > PROFILE_PICTURE_MAX_BYTES) {
    throw apiError({ statusCode: 413, message: PROFILE_PICTURE_TOO_HEAVY });
  }
  if (!hasAcceptedSignature(input)) throw apiError({ statusCode: 400, message: WRONG_FORMAT });

  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw apiError({ statusCode: 503, message: 'This server cannot read images, so it cannot store a picture' });
  }

  // The header alone gives the format and the size: no pixel limit applies to reading it.
  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    ({ format, width = 0, height = 0 } = await sharp(input, { limitInputPixels: false, animated: false }).metadata());
  } catch {
    throw apiError({ statusCode: 400, message: WRONG_FORMAT });
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) throw apiError({ statusCode: 400, message: WRONG_FORMAT });
  if (width > PROFILE_PICTURE_MAX_SIDE || height > PROFILE_PICTURE_MAX_SIDE) {
    throw apiError({ statusCode: 400, message: 'The picture must be at most 1000 × 1000 pixels' });
  }

  try {
    return await sharp(input, {
      limitInputPixels: PROFILE_PICTURE_MAX_SIDE * PROFILE_PICTURE_MAX_SIDE,
      animated: false,
    })
      .rotate()
      .resize(PROFILE_PICTURE_STORED_SIDE, PROFILE_PICTURE_STORED_SIDE, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw apiError({ statusCode: 400, message: 'The picture could not be read' });
  }
}

/**
 * Where a new picture of the user is stored: a random name, so a key is never
 * used twice. A new picture never reuses a cached address, and deleting a
 * replaced picture never deletes the one a later upload stored.
 */
export function profilePictureKey(userId: number): string {
  return `${profilePictureFolder(userId)}/${randomBytes(8).toString('hex')}.webp`;
}

/** The folder of a user's stored pictures. */
function profilePictureFolder(userId: number): string {
  return `avatars/${userId}`;
}

/** Delete a stored picture, logging rather than failing: the row no longer names it. */
export async function deleteStoredProfilePicture(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await getStorage().deleteFile(key);
  } catch (error) {
    console.warn('[profile-picture] Failed to delete %s:', key, error);
  }
}

/** Delete every picture a deleted user stored: their whole folder. */
export async function deleteUserProfilePictures(userId: number): Promise<void> {
  try {
    await getStorage().deleteDirectory(profilePictureFolder(userId));
  } catch (error) {
    console.warn('[profile-picture] Failed to delete the pictures of user %d:', userId, error);
  }
}

/**
 * Store `input` as the user's uploaded picture: the file first, then the row,
 * swapped only from the key last read, then the previous file is deleted. An
 * upload that loses the swap to another one reads again, so every replaced file
 * is deleted. Returns the new storage key.
 */
export async function saveProfilePicture(db: DrizzleDB, userId: number, input: Buffer): Promise<string> {
  const stored = await normalizeProfilePicture(input);
  const key = profilePictureKey(userId);
  await getStorage().writeFile(key, stored);
  try {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const [current] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId));
      if (!current) throw apiError({ statusCode: 404, message: 'User not found' });
      const swapped = await db
        .update(users)
        .set({ avatarKey: key, updatedAt: new Date() })
        .where(
          and(
            eq(users.id, userId),
            current.avatarKey === null ? isNull(users.avatarKey) : eq(users.avatarKey, current.avatarKey),
          ),
        )
        .returning({ id: users.id });
      if (swapped.length > 0) {
        await deleteStoredProfilePicture(current.avatarKey);
        return key;
      }
    }
  } catch (error) {
    await deleteStoredProfilePicture(key);
    throw error;
  }
  await deleteStoredProfilePicture(key);
  throw apiError({ statusCode: 409, message: 'The picture kept changing while it was saved: try again' });
}

/**
 * Remove the user's uploaded picture, if any: the row first, then the file.
 * Returns whether it removed one; false too when an upload replaced it meanwhile,
 * which keeps the new picture.
 */
export async function removeProfilePicture(db: DrizzleDB, userId: number): Promise<boolean> {
  const [current] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId));
  if (!current) throw apiError({ statusCode: 404, message: 'User not found' });
  if (!current.avatarKey) return false;
  const cleared = await db
    .update(users)
    .set({ avatarKey: null, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.avatarKey, current.avatarKey)))
    .returning({ id: users.id });
  if (cleared.length === 0) return false;
  await deleteStoredProfilePicture(current.avatarKey);
  return true;
}

/** Whether a storage read failed because the file is not there (local disk or S3). */
function isMissingFile(error: unknown): boolean {
  const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    e?.code === 'ENOENT' ||
    e?.code === 'ENOTDIR' ||
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/** A stored picture as the avatar route serves it; null when its file is gone. Throws when storage cannot answer. */
export async function readStoredProfilePicture(key: string): Promise<PublicImage | null> {
  try {
    return { bytes: new Uint8Array(await getStorage().readFile(key)), mime: 'image/webp' };
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
