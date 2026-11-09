interface DriverError {
  code?: unknown;
  extendedCode?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** The codes of a unique-constraint violation: PostgreSQL's SQLSTATE, and SQLite's extended codes (a primary key too). */
const UNIQUE_CODES = new Set(['23505', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);
/** SQLite's primary code for every constraint: unique, foreign key, NOT NULL and CHECK alike. */
const ANY_SQLITE_CONSTRAINT = 'SQLITE_CONSTRAINT';
const UNIQUE_MESSAGE = /unique constraint|duplicate key/i;

/** The error and the errors it wraps: Drizzle wraps the driver's error, and libsql wraps SQLite's. */
function errorChain(err: unknown): DriverError[] {
  const chain: DriverError[] = [];
  for (let e = err; e && typeof e === 'object' && chain.length < 5; e = (e as DriverError).cause) {
    chain.push(e as DriverError);
  }
  return chain;
}

/**
 * Whether an error is a unique-constraint violation (SQLite or PostgreSQL), read through the errors it wraps. A code
 * decides: an extended SQLite code or a SQLSTATE names its constraint. Only an error that names none, or only SQLite's
 * primary `SQLITE_CONSTRAINT`, is read from its message, as sql.js (the demo's driver) reports one.
 */
export function isUniqueViolation(err: unknown): boolean {
  const chain = errorChain(err);
  const codes = chain
    .flatMap((e) => [e.code, e.extendedCode])
    .filter((code): code is string => typeof code === 'string');
  if (codes.some((code) => UNIQUE_CODES.has(code))) return true;
  if (!codes.every((code) => code === ANY_SQLITE_CONSTRAINT)) return false;
  return chain.some((e) => UNIQUE_MESSAGE.test(String(e.message ?? '')));
}
