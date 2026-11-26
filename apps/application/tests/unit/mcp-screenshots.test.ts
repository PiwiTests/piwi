import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_AI_IMAGE_MAX_EDGE;

const stored = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    readFile: async (path: string) => {
      const data = stored.get(path);
      if (!data) throw new Error(`no file ${path}`);
      return data;
    },
  }),
}));

const { MCP_TOOLS, toContent } = await import('../../server/utils/mcp/tools');
const { fitImageForAgent, toolImagesOf, withToolImages } = await import('../../server/utils/mcp/images');

/** A PNG of random pixels: it compresses badly, as a busy page does. */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.floor(Math.random() * 256);
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** Decodes every pixel of `data`, so a cut image fails. */
async function decodesWhole(data: Buffer) {
  const { info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height };
}

describe('fitImageForAgent', () => {
  test('sends an image within both limits as stored', async () => {
    const png = await noisePng(200, 100);
    const fitted = await fitImageForAgent(png, 'image/png', { maxEdge: 1920, maxBytes: 512 * 1024 });
    expect(fitted).toMatchObject({ mimeType: 'image/png', width: 200, height: 100, reencoded: false });
    expect(fitted!.data).toBe(png);
  });

  test('downscales a tall full-page screenshot to a whole JPEG within both limits', async () => {
    const png = await noisePng(1280, 3017);
    expect(png.length).toBeGreaterThan(512 * 1024);
    const fitted = await fitImageForAgent(png, 'image/png', { maxEdge: 1920, maxBytes: 512 * 1024 });
    expect(fitted).toMatchObject({ mimeType: 'image/jpeg', reencoded: true, original: { width: 1280, height: 3017 } });
    expect(fitted!.data.length).toBeLessThanOrEqual(512 * 1024);
    expect(Math.max(fitted!.width!, fitted!.height!)).toBeLessThanOrEqual(1920);
    expect(await decodesWhole(fitted!.data)).toEqual({ width: fitted!.width, height: fitted!.height });
  });

  test('re-encodes an image within the edge but over the bytes at its own size', async () => {
    const png = await noisePng(400, 300);
    const maxBytes = Math.floor(png.length / 2);
    const fitted = await fitImageForAgent(png, 'image/png', { maxEdge: 1920, maxBytes });
    expect(fitted).toMatchObject({ mimeType: 'image/jpeg', width: 400, height: 300, reencoded: true });
    expect(fitted!.data.length).toBeLessThanOrEqual(maxBytes);
  });

  test('turns transparent pixels white in a JPEG', async () => {
    const clear = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const fitted = await fitImageForAgent(clear, 'image/png', { maxEdge: 20, maxBytes: 512 * 1024 });
    const { data } = await sharp(fitted!.data).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((v) => v > 245)).toBe(true);
  });

  test('sends bytes it cannot decode as stored only when they are small enough', async () => {
    const junk = Buffer.from('not an image');
    expect(await fitImageForAgent(junk, 'image/png', { maxEdge: 1920, maxBytes: 1024 })).toMatchObject({
      data: junk,
      width: null,
      original: null,
      reencoded: false,
    });
    expect(await fitImageForAgent(junk, 'image/png', { maxEdge: 1920, maxBytes: 4 })).toBeNull();
    expect(await fitImageForAgent(junk, 'image/bmp', { maxEdge: 1920, maxBytes: 1024 })).toBeNull();
  });
});

describe('toContent', () => {
  test('sends the JSON without image data, then each image after its caption', () => {
    const result = withToolImages({ items: [{ name: 'a.png' }, { name: 'b.png' }] }, [
      { caption: 'Screenshot a.png:', data: 'AAAA', mimeType: 'image/png' },
      { caption: 'Screenshot b.png:', data: 'BBBB', mimeType: 'image/jpeg' },
    ]);
    expect(toContent(result).content).toEqual([
      { type: 'text', text: '{"items":[{"name":"a.png"},{"name":"b.png"}]}' },
      { type: 'text', text: 'Screenshot a.png:' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'Screenshot b.png:' },
      { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
    ]);
  });

  test('sends a result without images as one text block', () => {
    expect(toContent({ items: [] }).content).toEqual([{ type: 'text', text: '{"items":[]}' }]);
    expect(toolImagesOf(null)).toEqual([]);
  });
});

describe('get_case_screenshots', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  const viewer: McpContext = {
    user: { id: 2, role: InstanceRole.MEMBER, name: 'Sam', username: 'sam' } as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
    scope: new Set([1]),
  };
  const handler = MCP_TOOLS.find((t) => t.name === 'get_case_screenshots')!.handler;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    stored.clear();
    await db.insert(schema.users).values({ id: 2, username: 'sam', password: '', role: InstanceRole.MEMBER });
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/home.spec.ts', title: 'fails' });
    await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 1, status: 'failed' });
  });

  afterEach(async () => {
    await close();
  });

  test('sends a full-page screenshot over the limits as a whole, smaller JPEG', async () => {
    const path = 'project-1/run-1/test-failed-1.png';
    stored.set(path, await noisePng(1280, 3017));
    await db
      .insert(schema.files)
      .values({ testRunId: 1, testRunsCaseId: 1, type: 'attachment', subtype: 'screenshot', label: 'image/png', path });

    const metadata = await handler(db as never, { executionId: 1 }, viewer);
    expect(toolImagesOf(metadata)).toEqual([]);

    const result = await handler(db as never, { executionId: 1, content: true }, viewer);
    const [item] = (result as { items: Array<Record<string, unknown>> }).items;
    expect(item).toMatchObject({
      name: 'test-failed-1.png',
      mediaType: 'image/png',
      dataLength: stored.get(path)!.length,
      atFailure: true,
      width: 1280,
      height: 3017,
      sentAs: { mediaType: 'image/jpeg' },
    });
    expect(item).not.toHaveProperty('data');

    const content = toContent(result).content;
    expect(content.map((c) => c.type)).toEqual(['text', 'text', 'image']);
    expect(content[1]).toMatchObject({
      text: expect.stringMatching(
        /^Screenshot test-failed-1\.png, the page the test failed on, downscaled from 1280×3017 to \d+×1920:$/,
      ),
    });
    const image = content[2] as { data: string; mimeType: string };
    expect(image.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    expect(bytes.length).toBe((item!.sentAs as { dataLength: number }).dataLength);
    expect((await decodesWhole(bytes)).height).toBe(1920);
  });
});
