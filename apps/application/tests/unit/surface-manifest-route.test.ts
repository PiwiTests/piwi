import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiError } from '../../server/utils/api-error';
import { MAX_DECLARED_PATTERN_LENGTH, MAX_SEGMENT_PARAMETERS } from '#shared/graph';

/** Uploading a declared-surface manifest refuses a pattern past the limits with 400, and stores nothing. */

const stored = vi.hoisted(() => ({ manifests: [] as unknown[] }));

vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/project-access', () => ({
  requireRouteId: () => 1,
  requireProjectAccess: async () => ({ id: 1 }),
}));
vi.mock('../../server/utils/graph-ingest', () => ({ resolveRunBranchTag: async () => null }));
vi.mock('../../server/utils/surface-manifest', () => ({
  ingestProjectManifest: async (_db: unknown, _projectId: number, manifest: unknown) => {
    stored.manifests.push(manifest);
    return true;
  },
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const upload = (await import('../../server/api/projects/[id]/surface/manifest.put')).default as unknown as (
  event: unknown,
) => Promise<{ success: boolean }>;

const request = (manifest: object) => ({ body: { source: 'committed', manifest } });
const params = (count: number) => Array.from({ length: count }, (_, i) => `{p${i}}`).join('.');

describe('PUT /api/projects/:id/surface/manifest', () => {
  beforeEach(() => {
    stored.manifests.length = 0;
  });

  test('stores a manifest within the limits', async () => {
    const manifest = {
      routes: [{ method: 'GET', pattern: `/files/${params(MAX_SEGMENT_PARAMETERS)}` }],
      pages: [{ pattern: `/${'a'.repeat(MAX_DECLARED_PATTERN_LENGTH - 1)}` }],
    };
    await expect(upload(request(manifest))).resolves.toMatchObject({ success: true });
    expect(stored.manifests).toEqual([manifest]);
  });

  test('refuses a segment holding too many parameters, naming the limit', async () => {
    const manifest = { routes: [{ method: 'GET', pattern: `/files/${params(MAX_SEGMENT_PARAMETERS + 1)}` }] };
    await expect(upload(request(manifest))).rejects.toMatchObject({
      statusCode: 400,
      message: `A segment of a declared pattern holds at most ${MAX_SEGMENT_PARAMETERS} parameters: routes[0].pattern`,
    });
    expect(stored.manifests).toEqual([]);
  });

  test('refuses a pattern holding too many characters, naming the limit', async () => {
    const manifest = { pages: [{ pattern: '/a' }, { pattern: `/${'a'.repeat(MAX_DECLARED_PATTERN_LENGTH)}` }] };
    await expect(upload(request(manifest))).rejects.toMatchObject({
      statusCode: 400,
      message: `A declared pattern holds at most ${MAX_DECLARED_PATTERN_LENGTH} characters: pages[1].pattern`,
    });
    expect(stored.manifests).toEqual([]);
  });
});
