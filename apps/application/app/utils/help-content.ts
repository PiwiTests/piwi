/**
 * The inline-help registry lives in `#shared/help-content` so the server can
 * read it too. This re-export keeps it auto-imported in the app.
 */
export { HELP_TOPICS, helpEnvVars } from '#shared/help-content';
export type { HelpTopic, HelpTopicKey } from '#shared/help-content';
