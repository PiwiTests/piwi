import { describe, expect, test } from 'vitest';
import {
  EDITORS_DIR_ENV,
  EDITORS_DIR_PARTS,
  editorDiscoveryName,
  editorForRun,
  formatEditorDiscovery,
  parseEditorDiscovery,
  pidOfDiscoveryName,
  readLiveEditors,
  type EditorDiscovery,
} from '../src/editor-discovery';

const HOST = 'dev-laptop';

const discovery: EditorDiscovery = {
  pid: 4242,
  host: HOST,
  version: '0.60.0',
  client: 'Visual Studio Code',
  startedAt: '2026-10-25T10:00:00.000Z',
  roots: ['/work/shop'],
  hub: { url: 'ws://127.0.0.1:43123/piwi/hub', token: 'h'.repeat(32) },
  runChannel: { path: '/tmp/piwi-record-x/channel.sock', token: 'c'.repeat(32) },
  recorderBundle: '/ext/dist/record-ide.js',
};

/** A folder in memory: its files, which processes run, the files another user owns, and what was read and removed. */
function folder(files: Record<string, string>, alive: number[], others: string[] = []) {
  const removed: string[] = [];
  const opened: string[] = [];
  return {
    removed,
    opened,
    host: HOST,
    names: () => Object.keys(files),
    owned: (name: string) => !others.includes(name),
    read: (name: string) => {
      opened.push(name);
      return files[name] ?? null;
    },
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
    expect(parseEditorDiscovery(text({ host: undefined }))).toMatchObject({ host: '' });
  });

  test('list the live services oldest first, deleting the files of processes that are gone', () => {
    const newer = { ...discovery, pid: 7, startedAt: '2026-10-25T11:00:00.000Z' };
    const files = folder(
      {
        '4242.json': formatEditorDiscovery(discovery),
        '7.json': formatEditorDiscovery({ ...newer, host: HOST.toUpperCase() }),
        '99.json': formatEditorDiscovery({ ...discovery, pid: 99 }),
        '8.json': '{ half',
        '9.json': formatEditorDiscovery({ ...discovery, pid: 10 }),
        '.11.json.tmp': formatEditorDiscovery({ ...discovery, pid: 11 }),
        'notes.txt': 'x',
      },
      [4242, 7, 8, 9, 11],
    );
    expect(readLiveEditors(files)).toEqual([discovery, { ...newer, host: HOST.toUpperCase() }]);
    // A dead process's file goes; an unreadable file, or one naming another process, of a live one stays.
    expect(files.removed).toEqual(['99.json']);
  });

  test('delete only a service’s file of this machine, and never read another user’s', () => {
    const files = folder(
      {
        // A folder PIWI_EDITORS_DIR names may hold a person's own numbered files: no process runs with their number.
        '2024.json': '{"my":"report"}',
        '31.json': formatEditorDiscovery({ ...discovery, pid: 32 }),
        '12.json': '{ half',
        // Another machine sharing the home folder: its process is not this machine's to look for.
        '13.json': formatEditorDiscovery({ ...discovery, pid: 13, host: 'build-agent' }),
        '14.json': formatEditorDiscovery({ ...discovery, pid: 14, host: 'build-agent' }),
        '15.json': formatEditorDiscovery({ ...discovery, pid: 15, host: undefined as unknown as string }),
        // Another user's file: neither read nor deleted.
        '16.json': formatEditorDiscovery({ ...discovery, pid: 16 }),
        '17.json': formatEditorDiscovery({ ...discovery, pid: 17 }),
      },
      [14, 17],
      ['16.json', '17.json'],
    );
    expect(readLiveEditors(files)).toEqual([]);
    expect(files.removed).toEqual([]);
    expect(files.opened).not.toContain('16.json');
    expect(files.opened).not.toContain('17.json');
  });

  describe('the service a run started in a terminal attaches to', () => {
    /** Each folder as its real path: `/link` leads to `/work`, `/gone` is no folder any more. */
    const real = (folder: string): string | null =>
      folder.startsWith('/gone') ? null : folder.replace(/^\/link(?=\/|$)/, '/work');
    const at = (pid: number, roots: string[], startedAt = discovery.startedAt): EditorDiscovery => ({
      ...discovery,
      pid,
      roots,
      startedAt,
    });

    test('is the one whose workspace holds the run’s config folder or its working directory', () => {
      const shop = at(1, ['/work/shop']);
      const blog = at(2, ['/work/blog']);
      expect(editorForRun([blog, shop], ['/work/shop/e2e', '/work/shop'], real, false)).toBe(shop);
      // The working directory alone, when the config is elsewhere.
      expect(editorForRun([blog, shop], ['/elsewhere', '/work/blog'], real, false)).toBe(blog);
      // A folder whose name only starts like the workspace's is not in it.
      expect(editorForRun([shop], ['/work/shopfront'], real, false)).toBeNull();
      expect(editorForRun([blog, shop], ['/work/other'], real, false)).toBeNull();
    });

    test('compares real paths, case-insensitively on Windows', () => {
      const linked = at(1, ['/link/shop']);
      expect(editorForRun([linked], ['/work/shop/tests'], real, false)).toBe(linked);
      expect(editorForRun([at(2, ['/gone/shop'])], ['/gone/shop'], real, false)).toBeNull();
      const windows = at(3, ['C:\\Work\\Shop\\']);
      expect(editorForRun([windows], ['c:\\work\\shop\\e2e'], (f) => f, true)).toBe(windows);
      expect(editorForRun([windows], ['c:\\work\\shop\\e2e'], (f) => f, false)).toBeNull();
    });

    test('takes the most specific workspace, then the service that started last', () => {
      const monorepo = at(1, ['/work']);
      const app = at(2, ['/work/shop']);
      expect(editorForRun([monorepo, app], ['/work/shop'], real, false)).toBe(app);
      const older = at(3, ['/work/shop'], '2026-10-25T09:00:00.000Z');
      const newer = at(4, ['/work/shop'], '2026-10-25T12:00:00.000Z');
      expect(editorForRun([newer, older], ['/work/shop'], real, false)).toBe(newer);
      expect(editorForRun([older, newer], ['/work/shop'], real, false)).toBe(newer);
    });

    test('needs a service that names a run channel', () => {
      expect(editorForRun([{ ...at(1, ['/work/shop']), runChannel: null }], ['/work/shop'], real, false)).toBeNull();
    });
  });
});
