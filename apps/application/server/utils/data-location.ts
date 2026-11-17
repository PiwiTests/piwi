import { resolve } from 'path';
import { getStorage } from '../storage';
import { getDirectorySize } from './filesize';

/** Where the instance keeps its data, as the admin storage and stats routes report it. */
export interface DataLocation {
  /** Bytes under the storage folder, measured on disk; null for a remote store (S3) or storage that cannot be opened. */
  storageSizeOnDisk: number | null;
  /** The SQLite file's absolute path, or a label for PostgreSQL that names no credential. */
  databaseLocation: string;
  /** The storage folder's absolute path, or the S3 bucket's name. */
  storageLocation: string;
}

/**
 * The database's and the storage's location, and the storage's size on disk. The size can exceed the tracked total
 * when untracked files linger. Only a store with a folder on this server's disk is walked.
 */
export async function getDataLocation(): Promise<DataLocation> {
  let root: string | null;
  try {
    root = getStorage().localRoot();
  } catch {
    // An S3 configuration missing its bucket or region opens no storage: nothing to measure.
    root = null;
  }
  const storageSizeOnDisk = root === null ? null : await getDirectorySize(root);

  const databaseLocation = process.env.PIWI_DATABASE_URL
    ? 'PostgreSQL (external database)'
    : resolve(process.env.PIWI_DATABASE_PATH || '.data/piwi.db');
  const storageLocation =
    (process.env.PIWI_STORAGE_TYPE || 'local') === 's3'
      ? `S3 bucket: ${process.env.PIWI_S3_BUCKET || '(not set)'}`
      : resolve(process.env.PIWI_STORAGE_PATH || '.data/storage');

  return { storageSizeOnDisk, databaseLocation, storageLocation };
}
