import { beforeEach, describe, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { accountPictureVersion } from '../../shared/user-avatar';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({
  db: null as unknown,
  files: new Map<string, Buffer>(),
  caller: null as null | { id: number },
  authEnabled: true,
  apiKey: false,
}));

vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    writeFile: async (path: string, data: Buffer) => void state.files.set(path, Buffer.from(data)),
    readFile: async (path: string) => {
      const data = state.files.get(path);
      if (!data) throw new Error(`no file at ${path}`);
      return data;
    },
    exists: async (path: string) => state.files.has(path),
    deleteFile: async (path: string) => void state.files.delete(path),
    deleteDirectory: async (path: string) => {
      for (const key of [...state.files.keys()]) if (key.startsWith(`${path}/`)) state.files.delete(key);
    },
  }),
}));
vi.mock('../../server/utils/auth', () => {
  const caller = async () => {
    const [user] = await (state.db as Db).select().from(schema.users).where(eq(schema.users.id, state.caller!.id));
    return user;
  };
  return {
    requireAuth: caller,
    requireSessionAuth: async () => {
      if (state.apiKey) throw Object.assign(new Error('session required'), { statusCode: 403 });
      return caller();
    },
    isAuthEnabled: () => state.authEnabled,
  };
});
vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  getRequestWebStream: (event: FakeEvent) => event.stream,
}));

interface FakeEvent {
  query?: Record<string, string>;
  params?: Record<string, string>;
  stream?: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query ?? {});
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('setResponseHeaders', (event: FakeEvent, headers: Record<string, string>) => {
  event.headers = { ...event.headers, ...headers };
});
vi.stubGlobal('apiError', apiError);

const { normalizeProfilePicture, removeProfilePicture, saveProfilePicture } =
  await import('../../server/utils/profile-picture');
type Handler = (event: FakeEvent) => Promise<unknown>;
const uploadRoute = (await import('../../server/api/auth/avatar.put')).default as unknown as Handler;
const removeRoute = (await import('../../server/api/auth/avatar.delete')).default as unknown as Handler;
const avatarRoute = (await import('../../server/api/auth/avatar.get')).default as unknown as Handler;
const adminRemoveRoute = (await import('../../server/api/users/[id]/avatar.delete')).default as unknown as Handler;
const deleteUserRoute = (await import('../../server/api/users/[id].delete')).default as unknown as Handler;

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const GITHUB = 'https://avatars.githubusercontent.com/u/583231?v=4';

function image(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif' = 'png', red = 120) {
  return sharp({ create: { width, height, channels: 3, background: { r: red, g: 40, b: 200 } } })
    .toFormat(format)
    .toBuffer();
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function avatarKeyOf(userId: number) {
  const [row] = await db
    .select({ avatarKey: schema.users.avatarKey })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.avatarKey ?? null;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.files.clear();
  state.caller = { id: 1 };
  state.authEnabled = true;
  state.apiKey = false;
  await db.insert(schema.users).values([
    { id: 1, username: 'alice', password: 'x', role: 'administrator', avatarUrl: GITHUB },
    { id: 2, username: 'bob', password: 'x', role: 'member' },
  ]);
});

