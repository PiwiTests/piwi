/** The guide anchors of the settings pages (`/settings/…`): the menu beside them, then each page in the menu's order. */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const SETTINGS_ANCHORS = [
  {
    id: 'settings-nav',
    kind: 'page',
    pages: ['/settings'],
    describes:
      'The Settings menu beside every settings page: the Instance and Analysis pages you may open, then About.',
    shownWhen: 'On a wide screen; a narrow one picks the page from a list above it instead.',
    doc: 'features/ui-overview#settings',
    sample: { route: '/settings' },
  },

  // Account
  {
    id: 'account-page',
    kind: 'page',
    pages: ['/settings/account'],
    describes:
      'Settings → Account: your display name, email address, password and API keys, which you manage once authentication is on.',
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/account' },
  },
  {
    id: 'account-display-name',
    kind: 'field',
    pages: ['/settings/account'],
    describes: 'The Display name card: an optional friendly name shown with your account inside the dashboard.',
    shownWhen: 'When authentication is on.',
    help: 'account.display-name',
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/account' },
  },
  {
    id: 'account-email',
    kind: 'field',
    pages: ['/settings/account'],
    describes:
      'The Email address card: where password resets and notifications go, whether it is verified, and a button to send the verification again.',
    shownWhen: 'When authentication is on.',
    help: 'account.email',
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/account' },
  },
  {
    id: 'account-password',
    kind: 'field',
    pages: ['/settings/account'],
    describes: 'The Change password card: your current password, then the new one twice, at least 8 characters long.',
    shownWhen: 'When authentication is on and the account has a password, not only a Google or GitHub sign-in.',
    help: 'account.password',
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/account' },
  },
  {
    id: 'account-api-keys',
    kind: 'field',
    pages: ['/settings/account'],
    describes:
      'Your API keys: the pd_ tokens the reporter and scripts sign in with, each shown once when created and revocable at any time.',
    shownWhen: 'When authentication is on.',
    help: 'settings.api-keys',
    doc: 'operate/api-keys',
    sample: { route: '/settings/account' },
  },
  {
    id: 'create-api-key',
    kind: 'action',
    pages: ['/settings/account', '/settings/users'],
    describes:
      'The Create API key button, which asks for a name and an optional expiry date, then shows the new key once with the reporter config using it.',
    shownWhen: 'When authentication is on.',
    doc: 'operate/api-keys#creating-an-api-key',
    sample: { route: '/settings/account' },
  },

  // Localization
  {
    id: 'localization-page',
    kind: 'page',
    pages: ['/settings/localization'],
    describes:
      'Settings → Localization: the date and time format and the time zone you see, and the instance default for everyone else.',
    doc: 'operate/localization',
    sample: { route: '/settings/localization' },
  },
  {
    id: 'localization-format',
    kind: 'field',
    pages: ['/settings/localization'],
    describes:
      'Your date and time format: the locale deciding day/month order and 12- or 24-hour time, saved in this browser and applied at once.',
    help: 'settings.locale',
    doc: 'operate/localization#date-and-time-format',
    sample: { route: '/settings/localization' },
  },
  {
    id: 'localization-time-zone',
    kind: 'field',
    pages: ['/settings/localization'],
    describes: 'Your time zone: the zone times are shown in for you, Automatic following this browser’s own.',
    help: 'settings.time-zone',
    doc: 'operate/localization#time-zone',
    sample: { route: '/settings/localization' },
  },
  {
    id: 'localization-instance-default',
    kind: 'block',
    pages: ['/settings/localization'],
    describes:
      'The Instance default card: the format and time zone everyone gets until they pick their own, unless an environment variable pins them.',
    requires: { permission: 'settings:manage' },
    help: 'settings.locale',
    doc: 'operate/localization#who-sets-what',
    sample: { route: '/settings/localization' },
  },

  // Users
  {
    id: 'users-page',
    kind: 'page',
    pages: ['/settings/users'],
    describes:
      'Settings → Users: every account with its instance role and groups, where an administrator adds users and manages their keys and roles.',
    requires: { permission: 'users:manage' },
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/users' },
  },
  {
    id: 'users-list',
    kind: 'field',
    pages: ['/settings/users'],
    describes:
      'The Users table: each account with its instance role, Administrator or Member, its groups and when it was created.',
    shownWhen: 'When the instance has at least one user.',
    requires: { permission: 'users:manage' },
    help: 'settings.users',
    doc: 'operate/authentication#roles',
    sample: { route: '/settings/users' },
  },
  {
    id: 'user-row-actions',
    kind: 'field',
    pages: ['/settings/users'],
    describes:
      'A user’s actions in the Users table: send an invite, edit their project roles, manage their API keys or delete them.',
    shownWhen: 'When the instance has at least one user.',
    requires: { permission: 'users:manage' },
    help: 'settings.api-keys',
    doc: 'operate/api-keys',
    sample: { route: '/settings/users' },
  },
  {
    id: 'add-user',
    kind: 'action',
    pages: ['/settings/users'],
    describes:
      'The Add user button: a username, an optional password (left blank, the user gets an invite email), the instance role and groups.',
    shownWhen: 'When the instance has at least one user.',
    requires: { permission: 'users:manage' },
    doc: 'operate/authentication#user-management',
    sample: { route: '/settings/users' },
  },

  // Groups
  {
    id: 'groups-page',
    kind: 'page',
    pages: ['/settings/groups'],
    describes:
      'Settings → Groups: the named sets of users, such as QA, that receive project roles for all their members.',
    requires: { permission: 'groups:manage' },
    doc: 'operate/project-access#groups',
    sample: { route: '/settings/groups' },
  },
  {
    id: 'groups-list',
    kind: 'field',
    pages: ['/settings/groups'],
    describes:
      'The Groups table: each group with its description and members, to edit or delete; its roles are set on the permission grid.',
    requires: { permission: 'groups:manage' },
    help: 'settings.groups',
    doc: 'operate/project-access#groups',
    sample: { route: '/settings/groups' },
  },
  {
    id: 'add-group',
    kind: 'action',
    pages: ['/settings/groups'],
    describes:
      'The Add group button: a name, an optional description and the members, who then hold the group’s roles.',
    shownWhen: 'When the instance has at least one group.',
    requires: { permission: 'groups:manage' },
    doc: 'operate/project-access#groups',
    sample: { route: '/settings/groups' },
  },

  // Permissions
  {
    id: 'permissions-page',
    kind: 'page',
    pages: ['/settings/permissions'],
    describes: 'Settings → Permissions: the grid of project roles every user and group holds on every project.',
    requires: { permission: 'users:manage' },
    doc: 'operate/project-access#permission-grid',
    sample: { route: '/settings/permissions' },
  },
  {
    id: 'permission-grid',
    kind: 'field',
    pages: ['/settings/permissions'],
    describes:
      'The permission grid: every user and group against every project and All projects, where picking a role in a cell grants it at once.',
    requires: { permission: 'users:manage' },
    help: 'settings.permissions',
    doc: 'operate/project-access#permission-grid',
    sample: { route: '/settings/permissions' },
  },

  // Roles
  {
    id: 'roles-page',
    kind: 'page',
    pages: ['/settings/roles'],
    describes:
      'Settings → Roles: what each project role and the Administrator role allow, read-only and open to everyone.',
    doc: 'operate/project-access#what-each-role-can-do',
    sample: { route: '/settings/roles' },
  },
  {
    id: 'project-roles-matrix',
    kind: 'field',
    pages: ['/settings/roles'],
    describes:
      'The Project roles card: Viewer, Contributor, Maintainer, Project admin and Uploader, and each permission every role holds.',
    help: 'settings.roles',
    doc: 'operate/project-access#what-each-role-can-do',
    sample: { route: '/settings/roles' },
  },
  {
    id: 'administrator-role',
    kind: 'block',
    pages: ['/settings/roles'],
    describes:
      'The Administrator card: the instance role granted on a user’s row in Users, never through a group, and the permissions it alone holds.',
    doc: 'operate/authentication#roles',
    sample: { route: '/settings/roles' },
  },

  // Notifications
  {
    id: 'notifications-page',
    kind: 'page',
    pages: ['/settings/notifications'],
    describes:
      'Settings → Notifications: whether email can send, the channels alerts go to, and the subscriptions deciding which events reach them.',
    requires: { capability: 'notifications' },
    doc: 'features/notifications',
    sample: { route: '/settings/notifications' },
  },
  {
    id: 'smtp-email-delivery',
    kind: 'field',
    pages: ['/settings/notifications'],
    describes:
      'The SMTP email delivery card: whether outbound email is configured, and the environment variables that configure it.',
    requires: { capability: 'notifications' },
    help: 'settings.smtp',
    doc: 'features/notifications#smtp-configuration',
    sample: { route: '/settings/notifications' },
  },
  {
    id: 'notification-channels',
    kind: 'field',
    pages: ['/settings/notifications'],
    describes:
      'The Notification channels card: where alerts go, such as email, Slack, a Microsoft Teams webhook, or a webhook of your own.',
    requires: { capability: 'notifications' },
    help: 'notifications.channels',
    doc: 'features/notifications#channels',
    sample: { route: '/settings/notifications' },
  },
  {
    id: 'add-notification-channel',
    kind: 'action',
    pages: ['/settings/notifications'],
    describes:
      'The Add channel button, which opens the form for a new email, Slack, Microsoft Teams, webhook or browser channel.',
    requires: { capability: 'notifications' },
    doc: 'features/notifications#channels',
    sample: { route: '/settings/notifications' },
  },
  {
    id: 'notification-channel-form',
    kind: 'block',
    pages: ['/settings/notifications'],
    reveal: [{ open: 'add-notification-channel' }],
    describes:
      'The New channel form: the type, name and destination, the steps to get a Slack webhook or bot token or a Teams webhook URL, and a test send.',
    shownWhen: 'Once Add channel is clicked.',
    requires: { capability: 'notifications' },
    help: 'notifications.teams',
    doc: 'features/notifications#channels',
    sample: { route: '/settings/notifications' },
  },
  {
    id: 'notification-subscriptions',
    kind: 'field',
    pages: ['/settings/notifications'],
    describes:
      'The Subscriptions card: which events notify which channel, for one project or all, with their filters, to mute or remove.',
    requires: { capability: 'notifications' },
    help: 'notifications.subscriptions',
    doc: 'features/notifications#subscriptions',
    sample: { route: '/settings/notifications' },
  },

  // Tags
  {
    id: 'tags-page',
    kind: 'page',
    pages: ['/settings/tags'],
    describes: 'Settings → Tags: the labels you attach to projects to group and filter them across the dashboard.',
    requires: { capability: 'tags', permission: 'tags:manage' },
    doc: 'features/ui-overview#settings',
    sample: { route: '/settings/tags' },
  },
  {
    id: 'tags-list',
    kind: 'field',
    pages: ['/settings/tags'],
    describes: 'The Tags table: each tag with its color and creation date, to edit or delete.',
    shownWhen: 'When the instance has at least one tag.',
    requires: { capability: 'tags', permission: 'tags:manage' },
    help: 'settings.tags',
    doc: 'features/ui-overview#settings',
    sample: { route: '/settings/tags' },
  },
  {
    id: 'add-tag',
    kind: 'action',
    pages: ['/settings/tags'],
    describes: 'The Add tag button: the tag’s text and color, with a preview of the badge.',
    shownWhen: 'When the instance has at least one tag.',
    requires: { capability: 'tags', permission: 'tags:manage' },
    doc: 'features/ui-overview#settings',
    sample: { route: '/settings/tags' },
  },

  // Integrations
  {
    id: 'integrations-page',
    kind: 'page',
    pages: ['/settings/integrations'],
    describes:
      'Settings → Integrations: the issue tracker connections every project files issues through and pinned links unfurl with.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    doc: 'operate/integrations',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'integration-connections',
    kind: 'field',
    pages: ['/settings/integrations'],
    describes:
      'The Jira card: the instance’s Jira connections, with Sync now to read the status of every linked issue due for a refresh.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    help: 'settings.integrations',
    doc: 'operate/integrations',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'integration-connection',
    kind: 'row',
    pages: ['/settings/integrations'],
    describes:
      'A connection: its status, site, account and token expiry, with Test connection, Edit, Remove, the Jira webhook and its recent activity.',
    shownWhen: 'When the instance has a connection.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    doc: 'operate/integrations#status-sync',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'test-integration-connection',
    kind: 'action',
    pages: ['/settings/integrations'],
    describes:
      'The Test connection button, which signs in with the stored token and names the account, or says why it failed.',
    shownWhen: 'When the instance has a connection.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    doc: 'operate/integrations#permissions-the-token-needs',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'connect-integration',
    kind: 'action',
    pages: ['/settings/integrations'],
    describes:
      'The Connect Jira button, which opens the form that checks the site and the API token before saving a connection.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    doc: 'operate/integrations#connecting-jira-cloud',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'jira-connection-form',
    kind: 'field',
    pages: ['/settings/integrations'],
    reveal: [{ open: 'connect-integration' }],
    describes:
      'The Connect Jira form: the site, the API token type, the account email and token, checked against Jira before anything is saved.',
    shownWhen: 'Once Connect Jira or a connection’s Edit is clicked.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    help: 'settings.integrations.connection',
    doc: 'operate/integrations#connecting-jira-cloud',
    sample: { route: '/settings/integrations' },
  },
  {
    id: 'integration-private-host',
    kind: 'block',
    pages: ['/settings/integrations'],
    describes:
      'The note under the Jira card: a connection’s base URL is trusted as an administrator’s, so a self-hosted tracker on a private host works.',
    requires: { capability: 'integrations', permission: 'connections:manage' },
    help: 'settings.integrations.private-host',
    doc: 'operate/integrations#trusted-base-urls-and-private-hosts',
    sample: { route: '/settings/integrations' },
  },

  // Storage
  {
    id: 'storage-page',
    kind: 'page',
    pages: ['/settings/storage'],
    describes:
      'Settings → Storage: where the database and files live, the storage backend, how much space runs use, and the cleanup of old runs.',
    requires: { permission: 'storage:manage' },
    doc: 'operate/storage#storage-management',
    sample: { route: '/settings/storage' },
  },
  {
    id: 'storage-data-location',
    kind: 'block',
    pages: ['/settings/storage'],
    describes:
      'The Data location card: the paths of this instance’s database and stored files on disk, each with a copy button.',
    requires: { permission: 'storage:manage' },
    doc: 'operate/storage#local-storage-default',
    sample: { route: '/settings/storage' },
  },
  {
    id: 'storage-backend',
    kind: 'field',
    pages: ['/settings/storage'],
    describes:
      'The Storage backend card: the environment variables choosing local disk or S3 for reports, traces and attachments, shown read-only.',
    requires: { permission: 'storage:manage' },
    help: 'settings.storage-backend',
    doc: 'operate/storage#storage-architecture',
    sample: { route: '/settings/storage' },
  },
  {
    id: 'storage-usage',
    kind: 'field',
    pages: ['/settings/storage'],
    describes:
      'The Storage usage card: the total stored, the number of projects holding data and the largest one, above the charts by time, kind and project.',
    requires: { permission: 'storage:manage' },
    help: 'settings.storage-stats',
    doc: 'operate/storage#storage-management',
    sample: { route: '/settings/storage' },
  },
  {
    id: 'storage-cleanup',
    kind: 'field',
    pages: ['/settings/storage'],
    describes:
      'The Cleanup old test runs card: deletes the runs older than an age you pick, with their reports and traces, skipping kept runs.',
    requires: { permission: 'storage:manage' },
    help: 'settings.cleanup',
    doc: 'operate/storage#storage-management',
    sample: { route: '/settings/storage' },
  },
  {
    id: 'run-storage-cleanup',
    kind: 'action',
    pages: ['/settings/storage'],
    describes:
      'The Run cleanup button, which asks to confirm before it permanently deletes the runs older than the age picked.',
    requires: { permission: 'storage:manage' },
    doc: 'operate/storage#data-retention',
    sample: { route: '/settings/storage' },
  },

  // Performance
  {
    id: 'performance-page',
    kind: 'page',
    pages: ['/settings/performance'],
    describes:
      'Settings → Performance: which waits count as wasted time, the timeout hygiene thresholds, and what a CI minute costs.',
    requires: { permission: 'settings:manage' },
    doc: 'features/slow-tests',
    sample: { route: '/settings/performance' },
  },
  {
    id: 'wasted-time-patterns',
    kind: 'field',
    pages: ['/settings/performance'],
    describes:
      'The Wasted-time patterns card: the glob patterns, one per line, that mark a wait step as wasted by its title or source location.',
    requires: { permission: 'settings:manage' },
    help: 'settings.wasted-time',
    doc: 'features/slow-tests',
    sample: { route: '/settings/performance' },
  },
  {
    id: 'timeout-hygiene-thresholds',
    kind: 'field',
    pages: ['/settings/performance'],
    describes:
      'The Timeout hygiene card: the minimum runs, oversize factor and headroom that flag an oversized timeout or a stale test.slow() mark.',
    requires: { permission: 'settings:manage' },
    help: 'settings.timeout-hygiene',
    doc: 'features/slow-tests#timeout-opportunities',
    sample: { route: '/settings/performance' },
  },
  {
    id: 'ci-minute-cost',
    kind: 'field',
    pages: ['/settings/performance'],
    describes:
      'The Cost of a CI minute card: an amount and currency that turn wasted CI minutes into money in analytics and quality reports.',
    requires: { permission: 'settings:manage' },
    help: 'settings.ci-cost',
    doc: 'features/quality-reports#cost-of-a-ci-minute',
    sample: { route: '/settings/performance' },
  },

  // Pull requests
  {
    id: 'pr-feedback-page',
    kind: 'page',
    pages: ['/settings/pr-feedback'],
    describes:
      'Settings → Pull requests: whether a finished run posts its result back to the branch’s open pull request.',
    requires: { capability: 'pr-feedback', permission: 'settings:manage' },
    doc: 'features/pr-feedback#turn-it-on',
    sample: { route: '/settings/pr-feedback' },
  },
  {
    id: 'pr-feedback-settings',
    kind: 'field',
    pages: ['/settings/pr-feedback'],
    describes:
      'The Pull-request feedback card: post a summary comment, set a commit status, comment only on failures, and the status’s name.',
    requires: { capability: 'pr-feedback', permission: 'settings:manage' },
    help: 'settings.pr-feedback',
    doc: 'features/pr-feedback#turn-it-on',
    sample: { route: '/settings/pr-feedback' },
  },
  {
    id: 'save-pr-feedback',
    kind: 'action',
    pages: ['/settings/pr-feedback'],
    describes: 'The Save button of the pull-request feedback settings.',
    requires: { capability: 'pr-feedback', permission: 'settings:manage' },
    doc: 'features/pr-feedback#turn-it-on',
    sample: { route: '/settings/pr-feedback' },
  },

  // Auto-heal
  {
    id: 'auto-heal-page',
    kind: 'page',
    pages: ['/settings/auto-heal'],
    describes:
      'Settings → Auto-heal: whether Piwi opens the pull request fixing a broken locator itself, and on which projects.',
    requires: { capability: 'auto-heal', permission: 'settings:manage' },
    doc: 'features/auto-heal#enable-it',
    sample: { route: '/settings/auto-heal' },
  },
  {
    id: 'auto-heal-settings',
    kind: 'field',
    pages: ['/settings/auto-heal'],
    describes:
      'The Auto-heal pull requests card: the projects it acts on, the minimum score, drafts, the open-PR ceiling, branch prefix and commit message.',
    requires: { capability: 'auto-heal', permission: 'settings:manage' },
    help: 'settings.auto-heal',
    doc: 'features/auto-heal#enable-it',
    sample: { route: '/settings/auto-heal' },
  },
  {
    id: 'save-auto-heal',
    kind: 'action',
    pages: ['/settings/auto-heal'],
    describes: 'The Save button of the auto-heal settings.',
    requires: { capability: 'auto-heal', permission: 'settings:manage' },
    doc: 'features/auto-heal#enable-it',
    sample: { route: '/settings/auto-heal' },
  },

  // AI
  {
    id: 'ai-page',
    kind: 'page',
    pages: ['/settings/ai'],
    describes:
      'Settings → AI: the model behind each AI role, usage, the repository token, instructions, language and context limits.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    doc: 'guide/ai-provider',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-model-providers',
    kind: 'block',
    pages: ['/settings/ai'],
    describes:
      'The Model providers card: the diagnosis, research, embedding and assistant models, then auto-diagnose and diagnosis notifications.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-provider',
    doc: 'guide/ai-provider#model-roles',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-diagnosis-model',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Diagnosis model: the provider, API key and model that write the final diagnosis, required before any AI feature works.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-provider',
    doc: 'guide/ai-provider#model-roles',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-research-model',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Research model: an optional cheaper model that pre-analyzes a failure before the diagnosis model, and names and merges clusters.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-research',
    doc: 'guide/ai-provider#model-roles',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-embedding-model',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Embedding model: an optional OpenAI-compatible embeddings model that groups failures with similar errors into one cluster.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.embedding-model',
    doc: 'guide/ai-provider#model-roles',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-assistant-model',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Assistant model: an optional model the in-app assistant answers with, such as a faster, cheaper one; off, it uses the diagnosis model.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-assistant',
    doc: 'features/assistant#the-model',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'test-ai-connection',
    kind: 'action',
    pages: ['/settings/ai'],
    describes:
      'A model role’s Test connection button, which calls its provider with the model and key entered and says whether it answered.',
    shownWhen: 'When the role has a provider of its own or reuses one.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    doc: 'guide/ai-provider#providers',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-auto-diagnose',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Auto-diagnose switch: when a run finishes, diagnose up to 3 of its new failure clusters and title the new clusters.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.auto-diagnose',
    doc: 'guide/ai-provider#enabling-ai-diagnosis',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-diagnosis-notifications',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Diagnosis notifications switch: a browser notification when a diagnosis finishes, set for this browser only.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-notifications',
    doc: 'guide/ai-provider#streaming-diagnosis',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'save-ai-providers',
    kind: 'action',
    pages: ['/settings/ai'],
    describes:
      'The Save button of the Model providers card, which stores every role’s provider, key and model, and auto-diagnose.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    doc: 'guide/ai-provider#enabling-ai-diagnosis',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-usage',
    kind: 'block',
    pages: ['/settings/ai'],
    describes:
      'The AI usage card: diagnoses, assistant answers and tokens per model over 7, 30 or 90 days, and how each model’s diagnoses fared.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    doc: 'guide/ai-provider#usage-and-quality',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-repository-access',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Repository access card: the GitHub, GitLab or Bitbucket token diagnosis reads commit diffs with, which a project’s own token overrides.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'project.scm-token',
    doc: 'guide/source-control',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-instructions',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Global analysis instructions: guidance added to every diagnosis on every project, such as house style or what to always check.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-instructions',
    doc: 'features/ai-diagnosis#custom-instructions',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-response-language',
    kind: 'block',
    pages: ['/settings/ai'],
    describes:
      'The Response language card: the language the AI writes its prose in, with code, locators and error text kept verbatim; blank is English.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    doc: 'guide/ai-provider#response-language',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-context-limits',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Diagnosis context limits: caps on how much evidence goes into a diagnosis, trading what the model sees against tokens spent.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.ai-limits',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
    sample: { route: '/settings/ai' },
  },
  {
    id: 'ai-privacy-notice',
    kind: 'field',
    pages: ['/settings/ai'],
    describes:
      'The Privacy notice: what a diagnosis sends to the model provider, from the error and test steps to diffs, and how API keys are stored.',
    requires: { capability: 'ai', permission: 'settings:manage' },
    help: 'settings.privacy',
    doc: 'features/ai-diagnosis#what-a-diagnosis-contains',
    sample: { route: '/settings/ai' },
  },

  // About
  {
    id: 'about-page',
    kind: 'page',
    pages: ['/settings/about'],
    describes:
      'Settings → About: the version this instance runs, its build and build date, then its Node.js version, database and docs links.',
    doc: 'operate/upgrading#verifying-the-upgrade-landed',
    sample: { route: '/settings/about' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const SETTINGS_EXEMPTIONS = [
  {
    rule: 'field',
    key: 'account.connected-accounts',
    reason:
      'The card lists the OAuth providers the operator configured, and the demo configures none, so no sample renders it.',
  },
  {
    rule: 'help',
    key: 'account.connected-accounts',
    reason:
      'It is set on the Connected accounts card, which the demo never renders since it configures no OAuth provider.',
  },
  {
    rule: 'field',
    key: 'account.auth-toggle',
    reason:
      'The notice shows only while authentication is off, and the demo always runs with it on, so no sample renders it.',
  },
  {
    rule: 'help',
    key: 'settings.auth-toggle',
    reason:
      'It is set on the Authentication disabled notice, which the demo never shows since it always runs with authentication on.',
  },
  {
    rule: 'field',
    key: 'notifications.test-email',
    reason:
      'The test email row shows only once SMTP is configured, and the demo has no email delivery, so no sample renders it.',
  },
  {
    rule: 'help',
    key: 'notifications.test-email',
    reason: 'It is set on the test email row, which the demo never renders since it has no SMTP configured.',
  },
];
