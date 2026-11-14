/**
 * The words both editor clients write themselves, beside those the service sends: a stop's controls and code actions
 * (each action's short label for a narrow place), a recording's states, controls and its edited block's message, a
 * worker's and a CI lane's name, and Hold failures: its choices, short and whole, and a run's state. `{name}` stands
 * for a value the client fills in: `{cursor}` is `cursor` in VS Code and `caret` in a JetBrains IDE. The VS Code
 * extension reads this table; the JetBrains plugin's `EditorWords.WORDS` restates it, and `GlueTest` holds it to
 * `words.json`.
 */
import words from './words.json' with { type: 'json' };

export type EditorWordKey = keyof typeof words;

export const CLIENT_WORDS: Readonly<Record<EditorWordKey, string>> = words;

/** `template` with each `{name}` replaced by its value in `values`; a name without a value stays as it is. */
export function fillWords(template: string, values: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all));
}

/** The words of `key`, each `{name}` replaced by its value in `values`. */
export function editorWords(key: EditorWordKey, values: Readonly<Record<string, string | number>> = {}): string {
  return fillWords(CLIENT_WORDS[key], values);
}
