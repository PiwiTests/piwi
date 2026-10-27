import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

// The agent guides (`AGENTS.md`) are read before every edit in their directory,
// so their size is paid on every task. The rules for them are in the root
// AGENTS.md, "Maintaining the agent guides".

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ROOT_GUIDE_LIMIT = 20_000;
const GUIDE_LIMIT = 30_000;

/** The file Claude Code loads, which imports the guide beside it. */
const CLAUDE_IMPORT = '@AGENTS.md\n';

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'templates']);

const guides: string[] = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) return [];
      return walk(join(dir, entry.name));
    }
    return entry.name === 'AGENTS.md' ? [relative(repoRoot, join(dir, entry.name))] : [];
  });
})(repoRoot);

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces as hyphens, `-1` on a repeat. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = !fenced && /^#{1,6} (.+)$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}

/** Relative Markdown links outside code blocks and code spans: `[text](target)`. */
function linksOf(markdown: string): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]).filter((target) => !/^[a-z]+:/i.test(target));
}

test('finds the guides', () => {
  expect(guides).toContain('AGENTS.md');
  expect(guides.length).toBeGreaterThan(10);
});

describe.each(guides)('%s', (guide) => {
  test('stays within its size limit', () => {
    const limit = guide === 'AGENTS.md' ? ROOT_GUIDE_LIMIT : GUIDE_LIMIT;
    const size = read(guide).length;
    expect(
      size,
      `${guide} is ${size} characters, over ${limit}: move descriptions to ARCHITECTURE.md or a topic guide`,
    ).toBeLessThanOrEqual(limit);
  });

  test('has a CLAUDE.md beside it that imports it', () => {
    const claude = join(dirname(guide), 'CLAUDE.md');
    expect(existsSync(join(repoRoot, claude)), `${claude} is missing: Claude Code reads CLAUDE.md, not AGENTS.md`).toBe(
      true,
    );
    expect(read(claude), `${claude} must contain only the import of its AGENTS.md`).toBe(CLAUDE_IMPORT);
  });

  test('is linked from the guide of the nearest directory above it', () => {
    if (guide === 'AGENTS.md') return;
    let parent = dirname(dirname(guide));
    while (parent !== '.' && !existsSync(join(repoRoot, parent, 'AGENTS.md'))) parent = dirname(parent);
    const parentGuide = join(parent, 'AGENTS.md');
    const linked = linksOf(read(parentGuide)).some(
      (target) => resolve(repoRoot, parent, target.split('#')[0]) === resolve(repoRoot, guide),
    );
    expect(linked, `${parentGuide} lists no link to ${guide}`).toBe(true);
  });

  test('links only to files and headings that exist', () => {
    const broken = linksOf(read(guide)).filter((target) => {
      const [path, anchor] = target.split('#');
      const file = path ? resolve(repoRoot, dirname(guide), path) : join(repoRoot, guide);
      if (!existsSync(file)) return true;
      return Boolean(anchor) && file.endsWith('.md') && !anchorsOf(readFileSync(file, 'utf8')).has(anchor);
    });
    expect(broken, `${guide} links to a missing file or heading`).toEqual([]);
  });
});
