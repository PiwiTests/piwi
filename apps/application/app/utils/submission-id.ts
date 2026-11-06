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

/** The submission ids a queued filing holds, by what the form is about, for this page's life. */
const held = new Map<string, string>();

/** The id a new opening of the form about `subject` sends: the one a queued filing holds, else a new one. */
export function submissionIdFor(subject: string): string {
  return held.get(subject) ?? newSubmissionId();
}

/** Whether a filing about `subject` is queued with a held id. */
export function submissionHeld(subject: string): boolean {
  return held.has(subject);
}

/** Keep `id` for `subject` while its filing is queued, so the form opened again retries it instead of filing anew. */
export function holdSubmission(subject: string, id: string): void {
  held.set(subject, id);
}

/** Forget the id held for `subject`, once its filing is done. */
export function releaseSubmission(subject: string): void {
  held.delete(subject);
}
