import { desc, eq } from 'drizzle-orm';
import { notificationChannels } from '~~/server/database/schema';
import { sanitizeChannelConfig } from '~~/server/utils/channels';
import { CHANNEL_TYPES, channelConfigProblem, type ChannelType } from '#shared/notifications/channel-setup';
import { loadReportChannels, type ReportChannel } from '#shared/handlers/reports';
import type { DrizzleDB } from '#shared/handlers/db';
import { DEMO_CHANNEL } from './demo-channel';
import { demoHttpError } from './http-error';

/**
 * The demo's notification channels: the visitor's account email, plus the
 * channels added in the demo, stored in the in-browser database like every
 * other demo write. Every channel is global, as on a server without
 * authentication. Nothing is ever sent, so no secret is stored: a channel
 * keeps only the config fields the server would return.
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
      config: sanitizeChannelConfig(config as Record<string, unknown>),
      userId: null,
      verified: false,
    })
    .returning();
  return { success: true, channel: toDemoChannel(row!) };
}

/** Delete a channel added in the demo; the account email stays, as the server keeps a personal email channel. */
export async function deleteDemoChannel(db: DrizzleDB, id: number): Promise<{ success: true }> {
  if (id === DEMO_CHANNEL.id) {
    throw demoHttpError(
      400,
      'Cannot delete your personal email channel. Remove your email in Account settings to disconnect it.',
    );
  }
  const deleted = await db
    .delete(notificationChannels)
    .where(eq(notificationChannels.id, id))
    .returning({ id: notificationChannels.id });
  if (!deleted.length) throw demoHttpError(404, 'Channel not found');
  return { success: true };
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
