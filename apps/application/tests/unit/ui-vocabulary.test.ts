import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

/**
 * Guards the one on-screen vocabulary the UI settled on: every retired word has
 * a single replacement, and the labels a reader sees come from the enum helpers,
 * not the raw enum values. A hit here means a screen (or a doc describing one)
 * drifted back to a name the rest of the app no longer uses.
 *
 * The scan is deliberately narrow — templates, labels, help copy, docs prose and
 * seeded demo strings. Code identifiers, API route paths and comments keep their
 * historical names (the `failure-groups` route is one), so full-line comments are
 * skipped and a few genuinely-legitimate uses are allow-listed by rule.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const appDir = join(repoRoot, 'apps/application/app');
const docsDir = join(repoRoot, 'apps/docs');
const demoDir = join(repoRoot, 'apps/application/shared/demo');

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue;
      out.push(...walk(full, keep));
    } else if (keep(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Every file the vocabulary rules run over, as `{ rel, lines }`. */
function collectFiles(): { rel: string; lines: string[] }[] {
  const files: string[] = [
    ...walk(appDir, (p) => p.endsWith('.vue') || p.endsWith('.ts')),
    // Top-level docs pages only — the recipe and blog sub-pages keep their own prose.
    ...readdirSync(docsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(docsDir, f)),
    ...walk(demoDir, (p) => ['.ts', '.mjs', '.js'].includes(extname(p))),
  ];
  return files.map((abs) => ({ rel: relative(repoRoot, abs), lines: readFileSync(abs, 'utf8').split('\n') }));
}

const COMMENT_START = /^\s*(\/\/|\/\*|\*|<!--)/;

interface Rule {
  id: string;
  hint: string;
  re: RegExp;
  /** Return true to exempt a matching line (legitimate use). */
  allow?: (ctx: { rel: string; line: string }) => boolean;
}

