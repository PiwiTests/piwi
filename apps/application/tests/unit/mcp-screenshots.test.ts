import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { MCP_SCREENSHOT_MAX_BYTES, MCP_SCREENSHOT_MAX_EDGE } from '#shared/mcp-tools';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

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
const { MAX_DECODED_PIXELS, fitImageForAgent, toolImagesOf, withToolImages } =
  await import('../../server/utils/mcp/images');
const { createAssistantToolbox } = await import('../../server/utils/assistant/tools');

const limits = { maxEdge: MCP_SCREENSHOT_MAX_EDGE, maxBytes: MCP_SCREENSHOT_MAX_BYTES };

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
    const fitted = await fitImageForAgent(png, limits);
    expect(fitted).toMatchObject({ mimeType: 'image/png', width: 200, height: 100, reencoded: false });
    expect('data' in fitted && fitted.data).toBe(png);
  });

  test('names the media type from the bytes', async () => {
    const jpeg = await sharp(await noisePng(60, 40))
      .jpeg()
      .toBuffer();
    expect(await fitImageForAgent(jpeg, limits)).toMatchObject({ mimeType: 'image/jpeg', reencoded: false });
  });

  test('downscales a tall full-page screenshot to a whole JPEG within both limits', async () => {
    const png = await noisePng(1280, 3017);
    expect(png.length).toBeGreaterThan(MCP_SCREENSHOT_MAX_BYTES);
    const fitted = await fitImageForAgent(png, limits);
    if ('notSent' in fitted) throw new Error(fitted.notSent);
    expect(fitted).toMatchObject({ mimeType: 'image/jpeg', reencoded: true, original: { width: 1280, height: 3017 } });
    expect(fitted.data.length).toBeLessThanOrEqual(MCP_SCREENSHOT_MAX_BYTES);
    expect(Math.max(fitted.width!, fitted.height!)).toBeLessThanOrEqual(MCP_SCREENSHOT_MAX_EDGE);
    expect(await decodesWhole(fitted.data)).toEqual({ width: fitted.width, height: fitted.height });
  });

  test('re-encodes an image within the edge but over the bytes at its own size', async () => {
    const png = await noisePng(400, 300);
    const maxBytes = Math.floor(png.length / 2);
    const fitted = await fitImageForAgent(png, { maxEdge: 1920, maxBytes });
    expect(fitted).toMatchObject({ mimeType: 'image/jpeg', width: 400, height: 300, reencoded: true });
    expect('data' in fitted && fitted.data.length).toBeLessThanOrEqual(maxBytes);
  });

  test('turns transparent pixels white in a JPEG', async () => {
    const clear = await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const fitted = await fitImageForAgent(clear, { maxEdge: 20, maxBytes: 512 * 1024 });
    if ('notSent' in fitted) throw new Error(fitted.notSent);
    const { data } = await sharp(fitted.data).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((v) => v > 245)).toBe(true);
  });

  test('sends no file that is not a PNG, JPEG, GIF or WebP image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    for (const bytes of [svg, Buffer.alloc(0), Buffer.from('not an image')]) {
      expect(await fitImageForAgent(bytes, limits)).toEqual({
        notSent: 'The stored file is not a PNG, JPEG, GIF or WebP image.',
      });
    }
  });

  test('sends no PNG cut short, even one small enough to send as stored', async () => {
    const png = await noisePng(200, 100);
    expect(await fitImageForAgent(png.subarray(0, Math.floor(png.length / 2)), limits)).toEqual({
      notSent: 'The stored file could not be decoded as an image.',
    });
  });

  test('decodes no image over the pixel limit', async () => {
    const huge = await sharp({ create: { width: 10_000, height: 6_000, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    expect(10_000 * 6_000).toBeGreaterThan(MAX_DECODED_PIXELS);
    expect(await fitImageForAgent(huge, limits)).toEqual({
      notSent: 'The image is too large to decode (over 50,000,000 pixels).',
    });
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
  const tool = MCP_TOOLS.find((t) => t.name === 'get_case_screenshots')!;
  const path = 'project-1/run-1/test-failed-1.png';

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    stored.clear();
    await db.insert(schema.users).values({ id: 2, username: 'sam', password: '', role: InstanceRole.MEMBER });
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/home.spec.ts', title: 'fails' });
    await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 1, status: 'failed' });
    stored.set(path, await noisePng(1280, 3017));
    await db
      .insert(schema.files)
      .values({ testRunId: 1, testRunsCaseId: 1, type: 'attachment', subtype: 'screenshot', label: 'image/png', path });
  });

  afterEach(async () => {
    await close();
  });

  test('sends a full-page screenshot over the limits as a whole, smaller JPEG', async () => {
    const metadata = await tool.handler(db as never, { executionId: 1 }, viewer);
    expect(toolImagesOf(metadata)).toEqual([]);

    const result = await tool.handler(db as never, { executionId: 1, content: true }, viewer);
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
        /^Screenshot test-failed-1\.png, the page the test failed on, downscaled from 1280×3017 to \d+×\d+:$/,
      ),
    });
    const image = content[2] as { data: string; mimeType: string };
    expect(image.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(image.data, 'base64');
    const sentAs = item!.sentAs as { width: number; height: number; dataLength: number };
    expect(bytes.length).toBe(sentAs.dataLength);
    expect(await decodesWhole(bytes)).toEqual({ width: sentAs.width, height: sentAs.height });
  });

  test('sends the in-app assistant no image, and says so', async () => {
    const toolbox = createAssistantToolbox({
      db: db as never,
      ctx: viewer,
      readTools: [tool],
      page: '/test-run-cases/[id]',
      extraTools: [],
    });
    const result = await toolbox.run({
      id: 'c',
      name: 'get_case_screenshots',
      arguments: { executionId: 1, content: true },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      items: [
        expect.objectContaining({
          name: 'test-failed-1.png',
          notSent: 'Images are not sent to a caller that reads tool results as text only.',
        }),
      ],
    });
  });
});
