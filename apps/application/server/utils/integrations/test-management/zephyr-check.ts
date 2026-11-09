/**
 * The pre-save check of a Zephyr Scale Cloud connection: one sign-in on the region's host, then the projects the token
 * sees. It reports what the connect form shows and stores nothing.
 */
import { INTEGRATION_PROVIDERS } from '#shared/integrations/registry';
import type { ConnectionCheckResult } from '#shared/integrations/types';
import { IntegrationHttpError } from '../http-error';
import { ZEPHYR_TIMEOUT_STATUS, ZephyrScaleClient } from './zephyr-scale';
import type { TestManagementCredentials } from './types';

/** How many project keys the check reports back. */
const PROJECT_KEY_SAMPLE = 5;

const HINT_UNREACHABLE = 'Check that this server can reach Zephyr Scale through any proxy, firewall or VPN.';

/**
 * What to do about a failed Zephyr Scale call, in one sentence an administrator can act on. Null when there is
 * nothing more useful to say than the error itself.
 */
export function zephyrFailureHint(err: unknown): string | null {
  if (err instanceof IntegrationHttpError) {
    if (err.status === ZEPHYR_TIMEOUT_STATUS) return HINT_UNREACHABLE;
    if (err.status === 401) {
      return 'Zephyr Scale refused the token. Paste the whole token, check it has not been revoked, and that it was created for the region you chose.';
    }
    if (err.status === 403)
      return 'The token is valid, but its account may not use Zephyr Scale. Check its access in Jira.';
    if (err.status === 404) return 'Zephyr Scale has no API at this region’s address. Check the region.';
    if (err.status === 429) return 'Zephyr Scale is rate limiting this token. Wait a minute and check again.';
    return null;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return HINT_UNREACHABLE;
  return err instanceof TypeError && /fetch failed/i.test(message) ? HINT_UNREACHABLE : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}

/** Whether a failed call reached Zephyr: it answered, whatever it said. A call that timed out did not. */
function reached(err: unknown): boolean {
  return err instanceof IntegrationHttpError && err.status !== ZEPHYR_TIMEOUT_STATUS;
}

/** The check of one region with a token: sign in, then list the projects the token sees. */
export async function checkZephyrCredentials(
  regionId: string,
  credentials: TestManagementCredentials | null,
): Promise<Pick<ConnectionCheckResult, 'site' | 'auth' | 'projects'>> {
  const region = INTEGRATION_PROVIDERS['zephyr-scale'].endpoint.regions.find((r) => r.id === regionId);
  const site = {
    ok: true,
    reachable: true,
    deploymentType: null,
    title: region?.label ?? null,
    reportedUrl: null,
    cloudId: null,
  };
  const client = credentials ? ZephyrScaleClient.forRegion(regionId, credentials) : null;
  if (!client) return { site };

  let account: { id: string; displayName: string };
  try {
    account = await client.whoAmI();
  } catch (err) {
    const error = errorText(err);
    const hint = zephyrFailureHint(err);
    if (reached(err)) return { site, auth: { ok: false, error, hint } };
    return { site: { ...site, ok: false, reachable: false, error, hint } };
  }

  try {
    const projects = (await client.listProjects()).filter((p) => p.enabled);
    return {
      site,
      auth: { ok: true, account },
      projects: { ok: true, count: projects.length, keys: projects.slice(0, PROJECT_KEY_SAMPLE).map((p) => p.key) },
    };
  } catch (err) {
    return {
      site,
      auth: { ok: true, account },
      projects: { ok: false, count: 0, keys: [], error: errorText(err), hint: zephyrFailureHint(err) },
    };
  }
}
