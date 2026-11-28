import { afterAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The S3 adapter against a bucket that refuses to delete some keys, and to read one. */

const bucket = vi.hoisted(() => ({
  keys: ['project-1/run-1/a.png', 'project-1/run-1/b.png'],
  refused: new Set<string>(),
  objects: new Map<string, string>([['avatars/1/a.webp', 'webp']]),
  /** Each request a file's upload sent, by command and part. */
  sent: [] as string[],
  /** The part numbers the bucket fails, and whether it refuses an abort. */
  failingParts: new Set<number>(),
  refusesAbort: false,
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class ListObjectsV2Command extends Command {}
  class DeleteObjectsCommand extends Command {}
  class GetObjectCommand extends Command {}
  class AbortMultipartUploadCommand extends Command {}
  class S3Client {
    // What @aws-sdk/lib-storage reads of its client.
    config = {
      endpoint: async () => ({ protocol: 'https:', hostname: 's3.eu-west-1.amazonaws.com', path: '/' }),
      forcePathStyle: false,
      requestHandler: {},
      requestChecksumCalculation: async () => 'WHEN_SUPPORTED',
    };
    async send(command: Command) {
      // lib-storage sends the SDK's own command classes; the adapter's abort is this module's.
      const kind = command.constructor.name;
      const input = command.input as { PartNumber?: number; Body?: Buffer };
      if (kind === 'PutObjectCommand') {
        bucket.sent.push(`put ${input.Body?.length}`);
        return { ETag: '"put"' };
      }
      if (kind === 'CreateMultipartUploadCommand') {
        bucket.sent.push('create');
        return { UploadId: 'upload-1' };
      }
      if (kind === 'UploadPartCommand') {
        bucket.sent.push(`part ${input.PartNumber} ${input.Body?.length}`);
        if (bucket.failingParts.has(input.PartNumber!)) {
          throw Object.assign(new Error('Slow Down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
        }
        return { ETag: `"part-${input.PartNumber}"` };
      }
      if (kind === 'CompleteMultipartUploadCommand') {
        bucket.sent.push('complete');
        return {};
      }
      if (command instanceof AbortMultipartUploadCommand) {
        bucket.sent.push(`abort ${command.input.UploadId}`);
        if (bucket.refusesAbort) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key as string;
        if (key === 'avatars/1/denied.webp') {
          throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        }
        const body = bucket.objects.get(key);
        if (body === undefined) {
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { Body: [new TextEncoder().encode(body)] };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: bucket.keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      const objects = (command.input.Delete as { Objects: Array<{ Key: string }> }).Objects;
      const refused = objects.filter((o) => bucket.refused.has(o.Key));
      bucket.keys = bucket.keys.filter((key) => !objects.some((o) => o.Key === key) || bucket.refused.has(key));
      // As S3 does: 200, with the keys it could not delete listed in the body.
      return {
        Deleted: objects.filter((o) => !bucket.refused.has(o.Key)),
        Errors: refused.map((o) => ({ Key: o.Key, Code: 'AccessDenied', Message: 'Access Denied' })),
      };
    }
  }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand, AbortMultipartUploadCommand };
});

const { S3StorageAdapter } = await import('../../server/storage/s3');

describe('S3StorageAdapter.deleteDirectory', () => {
  test('throws when the bucket refuses to delete a key, naming it', async () => {
    bucket.refused.add('project-1/run-1/b.png');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new S3StorageAdapter({ bucket: 'piwi', region: 'eu-west-1' });

    await expect(storage.deleteDirectory('project-1')).rejects.toThrow(/project-1\/run-1\/b\.png: AccessDenied/);
    expect(bucket.keys).toEqual(['project-1/run-1/b.png']);
  });
});

describe('S3StorageAdapter.readFileIfExists', () => {
  test('reads a stored object, is null for a missing key without logging, and throws on any other failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.mockClear();
    const storage = new S3StorageAdapter({ bucket: 'piwi', region: 'eu-west-1' });

    expect((await storage.readFileIfExists('avatars/1/a.webp'))?.toString()).toBe('webp');
    expect(await storage.readFileIfExists('avatars/1/missing.webp')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    await expect(storage.readFileIfExists('avatars/1/denied.webp')).rejects.toMatchObject({ name: 'AccessDenied' });
  });
});

describe('S3StorageAdapter.writeFileFrom', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-s3-from-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const MIB = 1024 * 1024;
  const file = (name: string, size: number) => {
    writeFileSync(join(dir, name), Buffer.alloc(size, 1));
    return join(dir, name);
  };

  test('sends a file of one part in one request, and a larger one in parts of 8 MiB', async () => {
    const storage = new S3StorageAdapter({ bucket: 'piwi', region: 'eu-west-1' });
    bucket.sent = [];
    await storage.writeFileFrom('project-1/run-1/small.bin', file('small.bin', 1024));
    expect(bucket.sent).toEqual(['put 1024']);

    bucket.sent = [];
    await storage.writeFileFrom('project-1/run-1/large.bin', file('large.bin', 16 * MIB + 5));
    expect(bucket.sent.sort()).toEqual(['complete', 'create', `part 1 ${8 * MIB}`, `part 2 ${8 * MIB}`, 'part 3 5']);
  });

  test('aborts an upload whose part fails, and fails with that error even when the abort is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new S3StorageAdapter({ bucket: 'piwi', region: 'eu-west-1' });
    const large = file('failing.bin', 16 * MIB + 5);
    bucket.failingParts = new Set([2]);
    for (const refusesAbort of [false, true]) {
      bucket.refusesAbort = refusesAbort;
      bucket.sent = [];
      await expect(storage.writeFileFrom('project-1/run-1/failing.bin', large)).rejects.toMatchObject({
        name: 'SlowDown',
      });
      expect(bucket.sent).toContain('abort upload-1');
      expect(bucket.sent).not.toContain('complete');
    }
    bucket.failingParts = new Set();
    bucket.refusesAbort = false;
  });
});
