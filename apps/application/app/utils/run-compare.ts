/**
 * Two runs to compare, as the run page's Changes tab takes them: the one that
 * started later (a tie goes to the higher id), and the other as its baseline.
 */
export function compareOrder<T extends { id: number; startTime: string | Date }>(a: T, b: T): { newer: T; older: T } {
  const at = new Date(a.startTime).getTime();
  const bt = new Date(b.startTime).getTime();
  const aIsNewer = at > bt || (at === bt && a.id > b.id);
  return aIsNewer ? { newer: a, older: b } : { newer: b, older: a };
}
