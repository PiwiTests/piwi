import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { mintShareLink } from '../../../utils/share-links';
import { mintedShareLinkResponse, readMintTtlDays, requireShareLinksEnabled } from '../../../utils/share-view';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'Create a share link for one execution',
    description:
      'Mints a read-only public link for this execution. The full token is returned once and stored only as a hash. Requires PIWI_SHARE_LINKS_ENABLED=true.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'share:create',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db, projectId, user } = await requireResolvedProjectAccess(
    event,
    id,
    resolveTestRunCaseProjectId,
    'Test run case',
  );

  requireShareLinksEnabled();

  const ttlDays = await readMintTtlDays(event);

  const minted = await mintShareLink(db, {
    projectId,
    entityKind: 'execution',
    entityId: id,
    createdBy: user.id || null,
    ttlDays,
  });

  return mintedShareLinkResponse(event, minted);
});