describe('normalizeProfilePicture', () => {
  test.each(['png', 'jpeg', 'webp'] as const)('stores a %s picture as a 256 × 256 WebP', async (format) => {
    const stored = await normalizeProfilePicture(await image(640, 480, format));
    expect(await sharp(stored).metadata()).toMatchObject({ format: 'webp', width: 256, height: 256 });
  });

  test("drops the photo's metadata, its location included", async () => {
    const tagged = await sharp(await image(64, 64, 'jpeg'))
      .withExif({ IFD0: { Copyright: 'Somebody' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 0/1' } })
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const stored = await normalizeProfilePicture(tagged);
    const metadata = await sharp(stored).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  test('refuses an SVG, a GIF and bytes that are no image', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>x()</script></svg>',
    );
    for (const input of [svg, await image(10, 10, 'gif'), Buffer.from('not an image')]) {
      await expect(normalizeProfilePicture(input)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  test('refuses a picture wider or taller than 1000 pixels, however few bytes it weighs', async () => {
    await expect(normalizeProfilePicture(await image(1001, 10))).rejects.toMatchObject({ statusCode: 400 });
    await expect(normalizeProfilePicture(await image(10, 1001))).rejects.toMatchObject({ statusCode: 400 });
    await expect(normalizeProfilePicture(await image(8000, 8000))).rejects.toMatchObject({ statusCode: 400 });
    await expect(normalizeProfilePicture(await image(1000, 1000))).resolves.toBeInstanceOf(Buffer);
  });

  test('refuses an empty upload and one of 1 MB or more', async () => {
    await expect(normalizeProfilePicture(Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 400 });
    await expect(normalizeProfilePicture(Buffer.alloc(1_000_000))).rejects.toMatchObject({ statusCode: 413 });
  });
});

describe('saveProfilePicture and removeProfilePicture', () => {
  test('a new picture replaces the stored one, file and row', async () => {
    const first = await saveProfilePicture(db, 2, await image(100, 100));
    expect(first).toMatch(/^avatars\/2\/[0-9a-f]{64}-[0-9a-f]{16}\.webp$/);
    expect([...state.files.keys()]).toEqual([first]);

    const second = await saveProfilePicture(db, 2, await image(300, 200, 'jpeg', 10));
    expect(second).not.toBe(first);
    expect(await avatarKeyOf(2)).toBe(second);
    expect([...state.files.keys()]).toEqual([second]);
  });

  test('the same picture again gets a new key, so a key never names two uploads', async () => {
    const bytes = await image(100, 100);
    const first = await saveProfilePicture(db, 2, bytes);
    const second = await saveProfilePicture(db, 2, bytes);
    expect(second).not.toBe(first);
    expect(await avatarKeyOf(2)).toBe(second);
    expect([...state.files.keys()]).toEqual([second]);
  });

  test('removing deletes the row and the file, and says whether there was one', async () => {
    await saveProfilePicture(db, 2, await image(100, 100));
    expect(await removeProfilePicture(db, 2)).toBe(true);
    expect(await avatarKeyOf(2)).toBeNull();
    expect(state.files.size).toBe(0);
    expect(await removeProfilePicture(db, 2)).toBe(false);
  });

  test('an unknown user is a 404 and stores nothing', async () => {
    await expect(saveProfilePicture(db, 99, await image(10, 10))).rejects.toMatchObject({ statusCode: 404 });
    await expect(removeProfilePicture(db, 99)).rejects.toMatchObject({ statusCode: 404 });
    expect(state.files.size).toBe(0);
  });
});

describe('the profile picture routes', () => {
  test("an upload answers the version GET /api/auth/me then names, and the picture is served in the provider's place", async () => {
    const answer = (await uploadRoute({ stream: streamOf(await image(120, 120)) })) as { avatarVersion: string };
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, 1));
    expect(answer.avatarVersion).toBe(accountPictureVersion(user!));
    expect(answer.avatarVersion).not.toBe(accountPictureVersion({ avatarKey: null, avatarUrl: GITHUB }));

    const event: FakeEvent = { query: { v: answer.avatarVersion } };
    const served = (await avatarRoute(event)) as Buffer;
    expect((await sharp(served).metadata()).format).toBe('webp');
    expect(event.headers).toMatchObject({
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  test('a picture asked for under another version is served but never cached', async () => {
    await uploadRoute({ stream: streamOf(await image(120, 120)) });
    const event: FakeEvent = { query: { v: 'stale' } };
    await avatarRoute(event);
    expect(event.headers?.['Cache-Control']).toBe('no-store');
  });

  test('an upload of 1 MB or more is refused while it is read', async () => {
    await expect(uploadRoute({ stream: streamOf(new Uint8Array(1_000_000)) })).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(await avatarKeyOf(1)).toBeNull();
  });

  test('an upload is refused with authentication off and for an API key', async () => {
    state.authEnabled = false;
    await expect(uploadRoute({ stream: streamOf(await image(10, 10)) })).rejects.toMatchObject({ statusCode: 400 });
    state.authEnabled = true;
    state.apiKey = true;
    await expect(uploadRoute({ stream: streamOf(await image(10, 10)) })).rejects.toMatchObject({ statusCode: 403 });
    expect(state.files.size).toBe(0);
  });

  test('removing your picture deletes it, and a user with no picture gets a 404', async () => {
    state.caller = { id: 2 };
    await uploadRoute({ stream: streamOf(await image(50, 50)) });
    expect(await removeRoute({})).toEqual({ removed: true });
    expect(state.files.size).toBe(0);
    await expect(avatarRoute({})).rejects.toMatchObject({ statusCode: 404 });
  });

  test("an administrator removes another user's picture", async () => {
    await saveProfilePicture(db, 2, await image(50, 50));
    expect(await adminRemoveRoute({ params: { id: '2' } })).toEqual({ removed: true });
    expect(await avatarKeyOf(2)).toBeNull();
    expect(state.files.size).toBe(0);
  });

  test('deleting a user deletes every picture they stored, and no one else’s', async () => {
    await saveProfilePicture(db, 2, await image(50, 50));
    state.files.set('avatars/2/left-behind.webp', Buffer.from('x'));
    const kept = await saveProfilePicture(db, 1, await image(50, 50));
    await deleteUserRoute({ params: { id: '2' } });
    expect([...state.files.keys()]).toEqual([kept]);
  });
});
