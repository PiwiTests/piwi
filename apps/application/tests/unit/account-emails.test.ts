import { describe, test, expect } from 'vitest';
import { renderInviteEmail, renderPasswordResetEmail } from '../../server/utils/email';

describe('the invite and password reset emails name the username to sign in with', () => {
  test('the invite email names the username in its HTML and text bodies', () => {
    const { html, text } = renderInviteEmail('token', 'jane.doe', 'Admin');
    expect(html).toContain('Your username is <strong>jane.doe</strong>');
    expect(text).toContain('Your username is jane.doe.');
    expect(text).toContain('You were invited by Admin.');
  });

  test('the password reset email names the username in its HTML and text bodies', () => {
    const { html, text } = renderPasswordResetEmail('token', 'jane.doe');
    expect(html).toContain('Your username is <strong>jane.doe</strong>');
    expect(text).toContain('Your username is jane.doe.');
  });
});
