import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/** An archive import reads its archive whole, so it refuses one Node cannot read before the upload. */

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({ id: 1, role: 'administrator' }) }));

interface FakeEvent {
  headers: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name]);
vi.stubGlobal('apiError', apiError);

const { resolveMaxImportBytes, resolveMaxUploadBytes } = await import('../../server/utils/upload-limits');
const importRoute = (await import('../../server/api/test-runs/import.post')).default as unknown as (
  event: FakeEvent,
) => Promise<unknown>;

const GIB = 1024 * 1024 * 1024;

afterEach(() => {
  delete process.env.PIWI_IMPORT_MAX_BYTES;
});

describe('the size of an imported archive', () => {
  test('stays under 2 GiB whatever PIWI_IMPORT_MAX_BYTES allows', () => {
    process.env.PIWI_IMPORT_MAX_BYTES = String(4 * GIB);
    expect(resolveMaxUploadBytes()).toBe(4 * GIB);
    expect(resolveMaxImportBytes()).toBe(2 * GIB - 1);

    process.env.PIWI_IMPORT_MAX_BYTES = String(100 * 1024 * 1024);
    expect(resolveMaxImportBytes()).toBe(100 * 1024 * 1024);
  });

  test('is refused before the upload when the request declares more', async () => {
    process.env.PIWI_IMPORT_MAX_BYTES = String(4 * GIB);
    await expect(importRoute({ headers: { 'content-length': String(3 * GIB) } })).rejects.toMatchObject({
      statusCode: 413,
    });
  });
});
