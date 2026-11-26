/**
 * What the server supplies to the shared report-schedule handlers: the zone
 * schedules run in, a schedule owner's project access at run time, the
 * dashboard's public address and the Piwi version.
 */
import { eq } from 'drizzle-orm';
import type { H3Event } from 'nitro/h3';
import { users, type User } from '../../database/schema';
import type { DbClient } from '../../database';
import { getProjectScope } from '../project-access';
import { getRequestAccess, isAuthEnabled } from '../auth';
import { resolveLocaleSettings } from '../locale-settings';
import { scheduleTimeZone } from '#shared/reports/schedule';
import type { ProjectAccess } from '#shared/handlers/analytics/common';
import { ReportScheduleError, type ReportActor } from '#shared/handlers/reports';
import { ReportRequestError } from '#shared/reports/request';
import { apiError } from '../api-error';
import { isAdministrator } from '#shared/permissions';
import type { GenerateContext } from '#shared/handlers/reports';
import { decryptSecret, encryptSecret, getEncryptionKey } from '../crypto';
import { mintShareLink, shareLinksEnabled } from '../share-links';

/** The instance time zone, or UTC when the instance leaves it to each browser. */
export async function reportScheduleTimeZone(db: DbClient): Promise<string> {
  return scheduleTimeZone((await resolveLocaleSettings(db)).timeZone);
}

/** A schedule owner's project access now; a global schedule (no owner) sees every project. */
export async function scheduleOwnerAccess(db: DbClient, userId: number | null): Promise<ProjectAccess> {
  if (userId === null) return 'all';
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return new Set<number>();
  return getProjectScope(db, user);
}

/** The public address of the dashboard, for the links in a delivered report. */
export function reportBaseUrl(): string {
  const config = useRuntimeConfig().public as { siteUrl?: string };
  return (config.siteUrl || process.env.PIWI_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function reportPiwiVersion(): string | null {
  return ((useRuntimeConfig().public as { appVersion?: string })?.appVersion as string) || null;
}

export async function reportActor(event: H3Event, user: User): Promise<ReportActor> {
  const authEnabled = isAuthEnabled();
  return {
    id: authEnabled ? user.id : null,
    isAdmin: !authEnabled || isAdministrator(await getRequestAccess(event)),
    authEnabled,
  };
}

/** Run a report-schedule handler, turning its refusals into API errors. */
export async function reportRoute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ReportScheduleError) throw apiError({ statusCode: error.statusCode, message: error.message });
    if (error instanceof ReportRequestError) throw apiError({ statusCode: 400, message: error.message });
    throw error;
  }
}

/**
 * How a firing mints its snapshot's share link: the token, shown to nobody,
 * travels encrypted in the outbox payload to the email and Slack senders.
 * Undefined while share links are off.
 */
export function scheduledShareLinkMinter(db: DbClient): GenerateContext['mintShareLink'] {
  if (!shareLinksEnabled()) return undefined;
  return async (snapshotId, expiresAt, createdBy) => {
    const minted = await mintShareLink(db, {
      projectId: null,
      entityKind: 'report',
      entityId: snapshotId,
      createdBy,
      expiresAt,
    });
    return encryptSecret(minted.token, getEncryptionKey());
  };
}

/** The share link a delivery carries, or null (none minted, share links off since, or a key that changed). */
export function deliveredShareUrl(sealed: string | undefined): string | null {
  if (!sealed || !shareLinksEnabled()) return null;
  try {
    return `${reportBaseUrl()}/share/${decryptSecret(sealed, getEncryptionKey())}`;
  } catch {
    return null;
  }
}
