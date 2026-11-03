/**
 * The share link of a ticket body. Piwi keeps no share token: the body of a
 * queued action and the issue's link carry the link's URL with its token
 * redacted. The link is created when the issue is sent to the tracker, and a
 * rewritten description takes its token from the issue as the tracker holds
 * it, in memory only. Lives apart from the builders because
 * `server/utils/share-links` reads `node:crypto`, which the in-browser demo
 * cannot load — the demo builds the same tickets without it.
 */
import { and, asc, eq, gt, sql, type SQLWrapper } from 'drizzle-orm';
import { entityLinks, integrationActions, shareLinks } from '../../database/schema';
import type { DbClient } from '../../database';
import type { DrizzleDB } from '#shared/handlers/db';
import { escapeLikePattern } from '#shared/utils/tag-filter';
import { mintShareLink, shareLinksEnabled } from '../share-links';
import { hashToken } from '../token-hash';
import { getAppSetting, setAppSetting } from '../app-settings';
import type { ShareTokenMinter } from './documents';

/** What a stored body, and every record of it, carries in place of a share link's token. */
const REDACTED_SHARE_TOKEN = '<redacted>';

const REDACTED_SHARE_PATH = `/share/${REDACTED_SHARE_TOKEN}`;

/** A share token in a URL's path. */
const SHARE_TOKEN_IN_PATH = /\/share\/(psl_[0-9a-f]{64})/g;

/**
 * A filing's minter: the body carries the redacted link, and the link itself
 * is created when the issue is sent (`mintIssueShareLink`). Null while share
 * links are off.
 */
export const redactedShareTokenMinter: ShareTokenMinter = async () =>
  shareLinksEnabled() ? REDACTED_SHARE_TOKEN : null;

/** The token a draft shows where the issue's share link goes; the link is created when the issue is filed. */
export const DRAFT_SHARE_TOKEN = '…';

/** A draft's minter: it shows where the share link goes and creates none. */
export const draftShareTokenMinter: ShareTokenMinter = async () => (shareLinksEnabled() ? DRAFT_SHARE_TOKEN : null);

/** A value, a URL or a JSON tree, with every share token in it redacted; the same value when it holds none. */
function redactShareTokens<T>(value: T): T {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  const redacted = json.replace(SHARE_TOKEN_IN_PATH, REDACTED_SHARE_PATH);
  return redacted === json ? value : (JSON.parse(redacted) as T);
}

/** Whether a body carries a redacted share link. */
export function carriesRedactedShareLink(document: unknown): boolean {
  return JSON.stringify(document)?.includes(REDACTED_SHARE_PATH) ?? false;
}

/** A body with its redacted share link pointing at the link of `token`, for sending only. */
export function withShareToken<T>(document: T, token: string): T {
  return JSON.parse(JSON.stringify(document).split(REDACTED_SHARE_PATH).join(`/share/${token}`)) as T;
}

/** Create the share link of a cluster's issue as it is sent, in the name of the person who filed it. */
export async function mintIssueShareLink(
  db: DbClient,
  input: { projectId: number; clusterId: number; createdBy: number | null },
): Promise<{ id: number; token: string }> {
  const minted = await mintShareLink(db, {
    projectId: input.projectId,
    entityKind: 'cluster',
    entityId: input.clusterId,
    createdBy: input.createdBy,
  });
  return { id: minted.link.id, token: minted.token };
}

/** Delete a share link minted for an issue the tracker did not create: its URL never left Piwi. */
export async function discardShareLink(db: DbClient, id: number): Promise<void> {
  await db.delete(shareLinks).where(eq(shareLinks.id, id));
}

/** The tokens of the share links in some URLs. */
function shareTokensIn(urls: string[]): string[] {
  return urls.flatMap((url) => [...url.matchAll(SHARE_TOKEN_IN_PATH)].map((match) => match[1]!));
}

/** The token among `urls` (an issue's links, read from the tracker) whose hash is the stored share link's, or null. */
export async function shareTokenAmong(
  db: DbClient,
  shareLinkId: number | null | undefined,
  urls: string[] | undefined,
): Promise<string | null> {
  if (shareLinkId == null || !urls?.length) return null;
  const [link] = await db
    .select({ tokenHash: shareLinks.tokenHash })
    .from(shareLinks)
    .where(eq(shareLinks.id, shareLinkId));
  if (!link) return null;
  return shareTokensIn(urls).find((token) => hashToken(token) === link.tokenHash) ?? null;
}

