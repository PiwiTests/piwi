import { describe, expect, test, vi } from 'vitest';

/** The S3 adapter against a bucket that refuses to delete some keys, and to read one. */

const bucket = vi.hoisted(() => ({
  keys: ['project-1/run-1/a.png', 'project-1/run-1/b.png'],
  refused: new Set<string>(),
  objects: new Map<string, string>([['avatars/1/a.webp', 'webp']]),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class ListObjectsV2Command extends Command {}
  class DeleteObjectsCommand extends Command {}
  class GetObjectCommand extends Command {}
  class S3Client {
    async send(command: Command) {
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
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand };
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
