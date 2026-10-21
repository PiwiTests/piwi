import type { S3Client } from '@aws-sdk/client-s3';
import type { StorageAdapter, S3Config } from './types';

/** The AWS SDK's S3 module, and the client this adapter's config built with it. */
type S3Sdk = { s3: typeof import('@aws-sdk/client-s3'); s3Client: S3Client };

/**
 * AWS S3 storage adapter
 * Stores files in an S3 bucket. The AWS SDK loads on the adapter's first call.
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly config: S3Config;
  private loading: Promise<S3Sdk> | null = null;

  constructor(config: S3Config) {
    this.config = config;
  }

  private sdk(): Promise<S3Sdk> {
    this.loading ??= import('@aws-sdk/client-s3').then((s3) => {
      const credentials =
        this.config.accessKeyId && this.config.secretAccessKey
          ? {
              accessKeyId: this.config.accessKeyId,
              secretAccessKey: this.config.secretAccessKey,
            }
          : undefined;
      const s3Client = new s3.S3Client({
        region: this.config.region,
        ...(credentials && { credentials }),
        ...(this.config.endpoint && { endpoint: this.config.endpoint }),
        // Default to path-style when a custom endpoint is set (required for MinIO, LocalStack, etc.)
        forcePathStyle: this.config.forcePathStyle ?? !!this.config.endpoint,
      });
      return { s3, s3Client };
    });
    return this.loading;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    try {
      const { s3, s3Client } = await this.sdk();
      const command = new s3.PutObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
        Body: data,
      });

      await s3Client.send(command);
    } catch (error) {
      console.error(`Failed to write file to S3: ${path}`, error);
      throw error;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    try {
      const { s3, s3Client } = await this.sdk();
      const command = new s3.GetObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });

      const response = await s3Client.send(command);

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
      const { s3, s3Client } = await this.sdk();
      const command = new s3.HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });

      const head = await s3Client.send(command);
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
      const { s3, s3Client } = await this.sdk();
      const command = new s3.DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: path,
      });
      await s3Client.send(command);
    } catch (error) {
      console.error(`Failed to delete file from S3: ${path}`, error);
      throw error;
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    try {
      const { s3, s3Client } = await this.sdk();
      const prefix = path.endsWith('/') ? path : `${path}/`;
      let continuationToken: string | undefined;

      do {
        const listCommand = new s3.ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listResult = await s3Client.send(listCommand);

        if (listResult.Contents && listResult.Contents.length > 0) {
          const deleteCommand = new s3.DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: {
              Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
            },
          });
          await s3Client.send(deleteCommand);
        }

        continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (error) {
      console.error(`Failed to delete directory from S3: ${path}`, error);
      throw error;
    }
  }
}
