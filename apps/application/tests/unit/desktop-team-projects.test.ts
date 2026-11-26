/**
 * Compare with team instance, on the desktop app's server: the projects of the connected team instance a folder can
 * be linked to, as the instance lists them and kept to what reads as a project, and each project of this app with a
 * folder on this machine with the team project that folder is linked to.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ folders: [] as { id: number; path: string }[] }));
vi.mock('../../server/utils/desktop-links', () => ({ desktopLinkedFolders: () => state.folders }));

const { resetDesktopRunTarget, runTargetConnection, useKeptKey } = await import('@piwitests/editor/run-target');
const { desktopTeamProjects } = await import('../../server/utils/desktop-team-projects');

const KEY = `pd_${'a'.repeat(64)}`;

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let checkout: number;
let admin: number;
let folders: string[];
let server: http.Server;
let instanceUrl: string;
/** What the fake instance answers the project list with, or the status it refuses it with. */
let answer: unknown;
let refusal: number | null;

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  checkout = (await db.insert(schema.projects).values({ name: 'checkout' }).returning())[0]!.id;
  admin = (await db.insert(schema.projects).values({ name: 'admin', label: 'Back office' }).returning())[0]!.id;
  folders = [0, 1].map(() => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-team-projects-'))));
  state.folders = [
    { id: checkout, path: folders[0]! },
    { id: admin, path: folders[1]! },
    { id: 999, path: '/nowhere' },
  ];
  answer = {
    projects: [{ id: 7, name: 'Checkout' }, { id: 0, name: 'zero' }, { id: 8 }, { id: 9, name: 'Admin' }, 'nonsense'],
  };
  refusal = null;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://instance');
    if (url.pathname === '/api/run-targets/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', requests: [], stops: [] })}\n\n`);
      return;
    }
    if (url.pathname === '/api/run-targets/projects' && refusal) {
      res.writeHead(refusal, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: 'This app’s key cannot compare',
          data: { errorCode: 'RUN_TARGET_KEY_CANNOT_COMPARE' },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/run-targets/projects') res.end(JSON.stringify(answer));
    else if (url.pathname === '/api/run-targets/self') res.end(JSON.stringify({ compares: true }));
    else res.end(JSON.stringify({ requests: [], stops: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  instanceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  void useKeptKey(instanceUrl, KEY, new Map([[7, folders[0]!]]));
  await until(() => runTargetConnection().compares === true);
});

afterEach(async () => {
  resetDesktopRunTarget();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

describe('the team projects a folder can be linked to', () => {
  test('lists the instance’s projects, and each project of this app with a folder and its team project', async () => {
    expect(await desktopTeamProjects(db as never)).toEqual({
      status: 'ok',
      instance: instanceUrl,
      teamProjects: [
        { id: 7, name: 'Checkout' },
        { id: 9, name: 'Admin' },
      ],
      folders: [
        { projectId: admin, projectName: 'Back office', folder: folders[1], teamProjectId: null },
        { projectId: checkout, projectName: 'checkout', folder: folders[0], teamProjectId: 7 },
      ],
    });
  });

  test('says why the instance does not list them, and still lists the folders', async () => {
    refusal = 403;
    const result = await desktopTeamProjects(db as never);
    expect(result).toMatchObject({ status: 'unavailable', problem: 'reconnect' });
    expect(result.folders).toHaveLength(2);
    resetDesktopRunTarget();
    expect(await desktopTeamProjects(db as never)).toMatchObject({ status: 'unavailable', problem: 'not-connected' });
  });
});
