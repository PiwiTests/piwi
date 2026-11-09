/**
 * The numeric params of a route's path, read the same way by the server routes (`requireRouteId`) and the demo
 * router.
 */

/** The largest id a PostgreSQL `serial` column (every table's id) holds, and so the largest a route takes. */
export const MAX_SERIAL_ID = 2_147_483_647;

/**
 * An id as a path writes it: a positive integer written plainly (`12`, never `012`, `12abc` or `0`), at most
 * {@link MAX_SERIAL_ID}, or null.
 */
export function parseRouteId(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_SERIAL_ID ? id : null;
}

/** A 0-based position as a path writes it: `0` or an id (`parseRouteId`), or null. */
export function parseRouteIndex(raw: string | null | undefined): number | null {
  return raw === '0' ? 0 : parseRouteId(raw);
}
