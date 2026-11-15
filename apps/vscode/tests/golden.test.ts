import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { FileSummary, RunSession, RunStatus, StatusResult } from '@piwitests/editor/protocol';
import { lensLines, statusBarView, testDecorations } from '../src/glue';
import { runNodes, workersNow, type RunNode } from '../src/run-control';

/**
 * The golden fixtures both editors' pure halves read (`packages/editor/tests/golden/`): the same inputs give the same
 * words in VS Code and in the JetBrains plugin, whose `GlueTest` reads the same file.
 */
const golden = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../packages/editor/tests/golden/status-and-runs.json'), 'utf-8'),
);

const testLines = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../packages/editor/tests/golden/test-lines.json'), 'utf-8'),
) as {
  spec: { text: string };
  summary: FileSummary;
  marks: Array<[number, string, string]>;
  failing: { test: [number, number]; line: number };
  lenses: Array<[number, string[]]>;
};

/**
 * A test mark's hover as Markdown shows it: a backslash's character as itself, and an emphasis marker or an HTML tag
 * nobody escaped gone, as the reader sees them. The JetBrains plugin's tooltip shows the same words.
 */
const hoverWords = (hover: string) =>
  hover.replace(/\\(.)|<[^>]*>|[*_]/g, (whole, escaped: string | undefined) => escaped ?? '');

/** The status bar text without VS Code's leading codicon, as the JetBrains plugin draws its icon apart. */
const withoutIcon = (text: string) => text.replace(/^\$\([^)]+\)\s*/, '');

/** A run's rows as the JetBrains Runs tab lists them, flat: each run, then its workers and page. */
const flat = (nodes: RunNode[]): string[][] =>
  nodes.flatMap((n) => [[n.kind, n.label, n.description], ...n.children.map((c) => [c.kind, c.label, c.description])]);

describe('the golden fixtures both editors read', () => {
  test('the rows above a spec’s lines: each line’s lenses, in the service’s order', () => {
    const rows = new Map<number, string[]>();
    for (const l of lensLines(testLines.summary, testLines.spec.text.split('\n').length))
      rows.set(l.line, [...(rows.get(l.line) ?? []), l.title]);
    expect([...rows].sort(([a], [b]) => a - b)).toEqual(testLines.lenses);
  });

  test('the marks of a spec’s tests: each test’s line, its result’s mark and its hover', () => {
    const decorations = testDecorations(testLines.summary.lines);
    expect(decorations.map((d) => [d.line, d.status, hoverWords(d.hover)])).toEqual(testLines.marks);
    // Each mark is the gutter image of its status, which the extension draws (`media/test-<status>.svg`).
    for (const d of decorations)
      expect(fs.existsSync(path.resolve(__dirname, `../media/test-${d.status}.svg`))).toBe(true);
    // The failing test's background over its lines, and the stronger one on the line it failed at.
    const failing = decorations.filter((d) => d.failingUntil !== null);
    expect(failing.map((d) => ({ test: [d.line, d.failingUntil], line: d.failingLine }))).toEqual([testLines.failing]);
  });

  const status: StatusResult = { contexts: [golden.status.context] };
  for (const c of golden.status.cases as Array<{ name: string; runs: RunStatus; text: string }>) {
    test(`the status bar: ${c.name}`, () => {
      expect(withoutIcon(statusBarView(status, { contexts: [c.runs] }).text)).toBe(c.text);
    });
  }
  for (const c of golden.runs.cases as Array<{
    name: string;
    sessions: RunSession[];
    rows: string[][];
    workers: string[];
  }>) {
    const sessions = new Map(c.sessions.map((s) => [s.ref, s]));
    test(`the Runs view: ${c.name}`, () => {
      expect(flat(runNodes(sessions))).toEqual(c.rows);
    });
    test(`the workers the status tooltip lists: ${c.name}`, () => {
      expect(workersNow(sessions)).toEqual(c.workers);
    });
  }
});
