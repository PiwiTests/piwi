/**
 * The server's share-token minter for ticket bodies. Lives apart from the
 * builders because `server/utils/share-links` reads `node:crypto`, which the
 * in-browser demo cannot load — the demo builds the same tickets without it.
 */
import type { DbClient } from '../../database';
import { mintShareLink, shareLinksEnabled } from '../share-links';
import type { ShareTokenMinter } from './documents';

/**
 * A minter bound to `db` that records who asked for the link; yields null when
 * share links are disabled or minting fails.
 */
export function clusterShareTokenMinter(db: DbClient, createdBy: number | null): ShareTokenMinter {
  return async (projectId, clusterId) => {
    if (!shareLinksEnabled()) return null;
    try {
      const minted = await mintShareLink(db, {
        projectId,
        entityKind: 'cluster',
        entityId: clusterId,
        createdBy,
      });
      return minted.token;
    } catch {
      return null;
    }
  };
}

/** The token a draft shows where the issue's share link goes; the link is created when the issue is filed. */
export const DRAFT_SHARE_TOKEN = '…';

/** A draft's minter: it shows where the share link goes and creates none. */
export const draftShareTokenMinter: ShareTokenMinter = async () => (shareLinksEnabled() ? DRAFT_SHARE_TOKEN : null);
