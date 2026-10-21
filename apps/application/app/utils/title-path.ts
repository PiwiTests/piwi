/**
 * How a test's title path folds when it is deep: the spec file's folders past
 * four, and its describe blocks past two, show their first ones and their last,
 * and the middle is hidden behind one button that unfolds the whole path.
 */

/** Folders shown in full; a deeper spec file keeps its first two and its last. */
export const TITLE_PATH_MAX_FOLDERS = 4;
/** Describe blocks shown in full; deeper nesting keeps the outermost and the innermost. */
export const TITLE_PATH_MAX_DESCRIBES = 2;

export interface FoldedSegments {
  /** The segments shown before the fold, or every segment when nothing folds. */
  head: readonly string[];
  /** The segments the fold hides; empty when nothing folds. */
  hidden: readonly string[];
  /** The segment shown after the fold; empty when nothing folds. */
  tail: readonly string[];
}

/** `segments` with its middle folded past `max`: the first `keep` and the last show. */
export function foldSegments(segments: readonly string[], max: number, keep: number): FoldedSegments {
  if (segments.length <= max) return { head: segments, hidden: [], tail: [] };
  return { head: segments.slice(0, keep), hidden: segments.slice(keep, -1), tail: segments.slice(-1) };
}

/** A spec file's path split into its folders and its file name. */
export function splitFilePath(filePath: string): { folders: string[]; fileName: string } {
  const parts = filePath.split('/');
  const fileName = parts.pop() ?? '';
  return { folders: parts, fileName };
}
