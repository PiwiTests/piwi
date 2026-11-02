/**
 * Reading the text of a `git diff` (a local clone's, or the raw diff a host
 * serves) into one section per file, each with the hunks a provider's
 * `ChangedFile.patch` holds: from the first `@@` line, without the
 * `diff --git` / `index` / `---` / `+++` header lines.
 */

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A path as git prints it: a C-quoted string (`"b/q\"t.ts"`, `"b/\303\251.ts"`)
 * when it holds a quote, a backslash, a control character or, without
 * `core.quotePath=false`, a non-ASCII byte; the path itself otherwise.
 */
export function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const encoder = new TextEncoder();
  const chars = [...text.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join('');
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const next = chars[++i] ?? '';
    const escaped = C_ESCAPES[next];
    if (escaped !== undefined) bytes.push(escaped);
    else bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path of a `--- a/…` or `+++ b/…` line, or null for `/dev/null`. */
function headerLinePath(line: string): string | null {
  // git ends the line with a tab when the path holds a space.
  const raw = line.slice(4).replace(/\t$/, '');
  if (raw === '/dev/null') return null;
  return unquoteGitPath(raw).replace(/^[ab]\//, '');
}

export interface DiffSection {
  /** The file's path on the new side (the old side for a removed file); null when the section has no `---`/`+++` lines. */
  path: string | null;
  /** The hunks, from the first `@@` line; undefined for a binary, mode-only or pure-rename change. */
  hunks: string | undefined;
}

/**
 * Each file's section of a `git diff --patch`, in diff order. With `cut`, the
 * text was cut short, so its last section is left out.
 */
export function splitGitDiff(raw: string, cut = false): DiffSection[] {
  const sections: Array<{ oldPath: string | null; newPath: string | null; hunks: string[] }> = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      sections.push({ oldPath: null, newPath: null, hunks: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (!current) continue;
    if (current.hunks.length > 0 || line.startsWith('@@')) {
      current.hunks.push(line);
    } else if (line.startsWith('--- ')) {
      current.oldPath = headerLinePath(line);
    } else if (line.startsWith('+++ ')) {
      current.newPath = headerLinePath(line);
    }
  }
  if (cut) sections.pop();
  return sections.map((s) => ({
    path: s.newPath ?? s.oldPath,
    hunks: s.hunks.length > 0 ? s.hunks.join('\n').replace(/\n$/, '') : undefined,
  }));
}
