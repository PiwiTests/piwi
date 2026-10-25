import { describe, expect, test } from 'vitest';
import {
  EDITORS_DIR_ENV,
  EDITORS_DIR_PARTS,
  editorDiscoveryName,
  formatEditorDiscovery,
  parseEditorDiscovery,
  pidOfDiscoveryName,
  readLiveEditors,
  type EditorDiscovery,
} from '../src/editor-discovery';

const discovery: EditorDiscovery = {
  pid: 4242,
  version: '0.60.0',
  client: 'Visual Studio Code',
  startedAt: '2026-10-25T10:00:00.000Z',
  roots: ['/work/shop'],
  hub: { url: 'ws://127.0.0.1:43123/piwi/hub', token: 'h'.repeat(32) },
  runChannel: { path: '/tmp/piwi-record-x/channel.sock', token: 'c'.repeat(32) },
  recorderBundle: '/ext/dist/record-ide.js',
};

/** A folder in memory: its files, which processes run, and what was removed. */
function folder(files: Record<string, string>, alive: number[]) {
  const removed: string[] = [];
  return {
    removed,
    names: () => Object.keys(files),
    read: (name: string) => files[name] ?? null,
    alive: (pid: number) => alive.includes(pid),
    remove: (name: string) => {
      removed.push(name);
      delete files[name];
    },
  };
}

describe('the editors’ discovery files', () => {
  test('live in ~/.piwi/editors unless PIWI_EDITORS_DIR names another folder', () => {
    expect(EDITORS_DIR_PARTS).toEqual(['.piwi', 'editors']);
    expect(EDITORS_DIR_ENV).toBe('PIWI_EDITORS_DIR');
  });

  test('are named after the service’s process', () => {
    expect(editorDiscoveryName(4242)).toBe('4242.json');
    expect(pidOfDiscoveryName('4242.json')).toBe(4242);
    for (const name of ['.4242.json.1a2b.tmp', '0.json', 'desktop.json', '4242.json.bak', '-1.json']) {
      expect(pidOfDiscoveryName(name), name).toBeNull();
    }
  });

  test('read back what was written, and a field they cannot read as null or empty', () => {
    expect(parseEditorDiscovery(formatEditorDiscovery(discovery))).toEqual(discovery);
    const text = (patch: object) => JSON.stringify({ ...discovery, ...patch });
    expect(
      parseEditorDiscovery(text({ hub: { url: 'ws://evil.test:80/piwi/hub', token: 'h'.repeat(32) } })),
    ).toMatchObject({ hub: null });
    expect(parseEditorDiscovery(text({ hub: { ...discovery.hub, token: 'short' } }))).toMatchObject({ hub: null });
    expect(parseEditorDiscovery(text({ runChannel: { path: '', token: 'c'.repeat(32) } }))).toMatchObject({
      runChannel: null,
    });
    expect(parseEditorDiscovery(text({ roots: ['/a', 3, ''], client: 7, extra: true }))).toMatchObject({
      roots: ['/a'],
      client: null,
    });
    for (const broken of ['{', '[]', text({ pid: 0 }), text({ pid: '4242' }), 'null']) {
      expect(parseEditorDiscovery(broken), broken).toBeNull();
    }
  });

  test('list the live services oldest first, deleting the files of processes that are gone', () => {
    const newer = { ...discovery, pid: 7, startedAt: '2026-10-25T11:00:00.000Z' };
    const files = folder(
      {
        '4242.json': formatEditorDiscovery(discovery),
        '7.json': formatEditorDiscovery(newer),
        '99.json': formatEditorDiscovery({ ...discovery, pid: 99 }),
        '8.json': '{ half',
        '9.json': formatEditorDiscovery({ ...discovery, pid: 10 }),
        '.11.json.tmp': formatEditorDiscovery({ ...discovery, pid: 11 }),
        'notes.txt': 'x',
      },
      [4242, 7, 8, 9, 11],
    );
    expect(readLiveEditors(files)).toEqual([discovery, newer]);
    // A dead process's file goes; an unreadable file, or one naming another process, of a live one stays.
    expect(files.removed).toEqual(['99.json']);
  });
});
