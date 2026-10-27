import { hideSecretsInUrl } from '@piwitests/core/mask';

/**
 * A region's ARIA snapshot as **Assert a region** sends it to the editor, which writes it into the spec: without the
 * value of a field that holds a secret (a `- textbox` line whose value is one of `secrets`, the values of the region's
 * password fields and of those whose `autocomplete` asks for a secret), which is written without it and matches
 * whatever it holds, and without a link's `/url:` line whose URL holds a credential (`hideSecretsInUrl`: a query value
 * named or shaped like one, a URL password), which the link matches without; a line left with no child once its `/url:`
 * goes ends without the colon that opened its children, as Playwright writes a node without any. Pure.
 */
export function regionSnapshotWithoutSecrets(snapshot: string, secrets: readonly string[]): string {
  const hidden = new Set(secrets.filter(Boolean));
  const kept: Array<{ line: string; lostChild: boolean }> = [];
  for (const line of snapshot.split('\n')) {
    const box = /^(\s*- textbox(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): (.*)$/.exec(line);
    if (box && hidden.size && hidden.has(yamlScalar(box[2]!))) {
      kept.push({ line: box[1]!, lostChild: false });
      continue;
    }
    const url = /^\s*- \/url: (.*)$/.exec(line);
    if (url && hideSecretsInUrl(yamlScalar(url[1]!)) !== yamlScalar(url[1]!)) {
      let parent = kept.length - 1;
      while (parent >= 0 && indentOf(kept[parent]!.line) >= indentOf(line)) parent--;
      if (parent >= 0) kept[parent]!.lostChild = true;
      continue;
    }
    kept.push({ line, lostChild: false });
  }
  return kept
    .map(({ line, lostChild }, i) => {
      const next = kept[i + 1];
      const childless = !next || indentOf(next.line) <= indentOf(line);
      return lostChild && childless && line.endsWith(':') ? line.slice(0, -1) : line;
    })
    .join('\n');
}

/** How far a line is indented. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
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
