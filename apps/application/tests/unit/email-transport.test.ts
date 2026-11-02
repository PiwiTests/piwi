import { describe, test, expect, vi, afterEach } from 'vitest';

const mail = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], sent: 0 }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      mail.options.push(options);
      return {
        sendMail: async () => {
          mail.sent++;
        },
      };
    },
  },
}));

const { sendEmail } = await import('../../server/utils/email');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the SMTP transport', () => {
  test('gives up on a server that does not connect, greet or answer within 30 seconds', async () => {
    vi.stubEnv('PIWI_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('PIWI_SMTP_FROM', 'piwi@example.com');
    vi.stubEnv('PIWI_SITE_URL', 'https://piwi.example.com');

    await sendEmail({ to: 'dev@example.com', subject: 'Run failed', html: '<p>x</p>', text: 'x' });

    expect(mail.sent).toBe(1);
    const [options] = mail.options;
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(options![key]).toBeGreaterThanOrEqual(10_000);
      expect(options![key]).toBeLessThanOrEqual(30_000);
    }
  });
});
