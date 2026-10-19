import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { getProjectScope, requireRouteId } from '../../../../utils/project-access';
import { reportRoute } from '../../../../utils/reports/context';
import { mintShareLink } from '../../../../utils/share-links';
import { mintedShareLinkResponse, readMintTtlDays, requireShareLinksEnabled } from '../../../../utils/share-view';
import { getReportSnapshot } from '#shared/handlers/reports';

defineRouteMeta({
  openAPI: {
    tags: ['Reports'],
    summary: 'Create a share link for a report snapshot',
    description:
      'Mints a read-only public link to this stored quality report, with its `badge.svg` and `chart.png` beside it. The full token is returned once and stored only as a hash. The caller needs `share:create` on every project the snapshot covers (Maintainer and above). Requires PIWI_SHARE_LINKS_ENABLED=true.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'share:create',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'snapshot ID');
  const db = await getDatabase();
  await reportRoute(async () =>
    getReportSnapshot(db as any, id, await getProjectScope(db, user as any, 'share:create')),
  );
  requireShareLinksEnabled();

  const ttlDays = await readMintTtlDays(event);
  const minted = await mintShareLink(db, {
    projectId: null,
    entityKind: 'report',
    entityId: id,
    createdBy: user.id || null,
    ttlDays,
  });
  return mintedShareLinkResponse(event, minted);
});
