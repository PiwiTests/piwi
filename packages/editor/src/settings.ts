/**
 * The editors' settings registry: each option once, with its VS Code key, its field in the JetBrains plugin's
 * settings, its group and place in it, its scope (`team`, one value for everyone working on the project; `project`, a
 * person's own that a project may set for itself; `user`, each person's own, whatever the project), its type and
 * default, and the labels of its choices, the editor's own word where the two differ. VS
 * Code's `contributes.configuration` is held to it by `apps/vscode/tests/settings.test.ts`; the JetBrains plugin's
 * `SettingsWords` restates its groups and labels, and `GlueTest` holds them to `settings.json`.
 */
import registry from './settings.json' with { type: 'json' };
import type { Editor } from './actions.js';

export type SettingScope = 'team' | 'project' | 'user';

export interface SettingChoice {
  value: string;
  label: string | Readonly<Record<Editor, string>>;
}

export interface EditorSetting {
  /** Its VS Code setting; null for an option only the JetBrains plugin has. */
  key: string | null;
  /** Its field in the JetBrains plugin's settings; null for an option only VS Code has. */
  jetbrains: string | null;
  group: string;
  scope: SettingScope;
  type: 'string' | 'boolean' | 'array';
  default: unknown;
  choices?: SettingChoice[];
}

export const SETTING_GROUPS: ReadonlyArray<{ id: string; title: string }> = registry.groups;

export const EDITOR_SETTINGS: readonly EditorSetting[] = registry.settings as EditorSetting[];

/** VS Code's scope of an option: a person's own whatever the project, `application`; else `window`. */
export function vscodeScope(setting: EditorSetting): 'application' | 'window' {
  return setting.scope === 'user' ? 'application' : 'window';
}

/** A choice's label in `editor`'s words. */
export function choiceLabel(choice: SettingChoice, editor: Editor): string {
  return typeof choice.label === 'string' ? choice.label : choice.label[editor];
}

const SETTINGS_DOCS_URL = 'https://piwitests.dev/reference/editor-settings';

/**
 * The address of a group's section on the docs' Editor settings page, which lists every option: its heading's anchor as
 * the docs site writes it (`Agents (MCP)`, `#agents-mcp`). The JetBrains plugin's `SettingsWords.docsUrl` gives the
 * same addresses.
 */
export function settingsDocsUrl(group: string): string {
  const title = SETTING_GROUPS.find((g) => g.id === group)?.title ?? group;
  const anchor = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${SETTINGS_DOCS_URL}#${anchor}`;
}
