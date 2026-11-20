import { test, expect } from './fixtures';
import { LocalStorageAdapter } from '../server/storage/local';
import { S3StorageAdapter } from '../server/storage/s3';
import { getStorage, resetStorage } from '../server/storage';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { PROJECT } from '#shared/test-project-names';

test.describe('Storage Abstraction Tests', () => {
  // Use a unique directory per test to avoid conflicts when running in parallel
  let testStorageDir: string;

  test.beforeEach(({}, testInfo) => {
    // Create a unique directory per test using worker index, test id, and a readable title prefix
    const safeTitle = testInfo.title
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .slice(0, 30);
    const sanitizedTestId = testInfo.testId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    testStorageDir = join(process.cwd(), `.test-storage-${testInfo.workerIndex}-${sanitizedTestId}-${safeTitle}`);

    // Reset storage instance for each test
    resetStorage();

    // Create test storage directory
    if (!existsSync(testStorageDir)) {
      mkdirSync(testStorageDir, { recursive: true });
    }
  });

  test.afterEach(() => {
    // Clean up test storage directory
    if (testStorageDir && existsSync(testStorageDir)) {
      try {
        rmSync(testStorageDir, { recursive: true, force: true });
      } catch (error) {
        if (process.platform === 'win32') {
          // Ignore cleanup errors on Windows (file locking issues)
          return;
        }
        throw error;
      }
    }
  });

  test.describe('LocalStorageAdapter', () => {
    test('should write and read files', async () => {
      const storage = new LocalStorageAdapter(testStorageDir);
      const testPath = 'test-file.txt';
      const testData = Buffer.from('Hello World');

      await storage.writeFile(testPath, testData);
      const readData = await storage.readFile(testPath);

      expect(readData.toString()).toBe('Hello World');
    });

    test('should check if file exists', async () => {
      const storage = new LocalStorageAdapter(testStorageDir);
      const testPath = 'exists-test.txt';
      const testData = Buffer.from('Test content');

      expect(await storage.exists(testPath)).toBe(false);

      await storage.writeFile(testPath, testData);

      expect(await storage.exists(testPath)).toBe(true);
    });

    test('should create directories', async () => {
      const storage = new LocalStorageAdapter(testStorageDir);
      const dirPath = 'nested/deep/directory';

      await storage.mkdir(dirPath);

      expect(existsSync(join(testStorageDir, dirPath))).toBe(true);
    });

    test('should handle nested file paths', async () => {
      const storage = new LocalStorageAdapter(testStorageDir);
      const testPath = 'project-1/run-123/report.html';
      const testData = Buffer.from('<html>Test Report</html>');

      await storage.writeFile(testPath, testData);
      const readData = await storage.readFile(testPath);

      expect(readData.toString()).toBe('<html>Test Report</html>');
    });

    test('should name its folder as an absolute path', () => {
      const storage = new LocalStorageAdapter(testStorageDir);

      expect(storage.localRoot()).toBe(resolve(testStorageDir));
    });
  });

  test.describe('Storage Factory', () => {
    test('should return local storage by default', () => {
      // Set environment to use local storage
      process.env.PIWI_STORAGE_TYPE = 'local';
      process.env.PIWI_STORAGE_PATH = testStorageDir;

      const storage = getStorage();
      expect(storage).toBeInstanceOf(LocalStorageAdapter);
    });

    test('should use PIWI_STORAGE_PATH from environment', async () => {
      process.env.PIWI_STORAGE_TYPE = 'local';
      process.env.PIWI_STORAGE_PATH = testStorageDir;

      const storage = getStorage();
      const testPath = 'env-test.txt';
      const testData = Buffer.from('Environment test');

      await storage.writeFile(testPath, testData);

      const fullPath = join(testStorageDir, testPath);
      expect(existsSync(fullPath)).toBe(true);
    });

    test('should throw error when S3 config is incomplete', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      delete process.env.PIWI_S3_BUCKET;
      delete process.env.PIWI_S3_REGION;
      delete process.env.PIWI_S3_ACCESS_KEY_ID;
      delete process.env.PIWI_S3_SECRET_ACCESS_KEY;

      expect(() => getStorage()).toThrow(/S3 storage requires/);
    });

    test('should allow the AWS default credential chain for S3', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      process.env.PIWI_S3_BUCKET = 'test-bucket';
      process.env.PIWI_S3_REGION = 'us-east-1';
      delete process.env.PIWI_S3_ACCESS_KEY_ID;
      delete process.env.PIWI_S3_SECRET_ACCESS_KEY;

      expect(getStorage()).toBeInstanceOf(S3StorageAdapter);
    });

    test('should require static S3 credentials to be set as a pair', () => {
      process.env.PIWI_STORAGE_TYPE = 's3';
      process.env.PIWI_S3_BUCKET = 'test-bucket';
      process.env.PIWI_S3_REGION = 'us-east-1';
      process.env.PIWI_S3_ACCESS_KEY_ID = 'access-key';
      delete process.env.PIWI_S3_SECRET_ACCESS_KEY;

      expect(() => getStorage()).toThrow(/must be set together/);
    });
  });

  test.describe('Integration with API', () => {
    test('should store and retrieve files via storage abstraction', async ({ request }) => {
      // Set environment to use local storage with test directory
      process.env.PIWI_STORAGE_TYPE = 'local';
      process.env.PIWI_STORAGE_PATH = testStorageDir;
      resetStorage();

      // Upload a test result with HTML report
      const htmlContent = Buffer.from(`
        <!DOCTYPE html>
        <html>
          <head><title>Storage Test Report</title></head>
          <body><h1>Test Report via Storage Abstraction</h1></body>
        </html>
      `);

      const response = await request.post('/api/test-runs/upload', {
        multipart: {
          projectName: PROJECT.STORAGE_TEST,
          testRun: JSON.stringify({
            status: 'passed',
            startTime: new Date().toISOString(),
            duration: 60000,
            totalTests: 1,
            passedTests: 1,
            failedTests: 0,
            skippedTests: 0,
          }),
          testCases: JSON.stringify([
            {
              title: 'storage abstraction test',
              status: 'passed',
              duration: 1000,
              location: 'tests/storage.spec.ts:10:5',
            },
          ]),
          htmlReport: {
            name: 'report.html',
            mimeType: 'text/html',
            buffer: htmlContent,
          },
        },
      });

      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.reports)).toBe(true);
      expect(data.reports.length).toBeGreaterThan(0);

      // Try to retrieve the file via API
      const firstReport = data.reports[0];
      if (firstReport?.path) {
        const fileResponse = await request.get(`/api/files/${firstReport.path}`);
        expect(fileResponse.ok()).toBeTruthy();
        const fileContent = await fileResponse.text();
        expect(fileContent).toContain('Storage Test Report');
      }
    });
  });
});
