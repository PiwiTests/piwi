import { getDatabase } from '../../database';
import { getRequestAccess, requireSessionAuth } from '../../utils/auth';
import { listMyCredentials } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'List my per-user credentials',
    description:
      'The per-user credentials the caller may use, each with their own token’s state: `{ items }`, each `{ id, name, service, destination, tokenHelpUrl, disabled, createdByName, usable, token }`. A per-user credential acts in the name of whoever starts it, with their own token, which they give with `PUT /api/credentials/:id/token`. It is listed when it is shared with a project where the caller holds `run:control` (`usable`), or when the caller holds a token for it, which they may always remove. `token` is null when they gave none, else `{ remoteUser, state, createdAt, testedAt, lastUsedAt }`: `remoteUser` is their account on the service, as the test named it, and `state` is `ready` or `invalid` (the service refused it); never the token. Refuses an API key (403): only a signed-in session reaches a person’s tokens. Without sign-in, the list is empty.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireSessionAuth(event);
  // The virtual administrator of an instance without sign-in is id 0, no user row: it holds no token.
  if (!user.id) return { items: [] };
  const db = await getDatabase();
  return { items: await listMyCredentials(db, { access: await getRequestAccess(event), userId: user.id }) };
});
