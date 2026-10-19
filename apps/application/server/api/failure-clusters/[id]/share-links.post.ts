import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { mintShareLink } from '../../../utils/share-links';
import { mintedShareLinkResponse, readMintTtlDays, requireShareLinksEnabled } from '../../../utils/share-view';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Create a share link for a failure cluster',
    description:
      'Mints a read-only public link for this cluster. The full token is returned once and stored only as a hash. Requires PIWI_SHARE_LINKS_ENABLED=true.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'share:create',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'failure cluster ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(
    event,
    id,
    resolveClusterProjectId,
    'Failure cluster',
  );

  requireShareLinksEnabled();

  const ttlDays = await readMintTtlDays(event);

  const minted = await mintShareLink(db, {
    projectId,
    entityKind: 'cluster',
    entityId: id,
    createdBy: user.id || null,
    ttlDays,
  });

  return mintedShareLinkResponse(event, minted);
});
