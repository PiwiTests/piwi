/**
 * The anonymous side of share links: the checks every `/share/<token>` view
 * runs (the flag, the rate limit, the token), and the quality report a report
 * or a live dashboard link opens. A report link reads its snapshot's stored
 * bundle; a live dashboard link collects the dashboard at every view with the
 * project access of the person who minted it, so the link dies with that
 * access, with the dashboard, or with its own expiry or revocation.
 */
import { eq } from 'drizzle-orm';
import { readBody, type H3Event } from 'h3';
import { z } from 'zod';
import { users, type ShareLink } from '../database/schema';
import { getDatabase, type DbClient } from '../database';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from './rate-limit';
import { resolveShareLinkMaxTtlDays, resolveShareToken, shareLinksEnabled, type MintedShareLink } from './share-links';
import { publicBaseUrl } from './public-base-url';
import { getUserAccessCached, isAuthEnabled } from './auth';
import { TtlCache } from './ttl-cache';
import { reportBaseUrl, reportPiwiVersion, reportScheduleTimeZone } from './reports/context';
import {
  DashboardError,
  dashboardActorFor,
  loadDashboardDefinition,
  type DashboardActor,
} from '#shared/handlers/dashboards';
import { loadSnapshotForDelivery } from '#shared/handlers/reports';
import { dashboardScope } from '#shared/analytics/dashboards';
import { collectReportBundle } from '#shared/reports/collect';
import type { ProjectAccess } from '#shared/handlers/analytics/common';
import type { ReportBundle } from '#shared/reports/types';
import { projectScopeFor } from '#shared/permissions';

