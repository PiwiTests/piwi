import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { dashboardActor, dashboardRoute } from '../../../utils/dashboards';
import { mintShareLink } from '../../../utils/share-links';
import {
  mintedShareLinkResponse,
  readMintTtlDays,
  requireShareLinksEnabled,
  savedDashboardId,
} from '../../../utils/share-view';
import { loadDashboardDefinition } from '#shared/handlers/dashboards';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Create a live dashboard link',
    description:
      'Mints a read-only public link that renders this saved dashboard as a quality report computed at every view and reloading itself every minute, for a wall screen or a bookmark without a session, with its `badge.svg` and `chart.png` beside it. The numbers are computed for the projects the caller may share (`share:create`), re-checked at every view, so the link dies with that access, with the dashboard, or at its expiry or revocation. It never serves evidence files. The full token is returned once and stored only as a hash. Requires `share:create` on at least one project (Maintainer and above), and PIWI_SHARE_LINKS_ENABLED=true.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'share:create',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const id = savedDashboardId(event);
  await dashboardRoute(async () =>
    loadDashboardDefinition(db as any, String(id), await dashboardActor(event, user as any)),
  );
  requireShareLinksEnabled();

  const ttlDays = await readMintTtlDays(event);
  const minted = await mintShareLink(db, {
    projectId: null,
    entityKind: 'dashboard',
    entityId: id,
    createdBy: user.id || null,
    ttlDays,
  });
  return mintedShareLinkResponse(event, minted);
});
