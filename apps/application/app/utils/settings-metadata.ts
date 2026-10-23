/**
 * The Settings surface registry lives in `#shared/settings-metadata` so the
 * server can read it too. This re-export keeps it auto-imported in the app.
 */
export {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  buildSettingsNavSections,
  canOpenSettingsPath,
  fieldEnvVars,
  getSettingsPage,
  pageEnvVars,
} from '#shared/settings-metadata';
export type {
  SettingFieldMeta,
  SettingsGroupId,
  SettingsNavContext,
  SettingsNavItem,
  SettingsPageId,
  SettingsPageMeta,
} from '#shared/settings-metadata';
