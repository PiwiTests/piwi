import { test, expect } from './fixtures';

/**
 * The operator's administrator invitation, as far as a server without SMTP takes it: the token alone opens it, and
 * it is refused before anything is made while authentication is off (the main server) or no email can be sent (the
 * notifications server, authentication on and no SMTP, which only CI starts). The invitation itself, with its
 * emails, is covered by tests/unit/operator-invite.test.ts.
 */

const TOKEN = process.env.PIWI_OPERATOR_TOKEN!;
const INVITE = '/api/operator/admin-invite';
const NO_SMTP_SERVER = 'http://localhost:3097';
const data = { email: 'invited-admin@example.com' };

test.describe('Operator administrator invitation', () => {
  test('opens to the operator token only, and is refused while authentication is off', async ({ request }) => {
    for (const headers of [{}, { Authorization: `Bearer ${TOKEN}x` }] as Record<string, string>[]) {
      expect((await request.post(INVITE, { headers, data })).status(), JSON.stringify(headers)).toBe(401);
    }
    const refused = await request.post(INVITE, { headers: { Authorization: `Bearer ${TOKEN}` }, data });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ data: { errorCode: 'AUTH_DISABLED' } });
  });

  test('is refused without SMTP, before any account is made', async ({ request }) => {
    test.skip(!process.env.CI, 'The notifications server only runs in CI (see playwright.config.ts webServer)');
    const refused = await request.post(`${NO_SMTP_SERVER}${INVITE}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      data,
    });
    expect(refused.status()).toBe(503);
    expect(await refused.json()).toMatchObject({ data: { errorCode: 'SMTP_NOT_CONFIGURED' } });
  });
});
