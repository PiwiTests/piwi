import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { users } from '../database/schema';
import { getStorage } from '../storage';
import { apiError } from './api-error';
import type { PublicImage } from './public-image';
import {
  PROFILE_PICTURE_BYTE_LIMIT,
  PROFILE_PICTURE_MAX_SIDE,
  PROFILE_PICTURE_STORED_SIDE,
} from '#shared/profile-picture';

/** The formats an upload may be, as sharp names them: raster only, never SVG. */
const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

/**
 * An uploaded picture as it is stored: checked from its bytes alone (PNG, JPEG
 * or WebP, under {@link PROFILE_PICTURE_BYTE_LIMIT} bytes and at most
 * {@link PROFILE_PICTURE_MAX_SIDE} pixels a side), then re-encoded as a square
 * WebP with no metadata, so EXIF and GPS data never reach storage. Throws a 400
 * or 413 for a refused upload, and a 503 when the server cannot decode images.
 */
export async function normalizeProfilePicture(input: Buffer): Promise<Buffer> {
  if (input.byteLength === 0) throw apiError({ statusCode: 400, message: 'The picture is empty' });
  if (input.byteLength >= PROFILE_PICTURE_BYTE_LIMIT) {
    throw apiError({ statusCode: 413, message: 'The picture must weigh less than 1 MB' });
  }

  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw apiError({ statusCode: 503, message: 'This server cannot read images, so it cannot store a picture' });
  }

  const options = { limitInputPixels: PROFILE_PICTURE_MAX_SIDE * PROFILE_PICTURE_MAX_SIDE, animated: false };
  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    ({ format, width = 0, height = 0 } = await sharp(input, options).metadata());
  } catch {
    throw apiError({ statusCode: 400, message: 'The picture must be a PNG, JPEG or WebP image' });
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw apiError({ statusCode: 400, message: 'The picture must be a PNG, JPEG or WebP image' });
  }
  if (width > PROFILE_PICTURE_MAX_SIDE || height > PROFILE_PICTURE_MAX_SIDE) {
    throw apiError({ statusCode: 400, message: 'The picture must be at most 1000 × 1000 pixels' });
  }

  try {
    return await sharp(input, options)
      .rotate()
      .resize(PROFILE_PICTURE_STORED_SIDE, PROFILE_PICTURE_STORED_SIDE, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw apiError({ statusCode: 400, message: 'The picture could not be read' });
  }
}

/**
 * Where a user's stored picture lives: named by its bytes and a random part, so
 * a key is never used twice. A new picture never reuses a cached address, and
 * deleting a replaced picture never deletes the one a later upload stored.
 */
export function profilePictureKey(userId: number, stored: Buffer): string {
  const hash = createHash('sha256').update(stored).digest('hex');
  return `${profilePictureFolder(userId)}/${hash}-${randomBytes(8).toString('hex')}.webp`;
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

/** Delete every picture a deleted user stored, those two uploads at once left behind included. */
export async function deleteUserProfilePictures(userId: number): Promise<void> {
  try {
    await getStorage().deleteDirectory(profilePictureFolder(userId));
  } catch (error) {
    console.warn('[profile-picture] Failed to delete the pictures of user %d:', userId, error);
  }
}

/**
 * Store `input` as the user's uploaded picture: the file first, then the row,
 * then the previous file is deleted. Returns the new storage key.
 */
export async function saveProfilePicture(db: DrizzleDB, userId: number, input: Buffer): Promise<string> {
  const stored = await normalizeProfilePicture(input);
  const [current] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, userId));
  if (!current) throw apiError({ statusCode: 404, message: 'User not found' });

  const key = profilePictureKey(userId, stored);
  await getStorage().writeFile(key, stored);
  const updated = await db
    .update(users)
    .set({ avatarKey: key, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length === 0) {
    await deleteStoredProfilePicture(key);
    throw apiError({ statusCode: 404, message: 'User not found' });
  }
  await deleteStoredProfilePicture(current.avatarKey);
  return key;
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

/** A stored picture as the avatar route serves it; null when its file is gone. Throws when storage cannot answer. */
export async function readStoredProfilePicture(key: string): Promise<PublicImage | null> {
  const storage = getStorage();
  if (!(await storage.exists(key))) return null;
  return { bytes: new Uint8Array(await storage.readFile(key)), mime: 'image/webp' };
}
