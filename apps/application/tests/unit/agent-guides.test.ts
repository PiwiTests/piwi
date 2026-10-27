import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { lexer, walkTokens, type Token, type Tokens } from 'marked';

// The agent guides (`AGENTS.md`) are read before every edit in their directory,
// so their size is paid on every task. The rules for them are in the root
// AGENTS.md, "Maintaining the agent guides".

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const ROOT_GUIDE_LIMIT = 20_000;
const GUIDE_LIMIT = 30_000;

/** The file Claude Code loads, which imports the guide beside it. */
const CLAUDE_IMPORT = '@AGENTS.md\n';

/**
 * Every file git tracks or would add, as CI's checkout holds them: gitignored and generated files are left out, and so
 * is a tracked file deleted from the working tree.
 */
const repoFiles: string[] = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter((file) => file && existsSync(join(repoRoot, file)));
const fileSet = new Set(repoFiles);
const dirSet = new Set(
  repoFiles.flatMap((file) =>
    file
      .split('/')
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
  ),
);

const named = (name: string) => repoFiles.filter((file) => posix.basename(file) === name);
const guides = named('AGENTS.md');
const maps = named('ARCHITECTURE.md');
const claudeFiles = named('CLAUDE.md');

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

/** The text a heading renders, without its Markdown. */
function plainText(tokens: Token[] = []): string {
  return tokens
    .map((token) => ('tokens' in token && token.tokens ? plainText(token.tokens) : 'text' in token ? token.text : ''))
    .join('');
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens, `-1` on a repeat. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  walkTokens(lexer(markdown), (token) => {
    if (token.type !== 'heading') return;
    const base = plainText((token as Tokens.Heading).tokens)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  });
  return anchors;
}

/** The relative links of a Markdown file, inline or by reference, outside code. */
function linksOf(markdown: string): string[] {
  const links: string[] = [];
  walkTokens(lexer(markdown), (token) => {
    if (token.type === 'link' && !/^[a-z][a-z0-9+.-]*:/i.test(token.href)) links.push(token.href);
  });
  return links;
}

/** A link's target as a path from the repository root: `/x` is the root's, anything else is the source's. */
function targetOf(source: string, link: string): { path: string; anchor: string | undefined } {
  const [rawPath = '', anchor] = link.split('#');
  const path = decodeURIComponent(rawPath);
  if (!path) return { path: source, anchor };
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(source), path);
  return { path: posix.normalize(joined).replace(/\/$/, ''), anchor };
}

/** The relative links of a Markdown file whose file, folder or heading does not exist in the repository. */
function brokenLinks(source: string): string[] {
  return linksOf(read(source)).filter((link) => {
    const { path, anchor } = targetOf(source, link);
    if (!fileSet.has(path) && !dirSet.has(path)) return true;
    return anchor !== undefined && path.endsWith('.md') && !anchorsOf(read(path)).has(anchor);
  });
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

  test('has a CLAUDE.md beside it', () => {
    const claude = posix.join(posix.dirname(guide), 'CLAUDE.md');
    expect(fileSet.has(claude), `${claude} is missing: Claude Code reads CLAUDE.md, not AGENTS.md`).toBe(true);
  });

  test('is linked from the guide of the nearest directory above it', () => {
    if (guide === 'AGENTS.md') return;
    let parent = posix.dirname(posix.dirname(guide));
    while (parent !== '.' && !fileSet.has(posix.join(parent, 'AGENTS.md'))) parent = posix.dirname(parent);
    const parentGuide = posix.join(parent, 'AGENTS.md');
    const linked = linksOf(read(parentGuide)).some((link) => targetOf(parentGuide, link).path === guide);
    expect(linked, `${parentGuide} lists no link to ${guide}`).toBe(true);
  });

  test('links only to files and headings that exist', () => {
    expect(brokenLinks(guide), `${guide} links to a missing file or heading`).toEqual([]);
  });
});

describe.each(maps)('%s', (map) => {
  test('links only to files and headings that exist', () => {
    expect(brokenLinks(map), `${map} links to a missing file or heading`).toEqual([]);
  });
});

describe.each(claudeFiles)('%s', (claude) => {
  test('only imports the guide beside it', () => {
    expect(read(claude), `${claude} must contain only the import of its AGENTS.md`).toBe(CLAUDE_IMPORT);
    const guide = posix.join(posix.dirname(claude), 'AGENTS.md');
    expect(fileSet.has(guide), `${claude} imports ${guide}, which does not exist`).toBe(true);
  });
});
