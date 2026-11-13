/**
 * The editor a job of the desktop app's shell runs on, in a throwaway checkout of a linked folder: the live editor whose
 * workspace holds the folder, from the editors' discovery files, its run channel still its own.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { EditorDiscovery } from '@piwitests/core/editor-discovery';
import { writeDiscovery } from '@piwitests/editor/discovery';
import { stillServing } from '../../../../packages/reporter/src/internal/config/hub';
import { editorHubFor, editorStillServing } from '../../server/utils/desktop-editor-hub';

const TOKEN = 'Ab3_-Ab3_-Ab3_-Ab3_-Ab';

let base = '';
let workspace = '';
let other = '';
let socketDir = '';
let socketPath = '';
let server: net.Server;

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-hub-')));
  workspace = path.join(base, 'shop');
  other = path.join(base, 'blog');
  fs.mkdirSync(path.join(workspace, 'web'), { recursive: true });
  fs.mkdirSync(other);
  socketDir = fs.mkdtempSync(path.join(base, 'channel-'));
  fs.chmodSync(socketDir, 0o700);
  socketPath = path.join(socketDir, 'channel.sock');
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

/** An editors' folder holding the discovery file of `discovery`'s fields over a live editor's. */
function editors(discovery: Partial<EditorDiscovery> = {}): string {
  const dir = fs.mkdtempSync(path.join(base, 'editors-'));
  writeDiscovery(dir, {
    pid: process.pid,
    host: os.hostname(),
    version: '0.70.0',
    client: 'Visual Studio Code',
    startedAt: new Date().toISOString(),
    roots: [workspace],
    hub: null,
    runChannel: { path: socketPath, token: TOKEN },
    recorderBundle: null,
    unattended: true,
    checkout: true,
    ...discovery,
  });
  return dir;
}

describe('the editor a job of a linked folder runs on', () => {
  test('is the editor whose workspace holds the folder, by its run channel', () => {
    const dir = editors();
    expect(editorHubFor(workspace, true, dir)).toEqual({
      runChannel: `${socketPath}#${TOKEN}`,
      client: 'Visual Studio Code',
    });
    // A linked folder inside the workspace is held too.
    expect(editorHubFor(path.join(workspace, 'web'), true, dir)?.runChannel).toBe(`${socketPath}#${TOKEN}`);
  });

  test('is none with no editor, nor with an editor of another folder', () => {
    expect(editorHubFor(workspace, true, fs.mkdtempSync(path.join(base, 'editors-')))).toBeNull();
    expect(editorHubFor(workspace, true, editors({ roots: [other] }))).toBeNull();
    expect(editorHubFor(workspace, true, path.join(base, 'no-such-folder'))).toBeNull();
  });

  test('is none for a stale discovery file, whose editor is gone, which goes', () => {
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    const dir = editors({ pid: gone });
    expect(fs.readdirSync(dir)).toEqual([`${gone}.json`]);
    expect(editorHubFor(workspace, true, dir)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('is none for a discovery file written before this machine started, whose id another process may hold', () => {
    expect(editorHubFor(workspace, true, editors({ startedAt: '2001-01-01T00:00:00.000Z' }))).toBeNull();
  });

  test('is none whose run channel is no longer its own socket', () => {
    expect(
      editorHubFor(workspace, true, editors({ runChannel: { path: path.join(base, 'gone.sock'), token: TOKEN } })),
    ).toBeNull();
    expect(editorHubFor(workspace, true, editors({ runChannel: null }))).toBeNull();
  });

  test('takes a job nobody attends only to an editor that knows such runs', () => {
    expect(editorHubFor(workspace, false, editors())).not.toBeNull();
    const knowsNone = editors({ unattended: undefined });
    expect(editorHubFor(workspace, false, knowsNone)).toBeNull();
    expect(editorHubFor(workspace, true, knowsNone)).toEqual({
      runChannel: `${socketPath}#${TOKEN}`,
      client: 'Visual Studio Code',
    });
  });

  test('takes a job only to an editor that knows a throwaway checkout’s runs', () => {
    const knowsNone = editors({ checkout: undefined });
    expect(editorHubFor(workspace, true, knowsNone)).toBeNull();
    expect(editorHubFor(workspace, false, knowsNone)).toBeNull();
  });

  test('takes an editor as still serving as a run started in a terminal does', () => {
    const open = fs.mkdtempSync(path.join(base, 'open-'));
    fs.chmodSync(open, 0o755);
    const fresh: EditorDiscovery = {
      pid: process.pid,
      host: os.hostname(),
      version: '0.70.0',
      client: null,
      startedAt: new Date().toISOString(),
      roots: [workspace],
      hub: null,
      runChannel: { path: socketPath, token: TOKEN },
      recorderBundle: null,
    };
    const cases: [string, EditorDiscovery, boolean][] = [
      ['fresh', fresh, true],
      ['written before this machine started', { ...fresh, startedAt: '2001-01-01T00:00:00.000Z' }, false],
      ['with no time', { ...fresh, startedAt: '' }, true],
      ['its socket gone', { ...fresh, runChannel: { path: path.join(base, 'gone.sock'), token: TOKEN } }, false],
      [
        'its channel in a folder others enter',
        { ...fresh, runChannel: { path: path.join(open, 'c.sock'), token: TOKEN } },
        false,
      ],
    ];
    for (const [name, editor, serving] of cases) {
      if (process.platform !== 'win32') expect(editorStillServing(editor), name).toBe(serving);
      expect(editorStillServing(editor), name).toBe(stillServing(editor));
    }
  });

  test('takes an absolute folder alone', () => {
    expect(editorHubFor('shop', true, editors())).toBeNull();
  });
});
