/**
 * The editors' settings registry: each option once, with its VS Code key, its field in the JetBrains plugin's
 * settings, its group and place in it, its scope (`team`, one value for everyone working on the project; `user`, each
 * person's own), its type and default, and the labels of its choices, the editor's own word where the two differ. VS
 * Code's `contributes.configuration` is held to it by `apps/vscode/tests/settings.test.ts`; the JetBrains plugin's
 * `SettingsWords` restates its groups and labels, and `GlueTest` holds them to `settings.json`.
 */
import registry from './settings.json' with { type: 'json' };
import type { Editor } from './actions.js';

export type SettingScope = 'team' | 'user';

export interface SettingChoice {
  value: string;
  label: string | Readonly<Record<Editor, string>>;
}

export interface EditorSetting {
  key: string;
  /** Its field in the JetBrains plugin's settings; null for an option only VS Code has. */
  jetbrains: string | null;
  /** False for an option only the JetBrains plugin has. */
  vscode?: boolean;
  group: string;
  scope: SettingScope;
  type: 'string' | 'boolean' | 'array';
  default: unknown;
  choices?: SettingChoice[];
}

export const SETTING_GROUPS: ReadonlyArray<{ id: string; title: string }> = registry.groups;

export const EDITOR_SETTINGS: readonly EditorSetting[] = registry.settings as EditorSetting[];

/** A choice's label in `editor`'s words. */
export function choiceLabel(choice: SettingChoice, editor: Editor): string {
  return typeof choice.label === 'string' ? choice.label : choice.label[editor];
}
