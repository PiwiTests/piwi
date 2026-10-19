import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractStackFrames } from '@piwitests/core/error-parse';
import type { TestSourceFrame } from '@piwitests/core/wire';

/**
 * Read a snippet of source code surrounding the declaration line, optionally
 * highlighting a separate failing line. Returns a formatted string with line
 * numbers and markers (`>` for the failing line, `*` for the declaration), or
 * `null` on error.
 */
export function readSourceSnippet(
  file: string,
  declLine: number,
  context: number,
  failingLine?: number,
): string | null {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const anchor = failingLine ?? declLine;
    const start = Math.max(0, anchor - context - 1);
    const end = Math.min(lines.length, anchor + context);
    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNum = start + i + 1;
        const hasFailingLine = failingLine != null;
        const isFailing = hasFailingLine && lineNum === failingLine;
        const isDecl = lineNum === declLine && !isFailing;
        let marker = '  ';
        if (isFailing) marker = '> ';
        else if (isDecl) marker = hasFailingLine ? '* ' : '> ';
        return `${marker}${String(lineNum).padStart(4)} | ${l}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

/** How much of an error text the stack-frame scans read: the frames follow the message. */
const MAX_SCANNED_ERROR_CHARS = 64 * 1024;

/**
 * The stack frames of an error text outside `node_modules` and Node's own
 * modules, innermost first, from its first {@link MAX_SCANNED_ERROR_CHARS}
 * characters.
 */
function stackFrames(errorText: string): Array<{ file: string; line: number }> {
  return extractStackFrames(errorText.slice(0, MAX_SCANNED_ERROR_CHARS));
}

/**
 * Collect source snippets for every in-project frame in a failure's call stack,
 * innermost first — the line that actually threw plus the callers above it, so
 * "the interesting part is upper" (a failure inside a helper the test called)
 * is visible, not just the test line that invoked it.
 *
 * Frames in `node_modules` or outside `projectRoot` are dropped (Playwright /
 * library internals), duplicates are collapsed, and the list is capped. When the
 * stack has no in-project frame at all, falls back to the test file's failing
 * line so there is always at least one frame for a failure.
 */
export function collectSourceFrames(
  errorText: string | null | undefined,
  testFile: string,
  declLine: number,
  opts: { projectRoot?: string; context?: number; maxFrames?: number } = {},
): TestSourceFrame[] {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const context = opts.context ?? 8;
  const maxFrames = opts.maxFrames ?? 4;

  const picked: Array<{ absFile: string; line: number }> = [];
  const seen = new Set<string>();

  const add = (absFile: string, line: number) => {
    const key = `${absFile}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({ absFile, line });
  };

  // Walk the stack in order (innermost frame first), keeping in-project frames.
  if (errorText) {
    for (const frame of stackFrames(errorText)) {
      if (picked.length >= maxFrames) break;
      let abs: string;
      try {
        abs = path.resolve(frame.file);
      } catch {
        continue;
      }
      const rel = path.relative(projectRoot, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the project
      if (!isNaN(frame.line)) add(abs, frame.line);
    }
  }

  // Ensure the test file itself is represented (stacks without an in-project frame,
  // or a failure so deep the test frame fell past the cap).
  const absTest = path.resolve(testFile);
  if (!picked.some((p) => p.absFile === absTest)) {
    add(absTest, extractFailingLine(errorText, testFile, declLine));
  }

  const frames: TestSourceFrame[] = [];
  for (const p of picked.slice(0, maxFrames)) {
    const snippet = readSourceSnippet(p.absFile, p.line, context, p.line);
    if (snippet) {
      frames.push({ file: path.relative(projectRoot, p.absFile) || path.basename(p.absFile), line: p.line, snippet });
    }
  }
  return frames;
}

/**
 * Extract the line number of the first stack frame inside `testFile` from an
 * error's stack trace. Falls back to `declarationLine`.
 */
export function extractFailingLine(
  errorText: string | null | undefined,
  testFile: string,
  declarationLine: number,
): number {
  if (!errorText) return declarationLine;
  const expectedFile = path.resolve(testFile);
  for (const frame of stackFrames(errorText)) {
    try {
      if (path.resolve(frame.file) === expectedFile && !isNaN(frame.line)) return frame.line;
    } catch {
      /* skip unresolvable paths */
    }
  }
  return declarationLine;
}
