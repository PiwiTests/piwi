/**
 * The editor's breakpoints a test run started from Piwi pauses at: the enabled
 * line breakpoints (`vscode.debug.breakpoints`) in JavaScript or TypeScript
 * files under a Playwright config's folder. The service turns them into the
 * run's `PIWI_PAUSE_AT`. No VS Code API here: the breakpoints are read through
 * their shape, so the selection is tested without an editor.
 */
import * as path from 'node:path';
import type { EditorBreakpoint } from '@piwitests/editor/protocol';
import type { RunBreakpoint } from './run-control';

/** What the selection reads of a breakpoint: a `vscode.SourceBreakpoint` has a location, a function breakpoint none. */
export interface BreakpointLike {
  /** The editor's id for it, which a move keeps (`vscode.Breakpoint.id`). */
  id: string;
  enabled: boolean;
  location?: {
    uri: { scheme: string; fsPath: string; toString(): string };
    range: { start: { line: number } };
  };
}

/** A file a test or a page object can be written in. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/** Whether `file` is inside `root`. */
export function isUnder(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The enabled line breakpoints in script files under one of `roots` (the Playwright configs' folders), 0-based, each
 * with its id.
 */
export function runBreakpoints(breakpoints: readonly BreakpointLike[], roots: readonly string[]): RunBreakpoint[] {
  const out: RunBreakpoint[] = [];
  for (const b of breakpoints) {
    const location = b.location;
    if (!b.enabled || !location || location.uri.scheme !== 'file') continue;
    const file = location.uri.fsPath;
    if (!SCRIPT_FILE.test(file) || !roots.some((root) => isUnder(root, file))) continue;
    out.push({ id: b.id, uri: location.uri.toString(), line: location.range.start.line });
  }
  return out;
}

/** The places of breakpoints as the service takes them, without the editor's ids. */
export function placesOf(breakpoints: readonly EditorBreakpoint[]): EditorBreakpoint[] {
  return breakpoints.map(({ uri, line }) => ({ uri, line }));
}
