import { CredentialRefusedError, saveUserToken } from '../../../../utils/credentials';
import { testCiServerUserToken } from '../../../../utils/ci-server-dispatch';
import { limitUserTokenTests, requireUserTokenRoute } from '../../../../utils/user-tokens';
import { myCredential } from '#shared/handlers/credentials';
import { USER_TOKEN_TEST_REASONS, userTokenInputProblem } from '#shared/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Give my token for a per-user credential',
    description:
      'Tests the caller’s own token for a per-user CI server credential, and saves it when the CI server takes it, in place of the one they gave before. The body is `{ user, secret }`: their user name on the CI server and an API token (32 or 34 hexadecimal characters, as Jenkins makes them; a password is refused with 400, so none is ever stored). The test reads Jenkins’ `whoAmI/api/json` at the root of the credential’s destination with them, through the credential’s checks and log, and must name a signed-in account. Answers `{ credential }`, the entry `GET /api/credentials/mine` lists, with the account the test named as `token.remoteUser`. A token the CI server refuses, or a server that cannot be reached, answers 400 with `data.reason` (`refused`, `anonymous` or `unreachable`) and nothing of the server’s own answer; an account another person already gave a token for answers 409, since each person gives their own; a disabled credential 400. The token is sealed with the credential, the caller and the destination, and never returned. At most 10 tests per person and credential in 10 minutes (429). Refuses an API key (403); 404 for a credential that is not per-user or that the caller may not use; 400 without sign-in; 409 while `PIWI_SECRET_KEY` is unset.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['user', 'secret'],
            properties: {
              user: { type: 'string', description: 'The user name on the CI server' },
              secret: { type: 'string', description: 'An API token of that user' },
            },
          },
        },
      },
    },
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const { db, viewer, record, entry } = await requireUserTokenRoute(event);
  if (!entry.usable) throw apiError({ statusCode: 404, message: 'Credential not found' });
  const body = (await readBody(event).catch(() => null)) as { user?: unknown; secret?: unknown } | null;
  const user = typeof body?.user === 'string' ? body.user.trim() : '';
  const secret = typeof body?.secret === 'string' ? body.secret.trim() : '';
  const problem = userTokenInputProblem(user, secret);
  if (problem) throw apiError({ statusCode: 400, message: problem });
  limitUserTokenTests(event, viewer.userId, record.id);

  let result;
  try {
    result = await testCiServerUserToken(db, record, { userId: viewer.userId, apiKeyId: null }, { user, secret });
  } catch (e) {
    if (e instanceof CredentialRefusedError) throw apiError({ statusCode: 400, message: e.message });
    throw e;
  }
  if (!result.ok) {
    throw apiError({
      statusCode: 400,
      message: USER_TOKEN_TEST_REASONS[result.reason],
      data: { reason: result.reason },
    });
  }
  const saved = await saveUserToken(
    db,
    { credentialId: record.id, userId: viewer.userId, destination: record.destination, remoteUser: result.remoteUser },
    { user, secret },
  );
  if (!saved.saved) throw apiError({ statusCode: 409, message: saved.message });
  return { credential: await myCredential(db, viewer, record.id) };
});