/** Requests per client address per window — log-noise defense; the 256-bit token is the security boundary. */
const LOOKUP_LIMIT = 120;
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Image requests (`badge.svg`, `chart.png`) per link per window. Image proxies (GitHub's for a README
 * badge, Slack's for an unfurled chart) fetch from few addresses for many readers, so an image counts
 * against its link, not the address; only a token that resolves to no link counts against the address.
 */
const IMAGE_LINK_LIMIT = 600;

/** How long an image proxy may keep a badge or a chart: a revoked link's image can outlive it that long. */
export const SHARE_IMAGE_MAX_AGE_SECONDS = 300;

/** A live dashboard link reloads on this cadence, and its bundle is reused for as long. */
export const LIVE_DASHBOARD_REFRESH_SECONDS = 60;

const GONE_PAGE =
  '<!doctype html><html><head><title>Link no longer available</title></head><body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; text-align: center;"><h1>This link is no longer available</h1><p>The share link was revoked or has expired. Ask the person who sent it for a new one.</p></body></html>';

export type OpenedShareLink = { db: DbClient; link: ShareLink } | { gone: string };

/**
 * Run the checks of a share view and resolve its token. A revoked or expired
 * link answers a short HTML page when `gonePage` is set (the holder once had
 * the real link), else a bare 404, like an unknown token. An `image` request
 * is limited per link and may be cached for a few minutes (see
 * `IMAGE_LINK_LIMIT`); a page is limited per address and never cached.
 */
export async function openShareLink(
  event: H3Event,
  opts: { gonePage: boolean; image?: boolean },
): Promise<OpenedShareLink> {
  // Uncacheable until the link is known, and uninteresting to crawlers, valid or not.
  setResponseHeader(event, 'Cache-Control', 'no-store');
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow');

  if (!shareLinksEnabled()) throw apiError({ statusCode: 404, message: 'Not found' });

  const addressKey = `${opts.image ? 'share-img' : 'share'}:${rateLimitClientIp(event)}`;
  if (!opts.image && !checkRateLimit(addressKey, LOOKUP_LIMIT, LOOKUP_WINDOW_MS)) {
    throw rateLimitedError(event, [addressKey]);
  }

  const token = String(getRouterParam(event, 'token') ?? '');
  const db = await getDatabase();
  const resolved = await resolveShareToken(db, token);
  if (opts.image && resolved.state !== 'live') {
    // Only a miss counts against the address, so an image proxy's misses never block its valid links.
    if (!checkRateLimit(addressKey, LOOKUP_LIMIT, LOOKUP_WINDOW_MS)) throw rateLimitedError(event, [addressKey]);
    throw apiError({ statusCode: 404, message: 'Not found' });
  }
  if (resolved.state === 'missing') throw apiError({ statusCode: 404, message: 'Not found' });
  if (resolved.state === 'gone') {
    if (!opts.gonePage) throw apiError({ statusCode: 404, message: 'Not found' });
    setResponseStatus(event, 404);
    setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');
    setResponseHeader(event, 'Content-Security-Policy', 'sandbox');
    return { gone: GONE_PAGE };
  }
  if (opts.image) {
    const linkKey = `share-img-link:${resolved.link.id}`;
    if (!checkRateLimit(linkKey, IMAGE_LINK_LIMIT, LOOKUP_WINDOW_MS)) throw rateLimitedError(event, [linkKey]);
    setResponseHeader(event, 'Cache-Control', `public, max-age=${SHARE_IMAGE_MAX_AGE_SECONDS}`);
  }
  return { db, link: resolved.link };
}

/** The headers of a rendered share document: its own opaque origin, like a print export. */
export function setShareDocumentHeaders(event: H3Event, contentType: string, length: number): void {
  setResponseHeader(event, 'Content-Type', contentType);
  setResponseHeader(event, 'Content-Length', length);
  setResponseHeader(event, 'Content-Disposition', 'inline');
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer');
  setResponseHeader(event, 'Content-Security-Policy', 'sandbox allow-scripts allow-modals');
}

/**
 * The person who minted a link, as the dashboard handlers see them, with the
 * projects they may share now (`share:create`). Null once that person is gone;
 * with authentication off every link reads every project, as every viewer does.
 */
export async function minterAccess(
  db: DbClient,
  link: Pick<ShareLink, 'createdBy'>,
): Promise<{ actor: DashboardActor; access: ProjectAccess } | null> {
  if (!isAuthEnabled()) return { actor: dashboardActorFor(null, null), access: 'all' };
  if (link.createdBy == null) return null;
  const [user] = await db.select().from(users).where(eq(users.id, link.createdBy));
  if (!user) return null;
  const access = await getUserAccessCached(db, user);
  return { actor: dashboardActorFor(user.id, access), access: projectScopeFor(access, 'share:create') };
}

const liveBundles = new TtlCache<ReportBundle>(LIVE_DASHBOARD_REFRESH_SECONDS * 1000, 200);

/** Drop the cached bundle of a live dashboard link (on revocation). */
export function forgetLiveDashboard(linkId: number): void {
  liveBundles.delete(String(linkId));
}

/** A saved dashboard collected now, for the minter's project access; null when that access or the dashboard is gone. */
async function liveDashboardBundle(db: DbClient, link: ShareLink): Promise<ReportBundle | null> {
  const cached = liveBundles.get(String(link.id));
  if (cached) return cached;
  const minter = await minterAccess(db, link);
  if (!minter) return null;
  let dashboard: Awaited<ReturnType<typeof loadDashboardDefinition>>;
  try {
    dashboard = await loadDashboardDefinition(db as any, String(link.entityId), minter.actor);
  } catch (error) {
    if (error instanceof DashboardError) return null;
    throw error;
  }
  const timeZone = await reportScheduleTimeZone(db);
  const bundle = await collectReportBundle(db as any, {
    dashboard: { ref: dashboard.ref, name: dashboard.name, definition: dashboard.definition },
    scope: { ...dashboardScope(dashboard.definition), timeZone },
    access: minter.access,
    timeZone,
    baseUrl: reportBaseUrl(),
    piwiVersion: reportPiwiVersion(),
  });
  liveBundles.set(String(link.id), bundle);
  return bundle;
}

/**
 * The quality report a report or a live dashboard link opens, or null for
 * another kind of link, a pruned snapshot, a deleted dashboard or a minter
 * who lost their access.
 */
export async function shareLinkReport(
  db: DbClient,
  link: ShareLink,
): Promise<{ bundle: ReportBundle; live: boolean } | null> {
  if (link.entityKind === 'report') {
    const snapshot = await loadSnapshotForDelivery(db as any, link.entityId);
    return snapshot ? { bundle: snapshot.bundle, live: false } : null;
  }
  if (link.entityKind === 'dashboard') {
    const bundle = await liveDashboardBundle(db, link);
    return bundle ? { bundle, live: true } : null;
  }
  return null;
}

/** The public address share links are served under, as the request or `siteUrl` gives it. */
export function shareBaseUrl(event: H3Event): string {
  return publicBaseUrl(event);
}

/**
 * What a mint route answers: the full link, shown once, and for a report or a
 * dashboard link the badge and chart image addresses that ride on it.
 */
export function mintedShareLinkResponse(event: H3Event, minted: MintedShareLink) {
  const url = `${shareBaseUrl(event)}/share/${minted.token}`;
  const images = minted.link.entityKind === 'report' || minted.link.entityKind === 'dashboard';
  return {
    token: minted.token,
    url,
    ...(images ? { badgeUrl: `${url}/badge.svg`, chartUrl: `${url}/chart.png` } : {}),
    maxTtlDays: resolveShareLinkMaxTtlDays(),
    link: {
      id: minted.link.id,
      tokenPrefix: minted.link.tokenPrefix,
      expiresAt: minted.link.expiresAt,
      createdAt: minted.link.createdAt,
    },
  };
}

const mintBodySchema = z.object({ ttlDays: z.number().int().min(1).max(3650).nullish() });

/** The lifetime in days a mint request asks for, unset for the default; any other body is refused (400). */
export async function readMintTtlDays(event: H3Event): Promise<number | null | undefined> {
  const validation = mintBodySchema.safeParse((await readBody(event).catch(() => null)) ?? {});
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: validation.error.issues });
  }
  return validation.data.ttlDays;
}

/** Refuse a mint while share links are off. */
export function requireShareLinksEnabled(): void {
  if (!shareLinksEnabled()) {
    throw apiError({
      statusCode: 403,
      message: 'Share links are disabled. Set PIWI_SHARE_LINKS_ENABLED=true to allow them.',
    });
  }
}

/** The saved dashboard id of a `dashboards/[id]/share-links` route; a built-in key is refused. */
export function savedDashboardId(event: H3Event): number {
  const raw = String(getRouterParam(event, 'id') ?? '');
  if (!/^\d+$/.test(raw)) {
    throw apiError({
      statusCode: 400,
      message: 'Only a saved dashboard has live dashboard links. Duplicate a built-in dashboard to share it.',
    });
  }
  return Number(raw);
}
