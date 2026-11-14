import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { choiceLabel, EDITOR_SETTINGS, SETTING_GROUPS, vscodeScope } from '@piwitests/editor/settings';

interface ManifestSetting {
  type: string;
  default: unknown;
  order: number;
  scope: string;
  enum?: string[];
  enumItemLabels?: string[];
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: Array<{ title: string; order: number; properties: Record<string, ManifestSetting> }> };
};

describe('the settings', () => {
  const groups = manifest.contributes.configuration;

  test('are the registry’s groups, in its order', () => {
    expect(groups.map((g) => [g.title, g.order])).toEqual(SETTING_GROUPS.map((g, i) => [g.title, i]));
  });

  test('hold the registry’s options of VS Code, in its order, scope, type, default and choices', () => {
    for (const [i, group] of SETTING_GROUPS.entries()) {
      const registered = EDITOR_SETTINGS.filter((s) => s.group === group.id && s.key !== null);
      const shown = groups[i]!.properties;
      expect(Object.keys(shown), group.title).toEqual(registered.map((s) => s.key));
      for (const [order, setting] of registered.entries()) {
        const entry = shown[setting.key!]!;
        expect(
          [entry.order, entry.scope, entry.type, entry.default, entry.enum, entry.enumItemLabels],
          setting.key!,
        ).toEqual([
          order,
          vscodeScope(setting),
          setting.type,
          setting.default,
          setting.choices?.map((c) => c.value),
          setting.choices?.map((c) => choiceLabel(c, 'vscode')),
        ]);
      }
    }
  });
});
