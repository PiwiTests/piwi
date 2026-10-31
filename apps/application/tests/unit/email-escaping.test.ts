import { describe, test, expect } from 'vitest';
import { renderInviteEmail, renderTestEmail, renderNotificationEmail } from '../../server/utils/email';

const PAYLOAD = '<a href="https://evil.example/reset">Reset password</a>';

describe('email templates escape the values they interpolate', () => {
  test('the test email escapes its recipient', () => {
    const { html } = renderTestEmail(`x<victim@corp.example>${PAYLOAD}`);
    expect(html).not.toContain(PAYLOAD);
    expect(html).toContain('&lt;a href=&quot;https://evil.example/reset&quot;&gt;');
  });

  test('the invite email escapes who sent it', () => {
    expect(renderInviteEmail('token', PAYLOAD).html).not.toContain(PAYLOAD);
  });

  test('the run email escapes the reported status', () => {
    const { html } = renderNotificationEmail('run.finished', {
      projectId: 1,
      projectName: 'Alpha',
      runId: 1,
      status: PAYLOAD,
      totalTests: 1,
      failedTests: 0,
      passedTests: 1,
      flakyTests: 0,
    });
    expect(html).not.toContain(PAYLOAD);
  });
});
