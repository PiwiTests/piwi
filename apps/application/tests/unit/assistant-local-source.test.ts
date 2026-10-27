/**
 * `read_local_source` as the assistant offers it: on the desktop app only,
 * never with the desktop tools that write, and held to the folder linked to a
 * project the user reads.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;

vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const tools = await import('../../server/utils/assistant/tools');
const { ASSISTANT_LOCAL_SOURCE_TOOL } = await import('../../server/utils/assistant/local-source');
type McpContext = import('../../server/utils/mcp/tools').McpContext;

const DESKTOP_TOKEN = 'pd_desktop_token';

const administrator: McpContext = { user: null, access: ADMIN_ACCESS, scope: 'all' };
const member: McpContext = {
  user: { id: 2, role: InstanceRole.MEMBER, name: 'Robin', username: 'robin' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
  scope: new Set([1]),
};

let db: TempDb;
let close: () => Promise<void>;
let home: string;
let repo: string;
let outside: string;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  home = mkdtempSync(join(tmpdir(), 'piwi-home-'));
  repo = join(home, 'shop');
  outside = join(home, 'secrets');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, 'tests', 'cart.spec.ts'), "test('adds an item', async () => {});\n");
  writeFileSync(join(outside, 'key.txt'), 'secret\n');
  mkdirSync(join(home, '.piwi'));
  writeFileSync(
    join(home, '.piwi', 'desktop.json'),
    JSON.stringify({
      url: 'http://127.0.0.1:3000',
      token: DESKTOP_TOKEN,
      projects: [
        { id: 1, path: repo },
        { id: 2, path: outside },
      ],
    }),
  );
  vi.stubEnv('HOME', home);
  vi.stubEnv('PIWI_DESKTOP_TOKEN', DESKTOP_TOKEN);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.PIWI_DESKTOP_TOKEN;
  rmSync(home, { recursive: true, force: true });
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const read = (ctx: McpContext, params: Record<string, unknown>) =>
  ASSISTANT_LOCAL_SOURCE_TOOL.handler(db as never, params, ctx) as Promise<{ path: string; text: string }>;

describe('read_local_source in the assistant', () => {
  test('is offered on the desktop app only, with the core set, and never the desktop tools that write', async () => {
    const onDesktop = await tools.assistantReadTools(db as never, administrator);
    const names = onDesktop.map((t) => t.name);
    expect(names).toContain('read_local_source');
    expect(names).not.toContain('apply_locator_fix');
    expect(names).not.toContain('import_local_report');
    const toolbox = tools.createAssistantToolbox({
      db: db as never,
      ctx: administrator,
      readTools: onDesktop,
      page: null,
      extraTools: [],
    });
    const offered = toolbox.definitions().find((d) => d.name === 'read_local_source');
    expect(offered?.inputSchema).toMatchObject({ required: ['projectId', 'path'] });

    vi.stubEnv('PIWI_DESKTOP_TOKEN', '');
    expect((await tools.assistantReadTools(db as never, administrator)).map((t) => t.name)).not.toContain(
      'read_local_source',
    );
    expect(
      (await tools.assistantReadTools(db as never, administrator, { desktop: false })).map((t) => t.name),
    ).not.toContain('read_local_source');
  });

  test("reads a file in the project's linked folder, by its path there or an absolute path inside it", async () => {
    const relative = await read(member, { projectId: 1, path: 'tests/cart.spec.ts' });
    expect(relative.text).toContain('adds an item');
    const absolute = await read(member, { projectId: 1, path: join(repo, 'tests', 'cart.spec.ts'), line: 1 });
    expect(absolute).toMatchObject({ startLine: 1, endLine: 2 });
  });

  test.skipIf(process.platform === 'win32')(
    'refuses a path that leaves the folder, through .. or a symbolic link',
    async () => {
      symlinkSync(join(outside, 'key.txt'), join(repo, 'tests', 'key.txt'));
      await expect(read(member, { projectId: 1, path: '../secrets/key.txt' })).rejects.toThrow(
        /outside the folder linked/,
      );
      await expect(read(member, { projectId: 1, path: join(outside, 'key.txt') })).rejects.toThrow(
        /outside the folder linked/,
      );
      await expect(read(member, { projectId: 1, path: 'tests/key.txt' })).rejects.toThrow(/outside the folder linked/);
      await expect(read(member, { projectId: 1, path: '.' })).rejects.toThrow(/outside the folder linked/);
      await expect(read(member, { projectId: 1, path: 'tests/missing.ts' })).rejects.toThrow(/file not found/);
    },
  );

  test('refuses a project the user does not read, or one with no folder linked', async () => {
    await expect(read(member, { projectId: 2, path: 'key.txt' })).rejects.toThrow('No access to project 2');
    await expect(read(administrator, { projectId: 3, path: 'x.ts' })).rejects.toThrow(/no folder linked/);
    await expect(read(administrator, { projectId: 'x', path: 'x.ts' })).rejects.toThrow(/projectId/);
    // The discovery file of another server holds no folder for this one.
    vi.stubEnv('PIWI_DESKTOP_TOKEN', 'pd_another_server');
    await expect(read(administrator, { projectId: 1, path: 'tests/cart.spec.ts' })).rejects.toThrow(/no folder linked/);
  });
});
