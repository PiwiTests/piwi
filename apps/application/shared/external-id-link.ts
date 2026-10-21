/**
 * The link from a test's external ID to the test in the team's test management tool: a project setting, an absolute
 * `http(s)` URL holding `{id}`, which the ID replaces (`https://tcm.example.com/case/{id}`).
 */

/** What the ID replaces in the template. */
export const EXTERNAL_ID_PLACEHOLDER = '{id}';

const MAX_EXTERNAL_ID_URL_CHARS = 500;

export const INVALID_EXTERNAL_ID_URL =
  'externalIdUrl must be an absolute http(s) URL of at most 500 characters holding {id}, such as https://tcm.example.com/case/{id}';

/**
 * The stored form of a template: trimmed, `null` for none (`null` or blank). `undefined` when the value is not a
 * valid template, so the caller can refuse it.
 */
export function normalizeExternalIdUrl(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_EXTERNAL_ID_URL_CHARS || !trimmed.includes(EXTERNAL_ID_PLACEHOLDER)) return undefined;
  try {
    const { protocol } = new URL(trimmed.replaceAll(EXTERNAL_ID_PLACEHOLDER, 'id'));
    return protocol === 'http:' || protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** The link to one test, or `null` when the project has no template (or a stored one is no longer valid). */
export function externalIdLink(template: string | null | undefined, externalId: string): string | null {
  const valid = normalizeExternalIdUrl(template);
  return valid ? valid.replaceAll(EXTERNAL_ID_PLACEHOLDER, encodeURIComponent(externalId)) : null;
}
