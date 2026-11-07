/**
 * A random version 4 UUID that names one submission of a form, built from `crypto.getRandomValues`, which a page
 * served over plain HTTP has too.
 */
export function newSubmissionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How long a queued filing's id is held: past it, the form files anew. */
const HOLD_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = 'piwi:issue-submission:';

/**
 * The submission ids a queued filing holds, by what the form is about. Kept in the browser's storage, so a reload or
 * another tab of the same browser sends the same id; in memory alone when the storage is unavailable.
 */
const memory = new Map<string, { id: string; at: number }>();

function read(subject: string): string | null {
  let entry = memory.get(subject) ?? null;
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      // The storage is the record when there is one: another tab may have released the id.
      const stored = storage.getItem(KEY_PREFIX + subject);
      entry = stored ? (JSON.parse(stored) as { id: string; at: number }) : null;
    }
  } catch {
    // Storage blocked or the entry unreadable: the memory copy stands.
  }
  if (!entry || typeof entry.id !== 'string') return null;
  if (!(Date.now() - entry.at < HOLD_MS)) {
    releaseSubmission(subject);
    return null;
  }
  return entry.id;
}

/** The id a new opening of the form about `subject` sends: the one a queued filing holds, else a new one. */
export function submissionIdFor(subject: string): string {
  return read(subject) ?? newSubmissionId();
}

/** Whether a filing about `subject` is queued with a held id. */
export function submissionHeld(subject: string): boolean {
  return read(subject) !== null;
}

/** Keep `id` for `subject` while its filing is queued, so the form opened again retries it instead of filing anew. */
export function holdSubmission(subject: string, id: string): void {
  const entry = { id, at: Date.now() };
  memory.set(subject, entry);
  try {
    globalThis.localStorage?.setItem(KEY_PREFIX + subject, JSON.stringify(entry));
  } catch {
    // Storage blocked: held for this page only.
  }
}

/** Forget the id held for `subject`, once its filing is done. */
export function releaseSubmission(subject: string): void {
  memory.delete(subject);
  try {
    globalThis.localStorage?.removeItem(KEY_PREFIX + subject);
  } catch {
    // Storage blocked: the memory copy is gone.
  }
}
