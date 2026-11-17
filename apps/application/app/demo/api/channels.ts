import { desc, eq } from 'drizzle-orm';
import { notificationChannels } from '~~/server/database/schema';
import { sanitizeChannelConfig } from '~~/server/utils/channels';
import {
  CHANNEL_TYPES,
  channelConfigProblem,
  slackDelivery,
  type ChannelType,
} from '#shared/notifications/channel-setup';
import {
  deleteCredentialIfUnused,
  freeCredentialName,
  insertCredential,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { SLACK_API_ENDPOINT } from '#shared/credentials';
import { loadReportChannels, type ReportChannel } from '#shared/handlers/reports';
import type { DrizzleDB } from '#shared/handlers/db';
import { DEMO_CHANNEL } from './demo-channel';
import { demoHttpError } from './http-error';

/**
 * The demo's notification channels: the visitor's account email, plus the
 * channels added in the demo, stored in the in-browser database like every
 * other demo write. Every channel is global, as on a server without
 * authentication. Nothing is ever sent, so no secret is stored: a channel
 * keeps only the config fields the server would return. A Slack channel
 * posting through the Web API names a Slack credential, as the server's
 * channels of the instance do: the saved one picked, or one made for its
 * token, which holds no secret here.
 */

export interface DemoChannel {
  id: number;
  name: string;
  type: string;
  userId: number | null;
  verified: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toDemoChannel(row: typeof notificationChannels.$inferSelect): DemoChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    userId: row.userId,
    verified: row.verified,
    config: sanitizeChannelConfig((row.config ?? {}) as Record<string, unknown>),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function listDemoChannels(db: DrizzleDB): Promise<DemoChannel[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.id);
  return [DEMO_CHANNEL, ...rows.map(toDemoChannel)];
}

/** Validate a new channel as the server's route does, and store it. */
export async function createDemoChannel(
  db: DrizzleDB,
  body: unknown,
): Promise<{ success: true; channel: DemoChannel }> {
  const b = (body ?? {}) as { name?: unknown; type?: unknown; config?: unknown };
  const name = typeof b.name === 'string' ? b.name : '';
  const config = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : null;
  if (!name || !(CHANNEL_TYPES as readonly unknown[]).includes(b.type) || !config) {
    throw demoHttpError(400, 'Invalid request body');
  }
  const type = b.type as ChannelType;
  const problem = channelConfigProblem(type, config as Record<string, unknown>);
  if (problem) throw demoHttpError(400, problem);
  let stored = sanitizeChannelConfig(config as Record<string, unknown>);
  if (type === 'slack' && slackDelivery(config as Record<string, unknown>) === 'api') {
    const picked = (config as Record<string, unknown>).credentialId;
    let credentialId: number;
    if (typeof picked === 'number') {
      const record = await loadCredentialRecord(db, picked);
      if (record?.service !== 'slack' || !record.allProjects)
        throw demoHttpError(400, `No Slack credential ${picked} exists.`);
      credentialId = picked;
    } else {
      credentialId = await insertCredential(
        db,
        {
          name: await freeCredentialName(db, name),
          description: null,
          service: 'slack',
          user: null,
          destination: SLACK_API_ENDPOINT,
          scope: { allProjects: true },
          allowedInputs: null,
          customRequests: false,
          disabled: false,
        },
        null,
        null,
      );
    }
    stored = { credentialId, channelId: stored.channelId };
  }

  // Ids follow the account email's, which lives outside the table.
  const [last] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .orderBy(desc(notificationChannels.id))
    .limit(1);
  const [row] = await db
    .insert(notificationChannels)
    .values({
      id: Math.max(last?.id ?? 0, DEMO_CHANNEL.id) + 1,
      name,
      type,
      config: stored,
      userId: null,
      verified: false,
    })
    .returning();
  return { success: true, channel: toDemoChannel(row!) };
}

/**
 * Delete a channel added in the demo, and the credential it sent with when asked and nothing else names it; the
 * account email stays, as the server keeps a personal email channel.
 */
export async function deleteDemoChannel(
  db: DrizzleDB,
  id: number,
  deleteCredential = false,
): Promise<{ success: true; credentialDeleted: boolean }> {
  if (id === DEMO_CHANNEL.id) {
    throw demoHttpError(
      400,
      'Cannot delete your personal email channel. Remove your email in Account settings to disconnect it.',
    );
  }
  const deleted = await db
    .delete(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .returning({ id: notificationChannels.id, config: notificationChannels.config });
  if (!deleted.length) throw demoHttpError(404, 'Channel not found');
  const credentialId = (deleted[0]!.config as { credentialId?: unknown } | null)?.credentialId;
  const credentialDeleted =
    deleteCredential && typeof credentialId === 'number' ? await deleteCredentialIfUnused(db, credentialId) : false;
  return { success: true, credentialDeleted };
}

/** Every channel a report schedule can name, as the server's `loadReportChannels` lists them. */
export async function demoReportChannels(db: DrizzleDB): Promise<ReportChannel[]> {
  return [
    {
      id: DEMO_CHANNEL.id,
      name: DEMO_CHANNEL.name,
      type: DEMO_CHANNEL.type,
      userId: DEMO_CHANNEL.userId,
      address: DEMO_CHANNEL.config.address,
    },
    ...(await loadReportChannels(db)),
  ];
}
