import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { S3StorageAdapter } from '../server/storage/s3';
import { LocalStorageAdapter } from '../server/storage/local';
import { getStorage, resetStorage } from '../server/storage';

/**
 * S3 storage tests.
 *
 * These tests require a running S3-compatible server (e.g. RustFS).
 * They are skipped automatically when `PIWI_S3_TEST_ENDPOINT` is not set, so
 * running `npm test` locally without a local S3 server works as expected.
 *
 * To run them locally, start RustFS and export the variables below:
 *
 *   docker run -d -p 9000:9000 \
 *     -e RUSTFS_ACCESS_KEY=rustfsadmin \
 *     -e RUSTFS_SECRET_KEY=rustfsadmin \
 *     -e RUSTFS_CONSOLE_ENABLE=false \
 *     rustfs/rustfs:1.0.0-rc.6 /data
 *
 *   AWS_ACCESS_KEY_ID=rustfsadmin AWS_SECRET_ACCESS_KEY=rustfsadmin \
 *     aws --endpoint-url http://localhost:9000 s3 mb s3://playwright-test --region us-east-1
 *
 *   PIWI_S3_TEST_ENDPOINT=http://localhost:9000 \
 *   PIWI_S3_TEST_BUCKET=playwright-test \
 *   npx playwright test s3-storage.spec.ts
 */

const S3_ENDPOINT = process.env.PIWI_S3_TEST_ENDPOINT;
const S3_BUCKET = process.env.PIWI_S3_TEST_BUCKET || 'playwright-test';
const S3_REGION = process.env.PIWI_S3_TEST_REGION || 'us-east-1';
const S3_ACCESS_KEY_ID = process.env.PIWI_S3_TEST_ACCESS_KEY_ID || 'rustfsadmin';
const S3_SECRET_ACCESS_KEY = process.env.PIWI_S3_TEST_SECRET_ACCESS_KEY || 'rustfsadmin';

