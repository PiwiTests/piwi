/**
 * Storage abstraction layer types
 */

export interface StorageAdapter {
  /**
   * Write a file to storage
   * @param path - Relative path where the file should be stored
   * @param data - File content as Buffer
   * @returns Promise that resolves when the file is written
   */
  writeFile(path: string, data: Buffer): Promise<void>;

  /**
   * Read a file from storage
   * @param path - Relative path of the file to read
   * @returns Promise that resolves with the file content as Buffer
   */
  readFile(path: string): Promise<Buffer>;

  /**
   * Check if a file exists
   * @param path - Relative path of the file to check
   * @returns Promise that resolves to true if the file exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Size of a stored file in bytes, without reading it
   * @param path - Relative path of the file
   * @returns Promise that resolves with the byte count, or null if the file does not exist
   */
  fileSize(path: string): Promise<number | null>;

  /**
   * Create a directory (and parent directories if needed)
   * @param path - Relative path of the directory to create
   * @returns Promise that resolves when the directory is created
   */
  mkdir(path: string): Promise<void>;

  /**
   * Delete a single file from storage
   * @param path - Relative path of the file to delete
   * @returns Promise that resolves when the file is deleted
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Delete a directory and all its contents recursively
   * @param path - Relative path of the directory to delete
   * @returns Promise that resolves when the directory is deleted
   */
  deleteDirectory(path: string): Promise<void>;

  /**
   * Get the full path for a relative path (for local storage only, returns relative path for S3)
   * @param path - Relative path
   * @returns Full path for local storage or relative path for S3
   */
  getFullPath(path: string): string;
}

interface S3BaseConfig {
  bucket: string;
  region: string;
  endpoint?: string; // Optional custom endpoint for S3-compatible services
  forcePathStyle?: boolean; // Force path-style URLs (required for MinIO and most S3-compatible services)
}

export type S3Config = S3BaseConfig &
  (
    | {
        accessKeyId: string;
        secretAccessKey: string;
      }
    | {
        accessKeyId?: undefined;
        secretAccessKey?: undefined;
      }
  );
