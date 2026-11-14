/**
 * The words both editor clients write themselves, beside those the service sends: a stop's controls and code actions
 * (each action's short label for a narrow place), a recording's states and controls, a worker's and a CI lane's name,
 * and the choices of Hold failures. `{name}` stands for a value the client fills in: `{cursor}` is `cursor` in VS Code
 * and `caret` in a JetBrains IDE. The VS Code extension reads this table; the JetBrains plugin's `EditorWords.WORDS`
 * restates it, and `GlueTest` holds it to `words.json`.
 */
import words from './words.json' with { type: 'json' };

export type EditorWordKey = keyof typeof words;

export const EDITOR_WORDS: Readonly<Record<EditorWordKey, string>> = words;

/** The words of `key`, each `{name}` replaced by its value in `values`. */
export function editorWords(key: EditorWordKey, values: Readonly<Record<string, string | number>> = {}): string {
  return EDITOR_WORDS[key].replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}
