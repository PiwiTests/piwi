import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { actionTitle, EDITOR_ACTIONS } from '../src/actions';

const repo = path.resolve(__dirname, '..', '..', '..');
const vscodeCommands = (
  JSON.parse(fs.readFileSync(path.join(repo, 'apps/vscode/package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  }
).contributes.commands;

const decode = (text: string) =>
  text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The actions a menu of the platform's own lists among others', their text led by `Piwi: `. */
const PREFIXED = ['Piwi.RecordHereGenerate'];

/** Each `<action>` of plugin.xml, its text without the `Piwi: ` of `PREFIXED`. */
const jetbrainsActions = [
  ...fs
    .readFileSync(path.join(repo, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf8')
    .matchAll(/<action\b((?:[^>"]|"[^"]*")*)>/g),
].map(([, attributes]) => {
  const id = /\bid="([^"]+)"/.exec(attributes!)![1]!;
  const text = decode(/\btext="([^"]*)"/.exec(attributes!)?.[1] ?? '');
  return { id, text: PREFIXED.includes(id) ? text.replace(/^Piwi: /, '') : text };
});

describe('the action catalog', () => {
  test('titles every VS Code command as package.json does', () => {
    const shown = vscodeCommands.map((c) => [c.command, c.title]);
    const catalog = EDITOR_ACTIONS.filter((a) => a.vscode).map((a) => [a.vscode, actionTitle(a, 'vscode')]);
    expect(catalog.sort()).toEqual(shown.sort());
  });

  test('titles every JetBrains action as plugin.xml does', () => {
    const shown = jetbrainsActions.map((a) => [a.id, a.text]);
    const catalog = EDITOR_ACTIONS.flatMap((a) => (a.jetbrains ?? []).map((id) => [id, actionTitle(a, 'jetbrains')]));
    expect(catalog.sort()).toEqual(shown.sort());
  });

  test('lists each action once, in at least one editor', () => {
    for (const a of EDITOR_ACTIONS)
      expect(a.vscode !== undefined || (a.jetbrains?.length ?? 0) > 0, a.title).toBe(true);
    const titles = EDITOR_ACTIONS.map((a) => a.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  test('leads with Piwi only the actions a menu of the platform’s own lists', () => {
    for (const id of PREFIXED) expect(jetbrainsActions.find((a) => a.id === id)!.text).not.toMatch(/^Piwi: /);
    expect(jetbrainsActions.filter((a) => a.text.startsWith('Piwi: '))).toEqual([]);
  });

  test('ends a title with an ellipsis only in the editor that asks, and names a JetBrains toggle by its state', () => {
    const copy = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.copyMcpConfiguration')!;
    expect(actionTitle(copy, 'vscode')).toBe('Copy the MCP server configuration…');
    expect(actionTitle(copy, 'jetbrains')).toBe('Copy the MCP server configuration');
    const coverage = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.toggleCoverage')!;
    expect(actionTitle(coverage, 'jetbrains')).toBe('Show coverage marks');
  });

  test('says the cursor and the window in each editor’s own word', () => {
    const runToCursor = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.runToCursor')!;
    expect(actionTitle(runToCursor, 'vscode')).toBe('Run to the cursor');
    expect(actionTitle(runToCursor, 'jetbrains')).toBe('Run to the caret');
    const shareWindow = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.shareWindowLive')!;
    expect(actionTitle(shareWindow, 'jetbrains')).toBe("Share this project's runs live until I stop");
  });
});
