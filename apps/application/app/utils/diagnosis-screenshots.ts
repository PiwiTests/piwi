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

/**
 * Takes up to `limit` items of the sources' lists in the order `inTurns` gives them: each source's first item is
 * tried before any source's second. The lists are read `batch` sources at a time (at least one), the next batch only
 * while slots are left, so the items past each source's first are tried only once every source's first has been.
 * `take` answers whether the item filled a slot. Returns the number of slots filled.
 */
export async function takeInTurns<S, T>(
  sources: readonly S[],
  list: (source: S) => Promise<readonly T[]>,
  take: (item: T) => Promise<boolean>,
  limit: number,
  batch = limit,
): Promise<number> {
  const lists: Array<readonly T[]> = [];
  let taken = 0;
  const size = Math.max(1, batch);
  for (let start = 0; start < sources.length && taken < limit; start += size) {
    const read = await Promise.all(sources.slice(start, start + size).map(list));
    lists.push(...read);
    for (const items of read) {
      if (taken >= limit) break;
      if (items.length > 0 && (await take(items[0]!))) taken++;
    }
  }
  for (const item of inTurns(lists.map((items) => items.slice(1)))) {
    if (taken >= limit) break;
    if (await take(item)) taken++;
  }
  return taken;
}
