/** Whether an error is a unique-constraint violation (SQLite or PostgreSQL). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code;
  if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') return true;
  return /unique constraint|duplicate key/i.test(String(e?.message ?? ''));
}
