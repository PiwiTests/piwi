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

/** Each `<action>` of plugin.xml, its text without the `Piwi: ` a menu of the platform's own needs. */
const jetbrainsActions = [
  ...fs
    .readFileSync(path.join(repo, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf8')
    .matchAll(/<action\b([^>]*)>/g),
].map(([, attributes]) => ({
  id: /\bid="([^"]+)"/.exec(attributes!)![1]!,
  text: decode(/\btext="([^"]*)"/.exec(attributes!)?.[1] ?? '').replace(/^Piwi: /, ''),
}));

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
    for (const a of EDITOR_ACTIONS) expect(a.vscode ?? a.jetbrains, a.title).toBeDefined();
    const titles = EDITOR_ACTIONS.map((a) => a.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  test('says the cursor and the window in each editor’s own word', () => {
    const runToCursor = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.runToCursor')!;
    expect(actionTitle(runToCursor, 'vscode')).toBe('Run to the cursor');
    expect(actionTitle(runToCursor, 'jetbrains')).toBe('Run to the caret');
    const shareWindow = EDITOR_ACTIONS.find((a) => a.vscode === 'piwi.shareWindowLive')!;
    expect(actionTitle(shareWindow, 'jetbrains')).toBe("Share this project's runs live until I stop");
  });
});
