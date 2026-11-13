/**
 * Why Connect could not reach an instance, in the words both editor clients say it: one sentence per kind of failure,
 * `{name}` standing for a value the client fills in. The VS Code extension reads this table; the JetBrains plugin's
 * `Glue.CONNECT_FAILURE_WORDS` restates it, and `GlueTest` holds it to `connect-failures.json`.
 */
import words from './connect-failures.json' with { type: 'json' };

export type ConnectFailureKind = keyof typeof words;

export const CONNECT_FAILURE_WORDS: Readonly<Record<ConnectFailureKind, string>> = words;

/** The sentence of `kind`, each `{name}` replaced by its value in `values`. */
export function connectFailureWords(
  kind: ConnectFailureKind,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return CONNECT_FAILURE_WORDS[kind].replace(/\{(\w+)\}/g, (all, name: string) =>
    name in values ? String(values[name]) : all,
  );
}
