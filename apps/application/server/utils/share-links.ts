import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { shareLinks, type ShareLink } from '../database/schema';
import type { DbClient } from '../database';
import { hashToken } from './token-hash';
import { isReadOnly } from './operator-limits';
import type { ExportKind } from '#shared/export/types';

export const SHARE_TOKEN_PREFIX = 'psl_';

/**
 * What a share link opens: an execution or a failure cluster (an offline
 * export), a report snapshot (its stored quality report), or a saved
 * dashboard (rendered live as a quality report at every view).
 */
export type ShareLinkKind = ExportKind | 'report' | 'dashboard';

/** Full share token: `psl_` + 64 hex chars. */
const SHARE_TOKEN_RE = /^psl_[0-9a-f]{64}$/;

export const DEFAULT_SHARE_LINK_MAX_TTL_DAYS = 30;
export const MAX_SHARE_LINK_MAX_TTL_DAYS = 3650;

/** Share links are off unless the operator opts in. */
export function shareLinksEnabled(): boolean {
  return process.env.PIWI_SHARE_LINKS_ENABLED === 'true';
}

/**
 * Longest allowed link lifetime in days. `0` lifts the cap entirely and lets
 * links be minted without an expiry.
 */
export function resolveShareLinkMaxTtlDays(): number {
  const raw = process.env.PIWI_SHARE_LINK_MAX_TTL_DAYS;
  if (raw == null || raw.trim() === '') return DEFAULT_SHARE_LINK_MAX_TTL_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SHARE_LINK_MAX_TTL_DAYS;
  return Math.min(Math.floor(parsed), MAX_SHARE_LINK_MAX_TTL_DAYS);
}

/**
 * The expiry a mint request resolves to. With a TTL cap in force, every link
 * expires — a missing or out-of-range request falls back to the cap. With the
 * cap lifted (`0`), a missing request means no expiry.
 */
export function resolveShareLinkExpiry(requestedTtlDays: number | null | undefined, now = new Date()): Date | null {
  const maxTtlDays = resolveShareLinkMaxTtlDays();
  let ttlDays: number | null;
  if (maxTtlDays > 0) {
    const requested =
      typeof requestedTtlDays === 'number' && Number.isFinite(requestedTtlDays) ? requestedTtlDays : null;
    ttlDays = requested && requested >= 1 ? Math.min(Math.floor(requested), maxTtlDays) : maxTtlDays;
  } else {
    ttlDays =
      typeof requestedTtlDays === 'number' && Number.isFinite(requestedTtlDays) && requestedTtlDays >= 1
        ? Math.floor(requestedTtlDays)
        : null;
  }
  return ttlDays == null ? null : new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

/** A requested expiry, moved earlier when it passes the longest allowed lifetime. */
export function capShareLinkExpiry(expiresAt: Date, now = new Date()): Date {
  const maxTtlDays = resolveShareLinkMaxTtlDays();
  if (maxTtlDays === 0) return expiresAt;
  const cap = now.getTime() + maxTtlDays * 24 * 60 * 60 * 1000;
  return new Date(Math.min(expiresAt.getTime(), cap));
}

export interface MintedShareLink {
  /** The full token — shown once, never stored. */
  token: string;
  link: ShareLink;
}

export async function mintShareLink(
  db: DbClient,
  input: {
    /** Null for a report or a dashboard link, which can span several projects. */
    projectId: number | null;
    entityKind: ShareLinkKind;
    entityId: number;
    createdBy: number | null;
    ttlDays?: number | null;
    /** A fixed expiry (a scheduled report's link), capped by the longest allowed lifetime. */
    expiresAt?: Date;
  },
): Promise<MintedShareLink> {
  const secret = randomBytes(32).toString('hex');
  const token = `${SHARE_TOKEN_PREFIX}${secret}`;
  const inserted = await db
    .insert(shareLinks)
    .values({
      projectId: input.projectId,
      entityKind: input.entityKind,
      entityId: input.entityId,
      tokenHash: hashToken(token),
      tokenPrefix: secret.slice(0, 8),
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ? capShareLinkExpiry(input.expiresAt) : resolveShareLinkExpiry(input.ttlDays),
    })
    .returning();
  return { token, link: inserted[0]! };
}

export type ResolvedShareLink =
  /** The token matched a row that is neither revoked nor expired. */
  | { state: 'live'; link: ShareLink }
  /** The token matched a row, so the holder once had a real link — but it is revoked or expired. */
  | { state: 'gone' }
  /** No matching row (or not a share token at all). */
  | { state: 'missing' };

export async function resolveShareToken(db: DbClient, token: string): Promise<ResolvedShareLink> {
  if (!SHARE_TOKEN_RE.test(token)) return { state: 'missing' };
  const rows = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, hashToken(token)));
  const link = rows[0];
  if (!link) return { state: 'missing' };
  if (link.revokedAt || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) return { state: 'gone' };
  return { state: 'live', link };
}

/** Count a successful view, unless the instance is read-only. */
export async function recordShareLinkView(db: DbClient, id: number): Promise<void> {
  if (isReadOnly()) return;
  await db
    .update(shareLinks)
    .set({ lastViewedAt: new Date(), viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.id, id));
}

/** UI-facing row — everything except the hash, which never leaves the server. */
export interface ShareLinkSummary {
  id: number;
  entityKind: string;
  entityId: number;
  tokenPrefix: string;
  createdBy: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
}

function toSummary(link: ShareLink): ShareLinkSummary {
  return {
    id: link.id,
    entityKind: link.entityKind,
    entityId: link.entityId,
    tokenPrefix: link.tokenPrefix,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    lastViewedAt: link.lastViewedAt,
    viewCount: link.viewCount,
  };
}

export async function listEntityShareLinks(
  db: DbClient,
  entityKind: ShareLinkKind,
  entityId: number,
): Promise<ShareLinkSummary[]> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.entityKind, entityKind), eq(shareLinks.entityId, entityId)))
    .orderBy(desc(shareLinks.createdAt));
  return rows.map(toSummary);
}

export async function listProjectShareLinks(db: DbClient, projectId: number): Promise<ShareLinkSummary[]> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.projectId, projectId))
    .orderBy(desc(shareLinks.createdAt));
  return rows.map(toSummary);
}

export async function getShareLink(db: DbClient, id: number): Promise<ShareLink | null> {
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
  return rows[0] ?? null;
}

export async function revokeShareLink(db: DbClient, id: number): Promise<void> {
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, id));
}