test.describe('S3 storage', () => {
  test.skip(!S3_ENDPOINT, 'Set PIWI_S3_TEST_ENDPOINT to run S3 tests (see s3-storage.spec.ts header for instructions)');

  let keyPrefix: string;
  let adapter: S3StorageAdapter;

  test.beforeEach(({}, testInfo) => {
    const safeTitle = testInfo.title
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .slice(0, 30);
    const sanitizedTestId = testInfo.testId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    keyPrefix = `test-${testInfo.workerIndex}-${sanitizedTestId}-${safeTitle}`;

    adapter = new S3StorageAdapter({
      bucket: S3_BUCKET,
      region: S3_REGION,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      endpoint: S3_ENDPOINT,
    });
  });

  test.afterEach(async () => {
    await adapter.deleteDirectory(keyPrefix);
  });

  test.describe('S3StorageAdapter', () => {
    test('should write and read a file', async () => {
      const path = `${keyPrefix}/hello.txt`;
      await adapter.writeFile(path, Buffer.from('Hello S3 World'));
      const result = await adapter.readFile(path);
      expect(result.toString()).toBe('Hello S3 World');
    });

    test('should report a file as existing after writing', async () => {
      const path = `${keyPrefix}/exists-test.txt`;

      expect(await adapter.exists(path)).toBe(false);
      await adapter.writeFile(path, Buffer.from('exists'));
      expect(await adapter.exists(path)).toBe(true);
    });

    test('should return false for a non-existent file', async () => {
      const path = `${keyPrefix}/does-not-exist.txt`;
      expect(await adapter.exists(path)).toBe(false);
    });

    test('should handle nested file paths', async () => {
      const path = `${keyPrefix}/project-1/run-123/report.html`;
      const content = '<html>S3 Test Report</html>';
      await adapter.writeFile(path, Buffer.from(content));
      const result = await adapter.readFile(path);
      expect(result.toString()).toBe(content);
    });

    test('should store binary data correctly', async () => {
      const path = `${keyPrefix}/binary-test.bin`;
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      await adapter.writeFile(path, data);
      const result = await adapter.readFile(path);
      expect(Buffer.compare(result, data)).toBe(0);
    });

    test('should store a file from disk, in one request or in parts', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'piwi-s3-from-'));
      try {
        // 8 MiB parts: 20 MiB goes in three, 1 KiB in one request.
        for (const [name, size] of [
          ['small.bin', 1024],
          ['large.bin', 20 * 1024 * 1024 + 5],
        ] as const) {
          const bytes = randomBytes(size);
          writeFileSync(join(dir, name), bytes);
          await adapter.writeFileFrom(`${keyPrefix}/${name}`, join(dir, name));
          expect(await adapter.fileSize(`${keyPrefix}/${name}`)).toBe(size);
          expect(Buffer.compare(await adapter.readFile(`${keyPrefix}/${name}`), bytes)).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('should overwrite an existing file', async () => {
      const path = `${keyPrefix}/overwrite.txt`;
      await adapter.writeFile(path, Buffer.from('original'));
      await adapter.writeFile(path, Buffer.from('updated'));
      const result = await adapter.readFile(path);
      expect(result.toString()).toBe('updated');
    });

    test('should use the AWS default credential chain when static config is omitted', async () => {
      const previousAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const previousSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const previousSessionToken = process.env.AWS_SESSION_TOKEN;
      process.env.AWS_ACCESS_KEY_ID = S3_ACCESS_KEY_ID;
      process.env.AWS_SECRET_ACCESS_KEY = S3_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;

      const defaultCredentialsAdapter = new S3StorageAdapter({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
      });
      const path = `${keyPrefix}/default-credentials.txt`;

      try {
        await defaultCredentialsAdapter.writeFile(path, Buffer.from('default credentials'));
        const result = await defaultCredentialsAdapter.readFile(path);
        expect(result.toString()).toBe('default credentials');
      } finally {
        await defaultCredentialsAdapter.deleteFile(path);
        if (previousAccessKeyId === undefined) delete process.env.AWS_ACCESS_KEY_ID;
        else process.env.AWS_ACCESS_KEY_ID = previousAccessKeyId;
        if (previousSecretAccessKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
        else process.env.AWS_SECRET_ACCESS_KEY = previousSecretAccessKey;
        if (previousSessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
        else process.env.AWS_SESSION_TOKEN = previousSessionToken;
      }
    });

    test('mkdir should be a no-op (S3 has no real directories)', async () => {
      await expect(adapter.mkdir(`${keyPrefix}/some/directory`)).resolves.toBeUndefined();
    });

    test("localRoot should be null (nothing is kept on the server's disk)", () => {
      expect(adapter.localRoot()).toBeNull();
    });

    test('should delete all objects under a directory prefix', async () => {
      const dir = `${keyPrefix}/to-delete`;
      await adapter.writeFile(`${dir}/file1.txt`, Buffer.from('one'));
      await adapter.writeFile(`${dir}/file2.txt`, Buffer.from('two'));
      await adapter.writeFile(`${dir}/sub/file3.txt`, Buffer.from('three'));

      expect(await adapter.exists(`${dir}/file1.txt`)).toBe(true);

      await adapter.deleteDirectory(dir);

      expect(await adapter.exists(`${dir}/file1.txt`)).toBe(false);
      expect(await adapter.exists(`${dir}/file2.txt`)).toBe(false);
      expect(await adapter.exists(`${dir}/sub/file3.txt`)).toBe(false);
    });

    test('deleteDirectory should not throw when prefix does not exist', async () => {
      await expect(adapter.deleteDirectory(`${keyPrefix}/nonexistent-dir`)).resolves.toBeUndefined();
    });
  });

  test.describe('Storage factory with S3', () => {
    test.beforeEach(() => {
      resetStorage();
    });

    test.afterEach(() => {
      resetStorage();
      // Restore any env var changes made by these tests
      delete process.env.PIWI_STORAGE_TYPE;
      delete process.env.PIWI_S3_BUCKET;
      delete process.env.PIWI_S3_REGION;
      delete process.env.PIWI_S3_ACCESS_KEY_ID;
      delete process.env.PIWI_S3_SECRET_ACCESS_KEY;
      delete process.env.PIWI_S3_ENDPOINT;
    });

    test('getStorage returns S3StorageAdapter when PIWI_STORAGE_TYPE=s3', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      process.env.PIWI_S3_BUCKET = S3_BUCKET;
      process.env.PIWI_S3_REGION = S3_REGION;
      process.env.PIWI_S3_ACCESS_KEY_ID = S3_ACCESS_KEY_ID;
      process.env.PIWI_S3_SECRET_ACCESS_KEY = S3_SECRET_ACCESS_KEY;
      process.env.PIWI_S3_ENDPOINT = S3_ENDPOINT;

      const storage = getStorage();
      expect(storage).toBeInstanceOf(S3StorageAdapter);
    });

    test('getStorage returns the same singleton on repeated calls', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      process.env.PIWI_S3_BUCKET = S3_BUCKET;
      process.env.PIWI_S3_REGION = S3_REGION;
      process.env.PIWI_S3_ACCESS_KEY_ID = S3_ACCESS_KEY_ID;
      process.env.PIWI_S3_SECRET_ACCESS_KEY = S3_SECRET_ACCESS_KEY;
      process.env.PIWI_S3_ENDPOINT = S3_ENDPOINT;

      const first = getStorage();
      const second = getStorage();
      expect(first).toBe(second);
    });

    test('resetStorage allows switching from S3 back to local', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      process.env.PIWI_S3_BUCKET = S3_BUCKET;
      process.env.PIWI_S3_REGION = S3_REGION;
      process.env.PIWI_S3_ACCESS_KEY_ID = S3_ACCESS_KEY_ID;
      process.env.PIWI_S3_SECRET_ACCESS_KEY = S3_SECRET_ACCESS_KEY;
      process.env.PIWI_S3_ENDPOINT = S3_ENDPOINT;

      const s3Storage = getStorage();
      expect(s3Storage).toBeInstanceOf(S3StorageAdapter);

      resetStorage();
      process.env.PIWI_STORAGE_TYPE = 'local';

      const localStorage = getStorage();
      expect(localStorage).toBeInstanceOf(LocalStorageAdapter);
    });
  });
});
