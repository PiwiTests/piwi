import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { RunSession, RunStatus, StatusResult } from '@piwitests/editor/protocol';
import { statusBarView } from '../src/glue';
import { runNodes, workersNow, type RunNode } from '../src/run-control';

/**
 * The golden fixtures both editors' pure halves read (`packages/editor/tests/golden/`): the same inputs give the same
 * words in VS Code and in the JetBrains plugin, whose `GlueTest` reads the same file.
 */
const golden = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../packages/editor/tests/golden/status-and-runs.json'), 'utf-8'),
);

/** The status bar text without VS Code's leading codicon, as the JetBrains plugin draws its icon apart. */
const withoutIcon = (text: string) => text.replace(/^\$\([^)]+\)\s*/, '');

/** A run's rows as the JetBrains Runs tab lists them, flat: each run, then its workers and page. */
const flat = (nodes: RunNode[]): string[][] =>
  nodes.flatMap((n) => [[n.kind, n.label, n.description], ...n.children.map((c) => [c.kind, c.label, c.description])]);

describe('the golden fixtures both editors read', () => {
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
