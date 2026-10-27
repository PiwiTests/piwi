/**
 * The lines of a file a run stopped in, as the run has them and as the editor holds them now, for the code written at
 * a stop (`stop-actions.ts`), whichever surface asked: a run's lines are the files as they stood when the service built
 * its command (`started`). The service follows each open document's edits since (`changed`, from the `didChange`
 * notifications, a whole new text by its line diff), so a stopped line maps to the line its statement stands on now,
 * whoever wrote above it: the person, or Piwi's own code from an earlier action. A file no editor held since the run
 * started is taken as its disk text, unchanged while its modification time is older than the run. A file the map
 * cannot follow is refused, with why: one written on disk since, one opened since with a text other than its disk's,
 * one an editor held with unsaved changes as the run started, one whose edits since were more than it keeps, and a
 * stopped line an edit removed or rewrote from its start.
 */
import * as path from 'node:path';
import { diffLines } from '@piwitests/core/line-diff';
import type { DiffHunk } from '@piwitests/core/diff-anchors';
import { placeLine } from './analysis.js';

/** The runs whose start the map keeps, the latest first out. */
const MAX_RUNS = 50;
/** The edits kept for one document; past them its oldest go, and a run started before them cannot be followed. */
const MAX_EDITS = 2000;
/** The documents followed; past them the closed ones go first. */
const MAX_DOCUMENTS = 500;

/** One change of a document, as `didChange` sends it: a range and its new text, or the whole text. */
export interface LineChange {
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

/** A file as the disk holds it: its text and its modification time, in ms; null for none. */
export type DiskFile = { text: string; mtime: number } | null;

/**
 * One edit, as the line map applies it: a range replaced by text of `added` line breaks, a line diff's hunks, or a
 * whole new text whose text before is not known (`lost`).
 */
type Edit =
  | { at: number; startLine: number; startCharacter: number; endLine: number; endCharacter: number; added: number }
  | { at: number; hunks: DiffHunk[] }
  | { at: number; lost: true };

interface Followed {
  /** When the editor opened it, and whether its text then was the disk's, unchanged since `mtime`. */
  openedAt: number;
  sameAsDisk: boolean;
  mtime: number | null;
  edits: Edit[];
  /** Up to when its edits were dropped (`MAX_EDITS`): a run started before cannot be followed. */
  droppedUntil: number;
  /** When the editor closed it, with its text then; null while it is open. */
  closed: { at: number; text: string } | null;
}

interface Run {
  startedAt: number;
  /** The documents the editor held with unsaved changes as the run started. */
  unsaved: Set<string>;
}

/** Where a line of a file stands now, 0-based, or why it cannot be told. */
export type LineNow = { line: number } | { refusal: string };

/** The line `line` is on once `edit` is made: null when the edit removed the line or rewrote it from its start. */
function lineAfter(line: number, edit: Edit): number | null {
  if ('lost' in edit) return null;
  if ('hunks' in edit) {
    const placed = placeLine(line + 1, edit.hunks);
    return placed.state === 'edited' ? null : placed.line - 1;
  }
  const { startLine, startCharacter, endLine, endCharacter, added } = edit;
  if (line < startLine) return line;
  if (line > endLine) return line + added - (endLine - startLine);
  // The edit ends where the line begins: the line follows the new text.
  if (line === endLine && endCharacter === 0) return startLine + added;
  // The edit begins past the line's start: its start stays where it is.
  if (line === startLine && startCharacter > 0) return line;
  // The line's first characters replaced on that line alone, as a new indentation.
  if (line === startLine && endLine === startLine && added === 0) return line;
  return null;
}

/** How many line breaks a text holds. */
function breaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

export class RunLines {
  private readonly runs = new Map<string, Run>();
  private readonly documents = new Map<string, Followed>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A run starts: the service built its command, or, for one it did not build, its first worker connected (`keep`,
   * which leaves a start known as it is). `unsaved` reads the documents the editor holds whose text is not their
   * disk's.
   */
  started(ref: string, unsaved: () => Iterable<string> = () => [], keep = false): void {
    if (keep && this.runs.has(ref)) return;
    this.runs.delete(ref);
    this.runs.set(ref, { startedAt: this.now(), unsaved: new Set(unsaved()) });
    for (const oldest of this.runs.keys()) {
      if (this.runs.size <= MAX_RUNS) break;
      this.runs.delete(oldest);
    }
  }

