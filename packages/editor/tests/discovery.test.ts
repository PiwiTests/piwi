/**
 * The service's discovery file: written readable by its user alone, read back by the editors' clients with the files
 * of services gone skipped and deleted, and removed by the bundled service on every way out it can hear.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { formatEditorDiscovery, parseEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import { editorsDir, readLiveEditorsIn, readLiveHubs, removeDiscovery, writeDiscovery } from '../src/discovery';
import { waitFor } from './run-fixtures';

const UNIX = process.platform !== 'win32';
const folders: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-discovery-'));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const discovery = (pid: number): EditorDiscovery => ({
  pid,
  version: '0.60.0',
  client: 'Visual Studio Code',
  startedAt: '2026-10-25T10:00:00.000Z',
  roots: ['/work/shop'],
  hub: { url: 'ws://127.0.0.1:43123/piwi/hub', token: 'h'.repeat(32) },
  runChannel: { path: '/tmp/piwi-record-x/channel.sock', token: 'c'.repeat(32) },
  recorderBundle: null,
});

/** A process id no process has: one that ran and ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

describe('the discovery file', () => {
  test('is in ~/.piwi/editors, or the folder PIWI_EDITORS_DIR names', () => {
    expect(editorsDir({})).toBe(path.join(os.homedir(), '.piwi', 'editors'));
    expect(editorsDir({ PIWI_EDITORS_DIR: '/x/editors' })).toBe('/x/editors');
  });

  test('is written readable by this user alone, in a folder only this user reads, and removed', () => {
    const dir = path.join(tempDir(), '.piwi', 'editors');
    const file = writeDiscovery(dir, discovery(process.pid));
    expect(file).toBe(path.join(dir, `${process.pid}.json`));
    expect(parseEditorDiscovery(fs.readFileSync(file!, 'utf8'))).toEqual(discovery(process.pid));
    // No temporary file is left beside it.
    expect(fs.readdirSync(dir)).toEqual([`${process.pid}.json`]);
    if (UNIX) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    }
    removeDiscovery(file!);
    expect(fs.existsSync(file!)).toBe(false);
    removeDiscovery(file!);
  });

  test.runIf(UNIX)('tightens a folder others could read, and writes nothing through a link', () => {
    const base = tempDir();
    const open = path.join(base, 'open');
    fs.mkdirSync(open, { mode: 0o755 });
    fs.chmodSync(open, 0o755);
    expect(writeDiscovery(open, discovery(process.pid))).not.toBeNull();
    expect(fs.statSync(open).mode & 0o777).toBe(0o700);
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    const link = path.join(base, 'link');
    fs.symlinkSync(target, link);
    expect(writeDiscovery(link, discovery(process.pid))).toBeNull();
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test('is skipped, and deleted, once its process is gone; the live services are listed for Piwi Picker', async () => {
    const dir = tempDir();
    const dead = await deadPid();
    fs.writeFileSync(path.join(dir, `${dead}.json`), formatEditorDiscovery(discovery(dead)));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    writeDiscovery(dir, discovery(process.pid));
    // Writing a file deletes those of services gone first.
    expect(fs.existsSync(path.join(dir, `${dead}.json`))).toBe(false);
    fs.writeFileSync(path.join(dir, `${dead}.json`), formatEditorDiscovery(discovery(dead)));
    expect(readLiveEditorsIn(dir).map((d) => d.pid)).toEqual([process.pid]);
    expect(fs.existsSync(path.join(dir, `${dead}.json`))).toBe(false);
    expect(readLiveHubs(dir)).toEqual([
      {
        url: 'ws://127.0.0.1:43123/piwi/hub',
        token: 'h'.repeat(32),
        pid: process.pid,
        version: '0.60.0',
        client: 'Visual Studio Code',
        roots: ['/work/shop'],
        startedAt: '2026-10-25T10:00:00.000Z',
      },
    ]);
    expect(readLiveHubs(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('the bundled service', () => {
  const bundle = path.join(__dirname, '..', 'dist', 'piwi-language-server.cjs');

  /** Starts the bundle on a workspace with its discovery files in a folder of its own; the file it wrote. */
  async function start(): Promise<{ child: ReturnType<typeof spawn>; editors: string; file: string }> {
    const workspace = tempDir();
    const editors = path.join(workspace, 'editors');
    const child = spawn(process.execPath, [bundle, '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PIWI_EDITORS_DIR: editors, PIWI_DESKTOP_CONFIG: '/nonexistent' },
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    connection.listen();
    await connection.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: 'Bundle Test' },
      workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: 'shop' }],
    });
    await connection.sendNotification('initialized', {});
    const name = await waitFor(() => (fs.existsSync(editors) ? fs.readdirSync(editors)[0] : undefined));
    const file = path.join(editors, name);
    const written = parseEditorDiscovery(fs.readFileSync(file, 'utf8'));
    expect(written).toMatchObject({ pid: child.pid, client: 'Bundle Test', roots: [workspace] });
    expect(written?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(written?.recorderBundle).toBe(path.join(path.dirname(bundle), 'record-ide.js'));
    return { child, editors, file };
  }

  const exited = (child: ReturnType<typeof spawn>) => new Promise((resolve) => child.on('exit', resolve));

  test.runIf(UNIX)('removes its file when it is told to stop, or its client goes', async (ctx) => {
    if (!fs.existsSync(bundle)) return ctx.skip();
    for (const end of ['SIGTERM', 'SIGINT', 'stdin'] as const) {
      const { child, file } = await start();
      const gone = exited(child);
      if (end === 'stdin') child.stdin!.end();
      else child.kill(end);
      await gone;
      expect(fs.existsSync(file), end).toBe(false);
    }
  });

  test.runIf(UNIX)('leaves the file of a killed service for readers to skip and delete', async (ctx) => {
    if (!fs.existsSync(bundle)) return ctx.skip();
    const { child, editors, file } = await start();
    const gone = exited(child);
    child.kill('SIGKILL');
    await gone;
    expect(fs.existsSync(file)).toBe(true);
    expect(readLiveEditorsIn(editors)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});
