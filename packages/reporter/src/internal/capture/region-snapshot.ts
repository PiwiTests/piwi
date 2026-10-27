import { hideSecretsInText } from '@piwitests/core/mask';

/**
 * A region's ARIA snapshot as **Assert a region** sends it to the editor, which writes it into the spec: without the
 * value of a password field (a `- textbox` line whose value is one of `passwords`, the values of the region's
 * `input[type=password]`), which is written without it and matches whatever it holds, and without a link's `/url:`
 * line whose URL holds a credential (`hideSecretsInText`: a query value named or shaped like one, a URL password),
 * which the link matches without. Pure.
 */
export function regionSnapshotWithoutSecrets(snapshot: string, passwords: readonly string[]): string {
  const hidden = new Set(passwords.filter(Boolean));
  return snapshot
    .split('\n')
    .flatMap((line) => {
      const box = /^(\s*- textbox(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): (.*)$/.exec(line);
      if (box && hidden.size && hidden.has(yamlScalar(box[2]!))) return [box[1]!];
      const url = /^\s*- \/url: (.*)$/.exec(line);
      if (url && hideSecretsInText(yamlScalar(url[1]!)) !== yamlScalar(url[1]!)) return [];
      return [line];
    })
    .join('\n');
}

/** A YAML scalar as an ARIA snapshot writes it: plain, double-quoted (JSON's escapes) or single-quoted. */
function yamlScalar(text: string): string {
  const value = text.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
