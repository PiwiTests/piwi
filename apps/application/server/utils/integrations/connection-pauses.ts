/**
 * When each rate-limited connection may be called again, as this server process learned it. Every attempt reads it
 * before calling the provider (a click and a write made at once included). It lives apart from the action sweep so
 * the connection helpers can read it without importing that sweep.
 */
const connectionPauses = new Map<number, number>();

/** The moment a rate-limited connection may be called again, or null when it is not paused. */
export function connectionPausedUntil(connectionId: number, now: Date): Date | null {
  const until = connectionPauses.get(connectionId);
  if (until == null) return null;
  if (until <= now.getTime()) {
    connectionPauses.delete(connectionId);
    return null;
  }
  return new Date(until);
}

/** Hold a connection until `untilMs`; a longer hold it already has stays. */
export function holdConnection(connectionId: number, untilMs: number): void {
  connectionPauses.set(connectionId, Math.max(connectionPauses.get(connectionId) ?? 0, untilMs));
}
