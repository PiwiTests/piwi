import { failurePageFirst } from '#shared/file-classify';

/**
 * One execution's images in the order the AI diagnosis offers them: the page
 * the test failed on first when it is known, then the newest first, as
 * `selectCaseScreenshots` orders them for the server's readers. `images` is in
 * attachment order, oldest first.
 */
export function diagnosisImageOrder<T>(images: readonly T[], name: (image: T) => string | null | undefined): T[] {
  return failurePageFirst([...images].reverse(), name);
}

/** The items of the lists taken in turn: each list's first, then each list's second, and so on. */
export function inTurns<T>(lists: ReadonlyArray<readonly T[]>): T[] {
  const taken: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) taken.push(list[i]!);
  }
  return taken;
}
