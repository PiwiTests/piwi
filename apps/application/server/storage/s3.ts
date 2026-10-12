import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { StorageAdapter, S3Config } from './types';

/**
 * AWS S3 storage adapter
 * Stores files in an S3 bucket
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly config: S3Config;
  private s3Client: S3Client;

  constructor(config: S3Config) {
    this.config = config;
    const credentials =
      this.config.accessKeyId && this.config.secretAccessKey
        ? {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey,
          }
        : undefined;

    this.s3Client = new S3Client({
      region: this.config.region,
      ...(credentials && { credentials }),
      ...(this.config.endpoint && { endpoint: this.config.endpoint }),
      // Default to path-style when a custom endpoint is set (required for MinIO, LocalStack, etc.)
      forcePathStyle: this.config.forcePathStyle ?? !!this.config.endpoint,
    });
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
        Body: data,
      });

      await this.s3Client.send(command);
    } catch (error) {
      console.error(`Failed to write file to S3: ${path}`, error);
      throw error;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });

      const response = await this.s3Client.send(command);

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      // Response.Body is a readable stream from AWS SDK
      const body = response.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`Failed to read file from S3: ${path}`, error);
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.fileSize(path)) !== null;
  }

  async fileSize(path: string): Promise<number | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });

      const head = await this.s3Client.send(command);
      return head.ContentLength ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.error(`Failed to read file metadata from S3: ${path}`, error);
      throw error;
    }
  }

  async mkdir(_path: string): Promise<void> {
    // S3 doesn't require directory creation
    // Directories are implicit in S3 based on key prefixes
    return Promise.resolve();
  }

  getFullPath(path: string): string {
    // For S3, return the key as-is (relative path)
    return path;
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });
      await this.s3Client.send(command);
    } catch (error) {
      console.error(`Failed to delete file from S3: ${path}`, error);
      throw error;
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    try {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      let continuationToken: string | undefined;

      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listResult = await this.s3Client.send(listCommand);

        if (listResult.Contents && listResult.Contents.length > 0) {
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: {
              Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
            },
          });
          await this.s3Client.send(deleteCommand);
        }

        continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (error) {
      console.error(`Failed to delete directory from S3: ${path}`, error);
      throw error;
    }
  }
}
