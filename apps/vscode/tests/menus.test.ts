import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DOCUMENT_PATTERN } from '../src/glue';
import { STOP_ACTIONS } from '../src/run-control';

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

describe("a spec's editor title", () => {
  const spec = 'resourceFilename =~ /\\.(spec|test)\\.[cm]?[jt]sx?$/';
  const commands = manifest.contributes.commands as Array<{ command: string; icon?: string }>;

  test('shows one Piwi button by state: Stop recording, else Resume at a stop, else Record on a spec', () => {
    const buttons = menus['editor/title']!.filter((e) => e.group?.startsWith('navigation'));
    expect(buttons.map((e) => [e.command, e.when])).toEqual([
      ['piwi.stopRecording', 'piwi.recording'],
      ['piwi.resumeRun', '!piwi.recording && piwi.runStopped'],
      ['piwi.record', `${spec} && !piwi.recording && !piwi.runStopped`],
    ]);
  });

  test("keeps the other controls of a stop and of a recording in its '…' menu, as the palette offers each", () => {
    const overflow = menus['editor/title']!.filter((e) => !e.group?.startsWith('navigation'));
    expect(overflow.map((e) => e.command)).toEqual([
      'piwi.pauseRun',
      'piwi.stepRun',
      'piwi.runToCursor',
      'piwi.finishRun',
      'piwi.endTest',
      'piwi.showPausedPage',
      'piwi.codeAtStop',
      'piwi.stopRun',
      'piwi.pauseRecording',
      'piwi.resumeRecording',
    ]);
    const palette = menus['commandPalette']!;
    for (const entry of overflow) {
      expect(entry.when, entry.command).toBe(palette.find((p) => p.command === entry.command)!.when);
    }
  });

  test('runs the spec, the test at the cursor or verifies it ×3 from the Run button, the spec first', () => {
    expect(menus['editor/title/run']!.map((e) => [e.command, e.when])).toEqual([
      ['piwi.runSpec', spec],
      ['piwi.runTestAtCursor', spec],
      ['piwi.verifyTestAtCursor', spec],
    ]);
  });

  test('draws each button with a glyph of its own: no other command has it, but Record’s', () => {
    const shown = [
      ...menus['editor/title']!.filter((e) => e.group?.startsWith('navigation')),
      ...menus['editor/title/run']!,
    ].map((e) => e.command!);
    const iconOf = (command: string) => commands.find((c) => c.command === command)?.icon;
    for (const command of shown) {
      const icon = iconOf(command);
      expect(icon, command).toMatch(/^\$\([a-z-]+\)$/);
      const sharing = commands.filter((c) => c.icon === icon && c.command !== command).map((c) => c.command);
      // Record, Resume recording and Record here at a stop are one concept, with one glyph.
      expect(sharing, command).toEqual(command === 'piwi.record' ? ['piwi.resumeRecording', 'piwi.recordAtStop'] : []);
    }
  });
});

describe("the commands' glyphs", () => {
  const commands = manifest.contributes.commands as Array<{ command: string; icon?: string }>;
  /** The commands that wait for a glyph Piwi draws: no codicon says what they do. */
  const awaiting: Record<string, string> = {
    'piwi.refresh': 'Reload Piwi, a glyph of its own beside Refresh the latest run',
    'piwi.runToCursor': 'Run to the cursor: VS Code has no codicon for it',
    'piwi.pauseAndWatch': 'Pause and watch',
    'piwi.stopSharingRun': 'Share live, crossed out',
  };

  test('gives every command a codicon, but those that wait for a glyph Piwi draws', () => {
    const bare = commands.filter((c) => !c.icon).map((c) => c.command);
    expect(bare.sort()).toEqual(Object.keys(awaiting).sort());
    for (const c of commands.filter((c) => c.icon)) expect(c.icon, c.command).toMatch(/^\$\([a-z-]+\)$/);
  });

  test('draws Open in dashboard as leaving the editor, apart from the run pages’ globe', () => {
    const iconOf = (command: string) => commands.find((c) => c.command === command)?.icon;
    expect(iconOf('piwi.openInDashboard')).toBe('$(link-external)');
    expect(commands.filter((c) => c.icon === '$(link-external)').map((c) => c.command)).toEqual([
      'piwi.openInDashboard',
    ]);
  });

  test('draws each code action at a stop with its command’s glyph, in the palette and in the choice', () => {
    for (const a of STOP_ACTIONS) expect(commands.find((c) => c.command === a.command)?.icon, a.command).toBe(a.icon);
  });
});

describe('the commands that read the instance', () => {
  const reading = [
    'piwi.refreshRun',
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

  test('Re-run the failing tests is listed while the view lists failures, whatever the connection', () => {
    expect(menus['commandPalette']!.filter((e) => e.command === 'piwi.rerunFailing')).toEqual([
      { command: 'piwi.rerunFailing', when: 'piwi.failuresView == failures' },
    ]);
    expect(menus['view/title']!.find((e) => e.command === 'piwi.rerunFailing')?.when).toBe(
      'view == piwi.failures && piwi.failuresView == failures',
    );
  });

  test('show in the failures view’s title only while a context is connected', () => {
    const title = menus['view/title']!.filter((e) => e.when?.includes('view == piwi.failures'));
    for (const entry of title.filter((e) => reading.includes(e.command!))) {
      expect(entry.when, entry.command).toBe('view == piwi.failures && piwi.active');
    }
  });
});

describe('a held failure’s mark', () => {
  test('has a color of its own, in the failure red, and a red arrow beside the stop’s', () => {
    const colors = manifest.contributes.colors as Array<{ id: string; defaults: Record<string, string> }>;
    expect(colors.find((c) => c.id === 'piwi.failurePointBackground')?.defaults.dark).toBe('#f8514940');
    const arrow = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'failure-point.svg'), 'utf-8');
    expect(arrow).toContain('fill="#f85149"');
  });
});

describe('the failures view’s title', () => {
  test('keeps the run’s actions as icons, and Follow, Connect, Settings and the log in its … menu', () => {
    const title = menus['view/title']!.filter((e) => e.when?.startsWith('view == piwi.failures'));
    expect(title.filter((e) => e.group?.startsWith('navigation')).map((e) => e.command)).toEqual([
      'piwi.refreshRun',
      'piwi.rerunFailing',
      'piwi.openRun',
      'piwi.compareWith',
      'piwi.groupFailuresBy',
    ]);
    expect(title.filter((e) => !e.group?.startsWith('navigation')).map((e) => e.command)).toEqual([
      'piwi.toggleFollowEditor',
      'piwi.stopFollowingEditor',
      'piwi.connect',
      'piwi.openSettings',
      'piwi.openLog',
    ]);
  });
});