/** The id of the share link a URL opens, or null. */
async function shareLinkIdOf(db: DbClient, url: string): Promise<number | null> {
  const [token] = shareTokensIn([url]);
  if (!token) return null;
  const [link] = await db
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, hashToken(token)));
  return link?.id ?? null;
}

/** The app setting that records that {@link redactStoredShareTokens} ran on this instance. */
export const SHARE_TOKENS_REDACTED_SETTING = 'stored_share_tokens_redacted_at';

/** How many rows one page of {@link redactStoredShareTokens} reads. */
const REDACT_PAGE = 200;

/** Whether a JSON column's text may hold a share token. */
function mayHoldShareToken(column: SQLWrapper) {
  return sql`CAST(${column} AS TEXT) LIKE ${`%${escapeLikePattern('/share/psl_')}%`} ESCAPE '\\'`;
}

type Json = Record<string, unknown>;

/** A link's metadata with its share URL redacted, and the id of the link it opens beside it. */
async function redactedLinkMetadata(db: DbClient, metadata: Json): Promise<Json> {
  const redacted = redactShareTokens(metadata);
  if (redacted === metadata) return metadata;
  if (typeof metadata.shareUrl !== 'string' || metadata.shareLinkId != null) return redacted;
  const shareLinkId = await shareLinkIdOf(db, metadata.shareUrl);
  return shareLinkId == null ? redacted : { ...redacted, shareLinkId };
}

/**
 * Redact the share tokens stored before Piwi stopped keeping them: in the
 * payloads of the integration actions (a body, the link it carries) and in
 * the issue links' metadata, which keeps the id of the link beside its
 * redacted URL so a description rewrite finds its token in the issue. Reads
 * only the rows that may hold one, each again before it is written. Returns
 * how many rows it changed.
 */
export async function redactStoredShareTokens(db: DbClient): Promise<number> {
  let changed = 0;
  for (let after = 0; ;) {
    const page = await db
      .select({ id: integrationActions.id })
      .from(integrationActions)
      .where(and(gt(integrationActions.id, after), mayHoldShareToken(integrationActions.payload)))
      .orderBy(asc(integrationActions.id))
      .limit(REDACT_PAGE);
    if (page.length === 0) break;
    for (const { id } of page) {
      const [row] = await db
        .select({ payload: integrationActions.payload })
        .from(integrationActions)
        .where(eq(integrationActions.id, id));
      if (!row) continue;
      const payload = redactShareTokens(row.payload);
      if (payload === row.payload) continue;
      await db
        .update(integrationActions)
        .set({ payload: payload as never })
        .where(eq(integrationActions.id, id));
      changed++;
    }
    after = page.at(-1)!.id;
  }
  for (let after = 0; ;) {
    const page = await db
      .select({ id: entityLinks.id })
      .from(entityLinks)
      .where(and(gt(entityLinks.id, after), mayHoldShareToken(entityLinks.metadata)))
      .orderBy(asc(entityLinks.id))
      .limit(REDACT_PAGE);
    if (page.length === 0) break;
    for (const { id } of page) {
      const [row] = await db.select({ metadata: entityLinks.metadata }).from(entityLinks).where(eq(entityLinks.id, id));
      const metadata = row?.metadata as Json | null | undefined;
      if (!metadata || typeof metadata !== 'object') continue;
      const next = await redactedLinkMetadata(db, metadata);
      if (next === metadata) continue;
      await db
        .update(entityLinks)
        .set({ metadata: next as never })
        .where(eq(entityLinks.id, id));
      changed++;
    }
    after = page.at(-1)!.id;
  }
  return changed;
}

/** Run {@link redactStoredShareTokens} once per instance; null when it ran before. */
export async function redactStoredShareTokensOnce(db: DbClient): Promise<number | null> {
  if (await getAppSetting(db as unknown as DrizzleDB, SHARE_TOKENS_REDACTED_SETTING)) return null;
  const changed = await redactStoredShareTokens(db);
  await setAppSetting(db as unknown as DrizzleDB, SHARE_TOKENS_REDACTED_SETTING, new Date().toISOString());
  return changed;
}