const RULES: Rule[] = [
  {
    id: 'alternative-locators',
    hint: 'the locator-healing panel is "Locator fix"',
    re: /Alternative locators/,
  },
  {
    id: 'retired-headings',
    hint: 'use the headline fact row, "Diagnosis", or "Fix verification"',
    re: /\b(Regression status|Failure verdict|AI verdict|Diagnosis result|Resolution card)\b/i,
  },
  {
    id: 'clue-labels',
    hint: 'the story leads with "Most likely" and its disclosure is "All clues"',
    re: /\b(The one clue|Other clues)\b/,
  },
  {
    id: 'raw-error',
    hint: 'the disclosure is "Raw error", not "Show raw error"',
    re: /Show raw error/i,
  },
  {
    id: 'fix-plan-pointer',
    hint: 'the pointer sections are gone — the next step leads, and "Fix plan" is only the toolbox export section',
    re: /Open fix plan|Assembled on the cluster/i,
  },
  {
    id: 'triage-card',
    hint: 'the state line and its "Triage ▾" menu replaced the Triage card (the menu button and "Triage note" stay)',
    re: /(?<![-\w])(title|label)\s*[:=]\s*(['"])Triage\2/i,
  },
  {
    id: 'cluster-history-card',
    hint: 'the occurrence sparkline replaced the cluster History card',
    re: /(?<![-\w])(title|label)\s*[:=]\s*(['"])History\2/,
    // The execution page keeps the test's recent executions: the History line of its situation block.
    allow: ({ rel }) => rel.endsWith('app/utils/situation-rows.ts'),
  },
  {
    id: 'fix-verified-badge',
    hint: 'the cluster state sentence carries the verdict; the project badge reads "Verified"',
    re: /\bFix verified\b/,
  },
  {
    id: 'since-last-pass',
    hint: 'the Changes tab replaced "Since last pass"',
    re: /\bSince last pass\b/i,
  },
  {
    id: 'timedout',
    hint: 'a timed-out status reads "Timed out" via formatStatusLabel (the enum values timedout/timedOut are code, not display)',
    re: /\bTimedout\b/,
  },
  {
    id: 'search-test-cases',
    hint: 'search a project catalog for "tests", not "test cases"',
    re: /Search test cases/i,
  },
  {
    id: 'failure-groups',
    hint: 'the on-screen name is "failure cluster" (the failure-groups API route may keep its name)',
    re: /failure groups?\b/i,
    // The API route, handler and type keep their historical name.
    allow: ({ line }) => /failure-groups|FailureGroups?\b|failureGroups\b|getFailureGroups/.test(line),
  },
  {
    id: 'resolution-title',
    hint: 'the block is "Fix verification"',
    re: /(?<![-\w])(title|label)\s*[:=]\s*(['"])Resolution\2/i,
  },
  {
    id: 'test-case-header',
    hint: 'a test\'s identity is "Test" in a column header',
    re: /createSortHeader<[^>]*>\(\s*(['"])Test cases?\1/,
  },
  {
    id: 'test-case-label',
    hint: 'a tab, nav or section label calls a test\'s identity "Test", and the page is "Test history"',
    re: /(?<![-\w])(title|label)\s*[:=]\s*(['"])Test cases?\2/,
  },
  {
    id: 'executions-tab',
    hint: 'the executions list tab is "Tests"',
    re: /(?<![-\w])label\s*[:=]\s*(['"])Executions\1/,
    // A group header's spec-health figure counts executions; only a tab is named "Tests".
    allow: ({ rel }) => rel.endsWith('project/ProjectTestCasesTable.vue'),
  },
  {
    id: 'extract-button',
    hint: 'the cluster bulk action is "Move to a new cluster"',
    re: /(?<![-\w])label\s*[:=]\s*(['"])Extract\1/,
    // The AI test-function extractor is a different feature that keeps the verb.
    allow: ({ rel }) => rel.includes('projects/[id]/test-functions.vue'),
  },
  {
    id: 'retired-tabs',
    hint: 'project and run tabs are Runs/Tests/Failures/Performance/Settings and Tests/Changes/Timeline',
    re: /(?<![-\w])label\s*[:=]\s*(['"])(Insights|Spec health|AI steps)\1/,
  },
];

describe('retired UI vocabulary', () => {
  const files = collectFiles();

  test.each(RULES.map((r) => [r.id, r] as const))('%s', (_id, rule) => {
    const hits: string[] = [];
    for (const { rel, lines } of files) {
      let inFence = false;
      lines.forEach((raw, i) => {
        // Skip fenced code blocks in markdown and full-line comments in code.
        if (rel.endsWith('.md')) {
          if (/^\s*```/.test(raw)) inFence = !inFence;
          if (inFence) return;
        } else if (COMMENT_START.test(raw)) {
          return;
        }
        if (!rule.re.test(raw)) return;
        if (rule.allow?.({ rel, line: raw })) return;
        hits.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 120)}`);
      });
    }
    expect(hits, `Retired vocabulary (${rule.hint}):\n${hits.join('\n')}`).toEqual([]);
  });

  // The rendered label of an execution status or a triage / fix-verification
  // enum must come from a helper, never the raw value interpolated into a
  // template. A bare `status` prop (the component's own execution status) and
  // the domain-specific `triageStatus` / `fixVerification` fields are the
  // unambiguous cases; a generic `x.status` (an HTTP response, a step, an image)
  // is left alone.
  test('no raw execution / triage / fix-verification enum rendered in a template', () => {
    const hits: string[] = [];
    const interp = /\{\{\s*([^}]+?)\s*\}\}/g;
    for (const { rel, lines } of files) {
      if (!rel.endsWith('.vue')) continue;
      lines.forEach((raw, i) => {
        for (const m of raw.matchAll(interp)) {
          const expr = m[1]!.trim();
          // A call such as `formatStatusLabel(status)` is exactly what we want.
          if (/\(/.test(expr)) continue;
          if (/^(status|triageStatus|fixVerification)$/.test(expr) || /\.(triageStatus|fixVerification)$/.test(expr)) {
            hits.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(
      hits,
      `Render enums through formatStatusLabel / formatTriageStatus / fixVerificationBadge:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
