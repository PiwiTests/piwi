/**
 * The assistant's `explain_setting` tool: one field of the Settings pages
 * (`SETTINGS_PAGES`) with its help (`HELP_TOPICS`), its docs page, the
 * `PIWI_*` variables that override it, and the guide anchor that points at
 * it. Which of those variables the server's environment sets, and the field's
 * current value, go only to a user who may open the field's page, as its own
 * endpoints do; a value is reported only where one of those endpoints returns
 * it, and a secret never, only whether it is set. A variable's value is never
 * reported.
 */
import { GUIDE_ANCHORS } from '#shared/guide-anchors/index.mjs';
import { HELP_TOPICS, type HelpTopic } from '#shared/help-content';
import { SETTINGS_PAGES, type SettingFieldMeta, type SettingsPageMeta } from '#shared/settings-metadata';
import { PIWI_ENV_VARS } from '#shared/piwi-env-vars';
import { docsUrl } from '#shared/docs';
import { can } from '#shared/permissions';
import { resolveCiCost } from '#shared/handlers/ci-cost';
import type { AiModelRole } from '~~/types/api';
import type { DbClient } from '../../database';
import type { AiToolDef } from '../ai-tool-calls';
import { readAiSettings } from '../ai-settings';
import { isAuthEnabled } from '../auth';
import { getSmtpConfig } from '../email';
import { resolveLocaleSettings } from '../locale-settings';
import type { McpContext } from '../mcp/tools';

export const EXPLAIN_SETTING: AiToolDef = {
  name: 'explain_setting',
  description:
    'Explain one field of the Settings pages by its id (ai.diagnosis, ai.scm-token, localization.time-zone, ci-cost, …): its label and page, its help text and docs page, the PIWI_* variables that override it and which of them the environment sets now, its current value when the user may read it (never a secret: only whether it is set), and its guide anchor for show_guide. An unknown id answers with the list of field ids.',
  inputSchema: {
    type: 'object',
    properties: { fieldId: { type: 'string', description: 'The field id, e.g. "ai.assistant"' } },
    required: ['fieldId'],
  },
};

/** What a field's endpoint returns now: its value, or for a secret only whether it is set. */
type FieldReading = { value: unknown } | { set: boolean };

/** An AI role as Settings → AI shows it: its provider and model, or the role whose provider it reuses. Never its key. */
const aiRole =
  (role: AiModelRole) =>
  async (db: DbClient): Promise<FieldReading> => {
    const settings = (await readAiSettings(db)).roles[role];
    if (!settings) return { set: false };
    const { provider, model, reuse } = settings;
    return { value: { provider, model, ...(reuse ? { reuse } : {}) } };
  };

/** The fields whose value an endpoint of their page returns, read the way that endpoint reads it. */
const READERS: Readonly<Record<string, (db: DbClient, ctx: McpContext) => Promise<FieldReading>>> = {
  'account.display-name': async (_db, ctx) => (ctx.user ? { value: ctx.user.name ?? null } : { set: false }),
  'account.email': async (_db, ctx) => (ctx.user ? { value: ctx.user.email ?? null } : { set: false }),
  'account.auth-toggle': async () => ({ value: isAuthEnabled() ? 'on' : 'off' }),
  'localization.format': async (db) => ({ value: (await resolveLocaleSettings(db)).locale }),
  'localization.time-zone': async (db) => ({ value: (await resolveLocaleSettings(db)).timeZone }),
  'notifications.smtp': async () => ({ set: getSmtpConfig().configured }),
  'ci-cost': async (db) => ({ value: (await resolveCiCost(db)).cost }),
  'ai.diagnosis': aiRole('diagnosis'),
  'ai.research': aiRole('research'),
  'ai.embedding': aiRole('embedding'),
  'ai.assistant': aiRole('assistant'),
  'ai.auto-diagnose': async (db) => ({ value: (await readAiSettings(db)).autoDiagnose }),
  'ai.instructions': async (db) => {
    const text = (await readAiSettings(db)).customInstructions;
    return text ? { value: text.slice(0, 500) } : { set: false };
  },
  // A secret: only whether one is stored.
  'ai.scm-token': async (db) => ({ set: (await readAiSettings(db)).hasScmToken }),
};

function findField(fieldId: string): { page: SettingsPageMeta; field: SettingFieldMeta } | null {
  for (const page of SETTINGS_PAGES) {
    const field = page.fields.find((f) => f.id === fieldId);
    if (field) return { page, field };
  }
  return null;
}

const isSet = (name: string) => Boolean(process.env[name]?.trim());

/** One field explained for this user; for an unknown id, the ids of every field. */
export async function explainSetting(db: DbClient, ctx: McpContext, fieldId: string): Promise<unknown> {
  const found = findField(fieldId.trim());
  if (!found) {
    return {
      note: `No settings field has the id "${fieldId}"; call again with one of these.`,
      fields: SETTINGS_PAGES.flatMap((p) => p.fields.map((f) => f.id)),
    };
  }
  const { page, field } = found;
  const topic: HelpTopic = HELP_TOPICS[field.help];
  const variables = topic.envVars ?? [];
  const anchor = GUIDE_ANCHORS.find((a) => a.kind === 'field' && a.pages.includes(page.to) && a.help === field.help);
  const readable = !page.permission || can(ctx.access, page.permission);
  const hidden = `shown to those who can open ${page.label} (it needs ${page.permission})`;

  let current: Record<string, unknown>;
  if (!readable) current = { valueNote: hidden };
  else {
    const reader = READERS[field.id];
    const reading = reader ? await reader(db, ctx).catch(() => null) : null;
    current = reading
      ? reading
      : { valueNote: reader ? 'it could not be read' : `not read by this tool; ${page.label} shows it` };
  }

  return {
    id: field.id,
    label: field.label,
    page: { label: page.label, route: page.to },
    ...(topic.title ? { title: topic.title } : {}),
    help: topic.text,
    ...(topic.doc ? { docs: docsUrl(topic.doc) } : {}),
    ...(field.envOnly ? { envOnly: 'set by environment variables only; the page shows it read-only' } : {}),
    variables: variables.map((name) => ({ name, description: PIWI_ENV_VARS[name].description.slice(0, 240) })),
    ...(variables.length
      ? {
          environment: readable ? { managed: variables.some(isSet), set: variables.filter(isSet) } : hidden,
        }
      : {}),
    ...current,
    ...(anchor ? { anchor: anchor.id } : {}),
  };
}
