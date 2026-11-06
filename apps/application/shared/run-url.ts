/**
 * A run's page as the instance gives it to a client: under the instance's public address (`PIWI_SITE_URL`) when one
 * is set, else as a path, which the client puts under the address it reached the instance at.
 */
export function runPageUrl(siteUrl: string | null | undefined, runId: number): string {
  const site = (siteUrl ?? '').trim().replace(/\/+$/, '');
  return site ? `${site}/test-runs/${runId}` : `/test-runs/${runId}`;
}

/** The page of run `runId` this instance answers with, from its `PIWI_SITE_URL`. */
export function publicRunUrl(runId: number): string {
  return runPageUrl(typeof process === 'undefined' ? null : process.env.PIWI_SITE_URL, runId);
}
