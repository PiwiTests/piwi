import { CredentialRefusedError, recordUserTokenTest } from '../../../../utils/credentials';
import { testCiServerUserToken } from '../../../../utils/ci-server-dispatch';
import { limitUserTokenTests, requireUserTokenRoute } from '../../../../utils/user-tokens';
import { myCredential } from '#shared/handlers/credentials';
import { USER_TOKEN_TEST_REASONS } from '#shared/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Test my token for a per-user credential',
    description:
      'Tests the token the caller gave for a per-user CI server credential, as `PUT /api/credentials/:id/token` tests one before saving it: Jenkins’ `whoAmI/api/json` at the root of the credential’s destination, through the credential’s checks and log. Answers `{ ok, reason, message, credential }`: `ok` true when the CI server took it, else `reason` (`refused`, `anonymous` or `unreachable`) and the `message` to show, never the server’s own answer; `credential` is the entry `GET /api/credentials/mine` lists. A token the CI server refuses becomes `invalid` and is no longer sent; one it takes again becomes `ready`. At most 10 tests per person and credential in 10 minutes (429). Refuses an API key (403); 404 for a credential that is not per-user, that the caller may not see, or that they gave no token for; 400 for a disabled credential or without sign-in.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const { db, viewer, record, entry } = await requireUserTokenRoute(event);
  if (!entry.token) throw apiError({ statusCode: 404, message: 'You gave no token for this credential.' });
  limitUserTokenTests(event, viewer.userId, record.id);
  const startedAt = new Date();
  let result;
  try {
    result = await testCiServerUserToken(db, record, { userId: viewer.userId, apiKeyId: null });
  } catch (e) {
    if (e instanceof CredentialRefusedError) throw apiError({ statusCode: 400, message: e.message });
    throw e;
  }
  // A server that cannot be reached says nothing of the token.
  const state = result.ok ? 'ready' : result.reason === 'unreachable' ? null : 'invalid';
  await recordUserTokenTest(db, { credentialId: record.id, userId: viewer.userId }, state, startedAt);
  return {
    ok: result.ok,
    reason: result.ok ? null : result.reason,
    message: result.ok ? null : USER_TOKEN_TEST_REASONS[result.reason],
    credential: await myCredential(db, viewer, record.id),
  };
});
