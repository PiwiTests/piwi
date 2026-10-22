/** The guide anchors of the settings pages (`/settings/…`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const SETTINGS_ANCHORS = [
  {
    id: 'notification-channels',
    pages: ['/settings/notifications'],
    describes:
      'The Notification channels card: where alerts go, such as email, a Slack or Microsoft Teams webhook, or a webhook of your own.',
    requires: { capability: 'notifications' },
    doc: 'features/notifications',
    sample: { route: '/settings/notifications' },
  },
];
