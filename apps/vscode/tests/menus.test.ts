import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DOCUMENT_PATTERN } from '../src/glue';

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));
const menus = manifest.contributes.menus as Record<
  string,
  Array<{ command?: string; submenu?: string; group?: string; when?: string }>
>;

describe("the editor's context menu", () => {
  test('holds one Piwi submenu, in the JetBrains plugin’s order: run, record, a recording’s controls', () => {
    expect(manifest.contributes.submenus).toContainEqual({ id: 'piwi.editorContext', label: 'Piwi' });
    expect(menus['editor/context']!.filter((e) => (e.command ?? e.submenu)?.startsWith('piwi.'))).toEqual([
      expect.objectContaining({ submenu: 'piwi.editorContext' }),
    ]);
    const entries = menus['piwi.editorContext']!.map((e) => [e.group!.split('@')[0], e.command]);
    expect(entries).toEqual([
      ['1_run', 'piwi.runTestAtCursor'],
      ['1_run', 'piwi.verifyTestAtCursor'],
      ['1_run', 'piwi.runSpec'],
      ['1_run', 'piwi.runTestsForFile'],
      ['2_record', 'piwi.record'],
      ['2_record', 'piwi.recordFile'],
      ['3_recording', 'piwi.stopRecording'],
      ['3_recording', 'piwi.pauseRecording'],
      ['3_recording', 'piwi.resumeRecording'],
    ]);
  });

  test('offers the tests that reach a file only on the files the service reads, local or in a remote window', () => {
    const served = /\{([^}]+)\}/.exec(DOCUMENT_PATTERN)![1]!.split(',').sort();
    const when = menus['piwi.editorContext']!.find((e) => e.command === 'piwi.runTestsForFile')!.when!;
    const offered = /resourceExtname =~ \/\^\\\.\(([^)]+)\)\$\//.exec(when)![1]!.split('|').sort();
    expect(offered).toEqual(served);
    expect(when).toContain('piwi.active');
    // A remote window's renderer, where when clauses are read, names its files with the vscode-remote scheme.
    expect(when).toContain('resourceScheme =~ /^(file|vscode-remote)$/');
    const submenu = menus['editor/context']!.find((e) => e.submenu === 'piwi.editorContext')!.when!;
    expect(submenu).toContain('resourceScheme =~ /^(file|vscode-remote)$/');
  });
});

describe('the commands that read the instance', () => {
  const reading = [
    'piwi.refreshRun',
    'piwi.rerunFailing',
    'piwi.openRun',
    'piwi.openInDashboard',
    'piwi.compareWith',
    'piwi.groupFailuresBy',
    'piwi.runSelection',
    'piwi.runTestsForFile',
  ];

  test('are listed in the palette only while a context is connected', () => {
    for (const command of reading) {
      const entries = menus['commandPalette']!.filter((e) => e.command === command);
      expect(entries, command).toEqual([{ command, when: 'piwi.active' }]);
    }
  });

  test('show in the failures view’s title only while a context is connected', () => {
    const title = menus['view/title']!.filter((e) => e.when?.includes('view == piwi.failures'));
    for (const entry of title.filter((e) => reading.includes(e.command!))) {
      expect(entry.when, entry.command).toBe('view == piwi.failures && piwi.active');
    }
  });
});
