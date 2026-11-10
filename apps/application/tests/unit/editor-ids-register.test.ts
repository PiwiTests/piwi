/**
 * The ids the editor clients freeze at 1.0 (D25 of `proposals/1.0-stabilization.md`): every command, setting and MCP
 * provider id the VS Code extension contributes, and every action id and notification group the JetBrains plugin
 * declares, which keybindings, keymaps and settings files name. The register lists each one, and nothing the
 * manifests do not hold.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const register = readFileSync(resolve(root, 'proposals/1.0-stabilization.md'), 'utf8');

/** The bullet of D25 that starts with `start`, up to the next bullet. */
function bullet(start: string): string {
  const from = register.indexOf(start);
  if (from < 0) throw new Error(`D25 has no bullet starting with ${start}`);
  const next = register.indexOf('\n- **', from + start.length);
  return register.slice(from, next < 0 ? undefined : next);
}

/** The code spans of `text` that match `pattern`, sorted, each once. */
function idsIn(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((id) => pattern.test(id)))].sort();
}

describe('the editor ids D25 freezes', () => {
  test("list every command, setting and MCP provider id of the VS Code extension's manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'apps/vscode/package.json'), 'utf8')) as {
      contributes: {
        commands: Array<{ command: string }>;
        configuration: { properties: Record<string, unknown> } | Array<{ properties: Record<string, unknown> }>;
        mcpServerDefinitionProviders: Array<{ id: string }>;
      };
    };
    const { commands, configuration, mcpServerDefinitionProviders } = manifest.contributes;
    const settings = [configuration].flat().flatMap((c) => Object.keys(c.properties));
    const contributed = [
      ...commands.map((c) => c.command),
      ...settings,
      ...mcpServerDefinitionProviders.map((p) => p.id),
    ];
    const registered = idsIn(bullet('- **The VS Code extension**'), /^piwi\.[A-Za-z][\w.]*$/);
    expect(registered).toEqual([...new Set(contributed)].sort());
  });

  test("list every action id of the JetBrains plugin's plugin.xml", () => {
    const pluginXml = readFileSync(resolve(root, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf8');
    const declared = [...pluginXml.matchAll(/<action id="([^"]+)"/g)].map((m) => m[1]!);
    const registered = idsIn(bullet('- **The JetBrains plugin**'), /^Piwi\.[A-Za-z]+$/);
    expect(registered).toEqual([...new Set(declared)].sort());
  });

  test("list every notification group of the JetBrains plugin's plugin.xml", () => {
    const pluginXml = readFileSync(resolve(root, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf8');
    const declared = [...pluginXml.matchAll(/<notificationGroup id="([^"]+)"/g)].map((m) => m[1]!);
    const registered = idsIn(bullet('- **The JetBrains plugin**'), /^Piwi( [a-z]+)?$/);
    expect(registered).toEqual([...new Set(declared)].sort());
  });
});
