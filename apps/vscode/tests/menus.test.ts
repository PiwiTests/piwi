import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DOCUMENT_PATTERN } from '../src/glue';
import { RUN_COMMANDS, STOP_ACTIONS } from '../src/run-control';

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

describe("the explorer's context menu", () => {
  test('holds one Piwi submenu, as the JetBrains project view’s: run a spec or what reaches a file, record a new one', () => {
    expect(manifest.contributes.submenus).toContainEqual({ id: 'piwi.explorerContext', label: 'Piwi' });
    expect(menus['explorer/context']!.filter((e) => (e.command ?? e.submenu)?.startsWith('piwi.'))).toEqual([
      expect.objectContaining({ submenu: 'piwi.explorerContext' }),
    ]);
    expect(menus['explorer/context']![0]!.when).toBe('piwi.active && resourceScheme =~ /^(file|vscode-remote)$/');
    expect(menus['piwi.explorerContext']!.map((e) => [e.group!.split('@')[0], e.command])).toEqual([
      ['1_run', 'piwi.runSpec'],
      ['1_run', 'piwi.runTestsForFile'],
      ['2_record', 'piwi.recordFile'],
    ]);
  });

  test('runs a spec or what reaches a file on a file alone, as the editor’s submenu offers them', () => {
    const whenOf = (menu: string, command: string) => menus[menu]!.find((e) => e.command === command)!.when!;
    for (const command of ['piwi.runSpec', 'piwi.runTestsForFile']) {
      const when = whenOf('piwi.explorerContext', command);
      expect(when.startsWith('!explorerResourceIsFolder && ')).toBe(true);
      expect(whenOf('piwi.editorContext', command)).toContain(when.replace('!explorerResourceIsFolder && ', ''));
    }
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

  test('draws each button with a glyph of its own: no other command has it, but Record’s and Verify ×3’s', () => {
    const shown = [
      ...menus['editor/title']!.filter((e) => e.group?.startsWith('navigation')),
      ...menus['editor/title/run']!,
    ].map((e) => e.command!);
    const iconOf = (command: string) => commands.find((c) => c.command === command)?.icon;
    for (const command of shown) {
      const icon = iconOf(command);
      expect(icon, command).toMatch(/^\$\([a-z-]+\)$/);
      const sharing = commands.filter((c) => c.icon === icon && c.command !== command).map((c) => c.command);
      // Record, Resume recording and Record at the stop are one concept, with one glyph, as are the Verify ×3s.
      const concept: Record<string, string[]> = {
        'piwi.record': ['piwi.resumeRecording', 'piwi.recordAtStop'],
        'piwi.verifyTestAtCursor': ['piwi.verifyFailure'],
      };
      expect(sharing, command).toEqual(concept[command] ?? []);
    }
  });
});

describe("the commands' glyphs", () => {
  const commands = manifest.contributes.commands as Array<{ command: string; icon?: string }>;
  test('gives every command a codicon or a glyph of Piwi’s own', () => {
    expect(commands.filter((c) => !c.icon).map((c) => c.command)).toEqual([]);
    for (const c of commands.filter((c) => c.icon)) expect(c.icon, c.command).toMatch(/^\$\([a-z-]+\)$/);
    // A glyph of Piwi's own is one the extension contributes.
    const own = Object.keys(manifest.contributes.icons);
    for (const c of commands.filter((c) => c.icon?.startsWith('$(piwi'))) {
      expect(own, c.command).toContain(c.icon!.slice(2, -1));
    }
  });

  test('draws Piwi’s own glyphs from the icon font the brand asset generator writes', () => {
    // VS Code drops every icon an extension contributes when one id is not of two segments (`component-name`).
    const icons = manifest.contributes.icons as Record<
      string,
      { default: { fontPath: string; fontCharacter: string } }
    >;
    expect(Object.keys(icons)).toEqual([
      'piwi-mark',
      'piwi-flaky',
      'piwi-pause-watch',
      'piwi-stop-live',
      'piwi-reload',
      'piwi-run-to-cursor',
    ]);
    for (const id of Object.keys(icons)) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    for (const icon of Object.values(icons)) {
      expect(fs.existsSync(path.resolve(__dirname, '..', icon.default.fontPath)), icon.default.fontPath).toBe(true);
    }
    expect(icons['piwi-mark']!.default.fontCharacter).toBe('\\E000');
  });

  test('draws Open in dashboard as leaving the editor, apart from the run pages’ globe', () => {
    const iconOf = (command: string) => commands.find((c) => c.command === command)?.icon;
    expect(iconOf('piwi.openInDashboard')).toBe('$(link-external)');
    expect(commands.filter((c) => c.icon === '$(link-external)').map((c) => c.command)).toEqual([
      'piwi.openInDashboard',
    ]);
  });

  test('gives a glyph one meaning: the commands that share one are one concept', () => {
    const concepts = [
      ['piwi.record', 'piwi.resumeRecording', 'piwi.recordAtStop'],
      ['piwi.copyMcpConfiguration', 'piwi.copyRunsMcpConfiguration', 'piwi.copyAgentContext', 'piwi.copyText'],
      ['piwi.runTests', 'piwi.runTest'],
      ['piwi.openRun', 'piwi.openRunPage', 'piwi.openLiveRun'],
      ['piwi.reproduceInDesktop', 'piwi.desktopJob'],
      ['piwi.openTrace', 'piwi.openTraceSoFar'],
      ['piwi.shareRunLive', 'piwi.shareWindowLive', 'piwi.liveMenu'],
      ['piwi.stopSharingRun', 'piwi.stopSharingWindowLive'],
      ['piwi.verifyTestAtCursor', 'piwi.verifyFailure'],
      ['piwi.showFlakyTests', 'piwi.lookIntoFlake'],
      // Follow the active editor and Watch a worker's test, still to settle.
      ['piwi.stopFollowingEditor', 'piwi.watchWorker'],
    ];
    const byIcon = new Map<string, string[]>();
    for (const c of commands.filter((c) => c.icon)) byIcon.set(c.icon!, [...(byIcon.get(c.icon!) ?? []), c.command]);
    const shared = [...byIcon.values()].filter((group) => group.length > 1).map((group) => group.sort());
    expect(shared.sort()).toEqual(concepts.map((group) => [...group].sort()).sort());
  });

  test('draws each code action at a stop with its command’s glyph, in the palette and in the choice', () => {
    for (const a of STOP_ACTIONS) expect(commands.find((c) => c.command === a.command)?.icon, a.command).toBe(a.icon);
  });
});

describe("a test's actions", () => {
  const spec = 'resourceFilename =~ /\\.(spec|test)\\.[cm]?[jt]sx?$/';

  test('open from a test of the Testing view, its gutter and its messages, and the line numbers with the view off', () => {
    const only = (menu: string) => menus[menu]!.filter((e) => e.command === 'piwi.testActions');
    const item = only('testing/item/gutter')[0]!.when!;
    expect(only('testing/item/context')[0]!.when).toBe(item);
    expect(only('testing/message/context')[0]!.when).toBe('controllerId == piwi');
    expect(only('editor/lineNumber/context')[0]!.when).toBe(`piwi.active && !config.piwi.testExplorer && ${spec}`);
    // A test's item, never a config's, a folder's, a spec's or a describe block's (`testTree` in src/glue.ts).
    const pattern = /testId =~ \/(.+)\/$/.exec(item)![1]!;
    const matches = (id: string) => new RegExp(pattern).test(id);
    expect(item.startsWith('controllerId == piwi && ')).toBe(true);
    expect(matches('file:///w/a.spec.ts\x1fcheckout\x1fpays')).toBe(true);
    expect(matches('file:///w/a.spec.ts\x1fpays\x1f2')).toBe(true);
    for (const id of [
      'config\x1f/w',
      'folder\x1f/w\x1ftests',
      'file:///w/a.spec.ts',
      'file:///w/a.spec.ts\x1echeckout\x1fcart',
    ]) {
      expect(matches(id), id).toBe(false);
    }
  });
});

describe('Debug this failure', () => {
  test('is offered on a failure the service built a debug run for, never in the palette', () => {
    const entry = menus['view/item/context']!.find((e) => e.command === 'piwi.debugFailure')!;
    const offered = (contextValue: string) =>
      new RegExp(/viewItem =~ \/(.+)\/$/.exec(entry.when!)![1]!).test(contextValue);
    expect(entry.when!.startsWith('view == piwi.failures && ')).toBe(true);
    expect(offered('piwi.failure.failing.trace.agent.debug')).toBe(true);
    expect(offered('piwi.failure.failing.trace.agent')).toBe(false);
    expect(offered('piwi.failure.fixed-locally')).toBe(false);
    expect(menus.commandPalette!.find((e) => e.command === 'piwi.debugFailure')!.when).toBe('false');
  });
});

describe('Open the trace so far', () => {
  test('is offered while the worker panel is the active editor and its slot can open its trace, with its glyph', () => {
    const commands = manifest.contributes.commands as Array<{ command: string; title: string; icon?: string }>;
    expect(commands.find((c) => c.command === RUN_COMMANDS.openTrace)).toMatchObject({
      title: 'Open the trace so far',
      icon: commands.find((c) => c.command === 'piwi.openTrace')!.icon,
    });
    const palette = menus['commandPalette']!.find((e) => e.command === RUN_COMMANDS.openTrace);
    expect(palette?.when).toBe("activeWebviewPanelId == 'piwi.workerView' && piwi.runCanOpenTrace");
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
  test('has a color of its own, apart from the stop’s', () => {
    const colors = manifest.contributes.colors as Array<{ id: string; defaults: Record<string, string> }>;
    const failure = colors.find((c) => c.id === 'piwi.failurePointBackground')?.defaults;
    expect(failure).toBeDefined();
    expect(failure).not.toEqual(colors.find((c) => c.id === 'piwi.executionPointBackground')?.defaults);
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
