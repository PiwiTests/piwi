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

/** postgres.js's factory, as `import('postgres')` gives it. */
type Postgres = typeof import('postgres');

/** The options the server passes postgres.js. */
type PostgresOptions = NonNullable<Parameters<Postgres>[1]>;

/**
 * The startup parameters each connection of the pool sends: JIT compilation off. With it on, PostgreSQL compiles every
 * query whose plan's estimated cost is past `jit_above_cost` at each run, a prepared statement's included.
 */
export const POSTGRES_STARTUP_PARAMETERS = { jit: 'off' } as const;

/** Whether `error` is an answer of the server or of a pooler (postgres.js's `PostgresError`), not a network failure. */
function answeredByServer(error: unknown): boolean {
  return error instanceof Error && 'severity' in error;
}

/** The message of `error`, for the server's log. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the PostgreSQL pool of `url` with `options` and `POSTGRES_STARTUP_PARAMETERS`, and run a first query on it.
 * When the server or a pooler refuses that query (PgBouncer answers `unsupported startup parameter: jit` unless its
 * `ignore_startup_parameters` lists it) and accepts one from a pool opened without the parameters, that pool is used,
 * with a warning, and the server's own `jit` setting applies. Any other failure of the first query (the network, or a
 * refusal the second pool gets too) is logged and thrown, and no pool is left open.
 */
export async function openPostgresPool(postgres: Postgres, url: string, options: PostgresOptions) {
  const client = postgres(url, { ...options, connection: { ...options.connection, ...POSTGRES_STARTUP_PARAMETERS } });
  try {
    await client`SELECT 1`;
    return client;
  } catch (error) {
    await client.end({ timeout: 0 });
    if (answeredByServer(error)) {
      const plain = postgres(url, options);
      try {
        await plain`SELECT 1`;
        console.warn(
          `[Database] PostgreSQL refused a connection with jit=off and accepted one without it, so JIT compilation follows the server's setting: ${messageOf(error)}`,
        );
        return plain;
      } catch {
        await plain.end({ timeout: 0 });
      }
    }
    console.error('[Database] Could not connect to PostgreSQL:', error);
    throw error;
  }
}
