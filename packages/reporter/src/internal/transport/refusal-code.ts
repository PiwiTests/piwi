/**
 * The codes the dashboard names its refusals with, read from an answer's body. No dependency, so a test worker reads
 * them as the reporter does.
 */

/** The code of the dashboard's refusal of a write while it is read-only: it takes none for now, and reads still go. */
export const READ_ONLY_CODE = 'READ_ONLY';

/**
 * The code the dashboard names a failed request with: the `data.errorCode` of its JSON body (`text`), as every refusal
 * of its own carries one (`{ statusCode, message, data: { errorCode } }`). Null for any other body.
 */
export function refusalCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { data?: { errorCode?: unknown } | null } | null;
    const code = body?.data?.errorCode;
    return typeof code === 'string' && code !== '' ? code : null;
  } catch {
    return null;
  }
}
