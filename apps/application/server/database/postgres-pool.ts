/** Connections the PostgreSQL pool opens at most when nothing sets its size, postgres.js's own default. */
export const DEFAULT_DATABASE_POOL_MAX = 10;

/** The largest pool size taken: postgres.js makes every connection's object as it opens the pool. */
export const MAX_DATABASE_POOL_MAX = 1000;

/**
 * The `max` in the query of a connection string, or null. The query is read alone, as postgres.js reads it, so a
 * string of several hosts with their ports (`h1:5432,h2:5433`), which `new URL` refuses, keeps its `max`.
 */
function maxInUrl(url: string): string | null {
  const query = url.split('#')[0]!.split('?')[1];
  return query === undefined ? null : new URLSearchParams(query).get('max');
}

/**
 * The most connections the PostgreSQL pool opens: the first of `PIWI_DATABASE_POOL_MAX`, a `max` in the query of
 * `url` and postgres.js's own `PGMAX` that is a whole number of at least 1, else `DEFAULT_DATABASE_POOL_MAX`. Each is
 * read as a number, which postgres.js does not do for `max`, and lowered to `MAX_DATABASE_POOL_MAX`. A value left out
 * or lowered is logged as a warning.
 */
export function postgresPoolMax(url: string, env: NodeJS.ProcessEnv = process.env): number {
  const sources: Array<[name: string, value: string | null | undefined]> = [
    ['PIWI_DATABASE_POOL_MAX', env.PIWI_DATABASE_POOL_MAX],
    ['The max of PIWI_DATABASE_URL', maxInUrl(url)],
    ['PGMAX', env.PGMAX],
  ];
  for (const [name, value] of sources) {
    const written = value?.trim();
    if (!written) continue;
    const size = /^\d+$/.test(written) ? Number(written) : 0;
    if (size < 1) {
      console.warn(`[Database] ${name} is not a whole number of at least 1, so it is left out: ${value}`);
      continue;
    }
    if (size > MAX_DATABASE_POOL_MAX) {
      console.warn(
        `[Database] ${name} is above ${MAX_DATABASE_POOL_MAX}, the most connections the pool opens: ${value}`,
      );
      return MAX_DATABASE_POOL_MAX;
    }
    return size;
  }
  return DEFAULT_DATABASE_POOL_MAX;
}