  /**
   * The editor opened a document, with `text`, its file being `disk` then. One it opens again with the text it closed
   * it with keeps its edits.
   */
  opened(file: string, text: string, disk: DiskFile): void {
    const known = this.documents.get(file);
    if (known?.closed && known.closed.text === text) {
      known.closed = null;
      return;
    }
    this.documents.delete(file);
    this.documents.set(file, {
      openedAt: this.now(),
      sameAsDisk: disk !== null && disk.text === text,
      mtime: disk?.mtime ?? null,
      edits: [],
      droppedUntil: 0,
      closed: null,
    });
    this.trim();
  }

  /**
   * The editor changed a document whose text was `before`: each change in turn, as `didChange` sends them. A whole new
   * text is followed by its line diff against the text before, known when it is the first change of the notification
   * or follows another whole text.
   */
  changed(file: string, before: string | null, changes: readonly LineChange[]): void {
    const followed = this.documents.get(file);
    if (!followed || followed.closed) return;
    const at = this.now();
    let text = before;
    for (const change of changes) {
      if (change.range) {
        const { start, end } = change.range;
        followed.edits.push({
          at,
          startLine: start.line,
          startCharacter: start.character,
          endLine: end.line,
          endCharacter: end.character,
          added: breaks(change.text),
        });
        text = null;
      } else {
        followed.edits.push(
          text === null ? { at, lost: true } : { at, hunks: diffLines('file', text, change.text).hunks },
        );
        text = change.text;
      }
    }
    if (followed.edits.length > MAX_EDITS) {
      const dropped = followed.edits.splice(0, followed.edits.length - MAX_EDITS);
      followed.droppedUntil = dropped[dropped.length - 1]!.at;
    }
  }

  /** The editor closed a document, its text being `text`. */
  closed(file: string, text: string): void {
    const followed = this.documents.get(file);
    if (followed) followed.closed = { at: this.now(), text };
  }

  /**
   * Where the 0-based `line` of `file` in the run `ref` stands now, in the text the editor holds (`open`) or, for a
   * file no editor holds, on `disk`; why it cannot be told otherwise.
   */
  lineNow(ref: string, file: string, line: number, open: boolean, disk: DiskFile): LineNow {
    const run = this.runs.get(ref);
    const name = path.basename(file);
    const again = 'run the test again to write code at its stop.';
    if (!run) return { refusal: `Piwi does not know when this run started: ${again}` };
    if (run.unsaved.has(file)) {
      return { refusal: `${name} had changes not saved when the run started, which the run does not have: ${again}` };
    }
    const followed = this.documents.get(file);
    const heldSince = !!followed && (!followed.closed || followed.closed.at > run.startedAt);
    if (!heldSince) {
      if (open) return { refusal: `Piwi cannot follow the edits made to ${name} since the run started: ${again}` };
      if (!disk || disk.mtime > run.startedAt) {
        return { refusal: `${name} was written on disk since the run started, which Piwi cannot follow: ${again}` };
      }
      return { line };
    }
    if (
      followed.openedAt > run.startedAt &&
      (!followed.sameAsDisk || followed.mtime === null || followed.mtime > run.startedAt)
    ) {
      return { refusal: `${name} changed before the editor opened it, since the run started: ${again}` };
    }
    if (followed.droppedUntil > run.startedAt) {
      return { refusal: `${name} was edited too many times since the run started for Piwi to follow: ${again}` };
    }
    if (followed.closed && (open || disk?.text !== followed.closed.text)) {
      return { refusal: `${name} changed since the editor closed it, which Piwi cannot follow: ${again}` };
    }
    let now: number | null = line;
    for (const edit of followed.edits) {
      if (edit.at <= run.startedAt) continue;
      now = lineAfter(now, edit);
      if (now === null) {
        return { refusal: `The stopped line of ${name} was removed or rewritten since the run started: ${again}` };
      }
    }
    return { line: now };
  }

  /** Drop the documents past `MAX_DOCUMENTS`, the closed ones first, then the oldest. */
  private trim(): void {
    for (const [file, followed] of this.documents) {
      if (this.documents.size <= MAX_DOCUMENTS) return;
      if (followed.closed) this.documents.delete(file);
    }
    for (const file of this.documents.keys()) {
      if (this.documents.size <= MAX_DOCUMENTS) return;
      this.documents.delete(file);
    }
  }
}
