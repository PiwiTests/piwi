/** The demo's account-email channel: the visitor's own, always listed first and never sent to. */
export const DEMO_CHANNEL = {
  id: 1,
  name: 'Account email',
  type: 'personal_email',
  userId: null as number | null,
  verified: true,
  config: { address: 'demo@example.com' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
