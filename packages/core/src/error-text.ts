/**
 * Error-text assembly shared by the reporter (live runs) and the dashboard
 * (imported blob reports), so a failure fingerprints identically no matter
 * which path it arrived through.
 *
 * Path relativization stays with the callers: the reporter resolves against
 * `process.cwd()`, while an import resolves against the recorded config
 * directory of the machine that produced the archive.
 */

/**
 * Concatenate a result's errors into one text, deduped by the first 200
 * characters of each trimmed message.
 *
 * Playwright's primary error carries the failure, but for a **timeout** it is
 * only the bare `Test timeout of 30000ms exceeded.` — the interrupted action's
 * actual error (with its call log, the single most diagnostic fact) lives in
 * the remaining entries. Joining them all ensures the call log survives, so the
 * locator can be extracted and the failure clustered correctly.
 */
export function joinErrorMessages(errors: ReadonlyArray<{ message?: string }> | null | undefined): string | null {
  if (!errors || errors.length === 0) return null;

  const seen = new Set<string>();
  const parts: string[] = [];

  for (const err of errors) {
    const msg = err.message ?? '';
    if (!msg) continue;
    const dedupeKey = msg.trim().slice(0, 200);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    parts.push(msg);
  }

  return parts.join('\n---\n') || null;
}

/**
 * Append a synthetic `at file:line:col` frame when the text carries no stack
 * frame, so locator healing can find the pre-captured snapshot for that call
 * site. The frame sits after the message, where `extractMessageHead` trims it
 * before fingerprinting — so clustering is unaffected.
 */
export function appendErrorLocation(
  text: string,
  location: { file?: string; line?: number; column?: number } | null | undefined,
): string {
  if (!location?.file || /\n[ \t]+at\s/.test(text)) return text;
  return `${text}\n    at ${location.file}:${location.line}:${location.column}`;
}
