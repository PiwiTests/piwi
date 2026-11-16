/**
 * The bot token of a Slack channel of the instance as a credential (service
 * `slack`, sent to Slack's Web API): saving the token typed for a new channel,
 * checking a saved one picked instead, posting each message through
 * `withCredential` as one log row (`notification`), and the import of the
 * tokens the instance's channels held in their config. A personal channel
 * keeps its own token: its owner holds no right on the instance's credentials.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { notificationChannels } from '../../database/schema';
import type { DbClient } from '../../database';
import { decryptSecret, getEncryptionKey } from '../crypto';
import { freeName, sealCredentialSecret, withCredential, type CredentialActor } from '../credentials';
import { insertCredential, loadCredentialRecord } from '#shared/handlers/credentials';
import { isUnderBaseUrl } from '#shared/ci-server';
import { SLACK_API_ENDPOINT } from '#shared/credentials';
import { postSlackApiMessage, SLACK_POST_MESSAGE_URL } from './slack-api';

const INSTANCE: CredentialActor = { userId: null, apiKeyId: null };

/** The credential a channel's config names, or null for a channel that keeps its own token or posts by webhook. */
export function channelCredentialId(config: Record<string, unknown> | null | undefined): number | null {
  const id = config?.credentialId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/** Save the bot token typed for a new channel of the instance as a credential named after it. Returns its id. */
export async function saveSlackChannelCredential(
  db: DbClient,
  input: { name: string; token: string; createdBy: number | null },
): Promise<number> {
  return insertCredential(
    db,
    {
      name: await freeName(db, input.name),
      description: null,
      service: 'slack',
      user: null,
      destination: SLACK_API_ENDPOINT,
      scope: { allProjects: true },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    },
    sealCredentialSecret(SLACK_API_ENDPOINT, input.token),
    input.createdBy,
  );
}

/**
 * Why a channel of the instance cannot name this credential, or null: it must
 * hold a Slack token saved in the database, be shared with all projects (a
 * channel of the instance serves every project) and be sent to the Web API.
 */
export async function slackChannelCredentialProblem(db: DbClient, credentialId: number): Promise<string | null> {
  const record = await loadCredentialRecord(db, credentialId);
  if (!record || record.service !== 'slack' || record.managedBy !== 'db') {
    return `No Slack credential ${credentialId} exists.`;
  }
  if (!record.allProjects) return `The credential "${record.name}" is not shared with all projects.`;
  if (!isUnderBaseUrl(record.destination, SLACK_POST_MESSAGE_URL)) {
    return `The credential "${record.name}" is sent only under ${record.destination}, not to Slack’s Web API.`;
  }
  return null;
}

/**
 * Post a message with the credential a channel names, as one row of its log
 * (`notification`): refused by its rules, it throws with the refusal and
 * nothing is sent.
 */
export async function postSlackWithCredential(
  db: DbClient,
  input: {
    credentialId: number;
    channel: { id: number | null; slackChannelId: string };
    message: Record<string, unknown>;
    projectId?: number | null;
    actor?: CredentialActor;
  },
): Promise<void> {
  await withCredential(
    db,
    {
      credentialId: input.credentialId,
      feature: 'notification',
      projectId: input.projectId ?? null,
      url: SLACK_POST_MESSAGE_URL,
      custom: false,
      actor: input.actor ?? INSTANCE,
      ...(input.channel.id != null ? { subject: { type: 'channel', id: String(input.channel.id) } } : {}),
    },
    (credential) => postSlackApiMessage(credential.secret, input.channel.slackChannelId, input.message),
  );
}

/**
 * Move the bot tokens the Slack channels of the instance held in their config
 * (`config.token`, encrypted) into credentials, once, at startup: each to one
 * named after its channel, shared with all projects and sent to Slack's Web
 * API; equal tokens share one. Each channel moves in a transaction that first
 * writes its row, so a second server waits and finds it moved. A token that
 * cannot be opened or moved is left as it is and logged. Returns how many moved.
 */
export async function importSlackChannelTokens(db: DbClient): Promise<number> {
  const rows = await db
    .select({ id: notificationChannels.id, name: notificationChannels.name, config: notificationChannels.config })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.type, 'slack'), isNull(notificationChannels.userId)));
  const made = new Map<string, number>();
  let moved = 0;
  for (const row of rows) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    if (typeof config.token !== 'string' || !config.token || channelCredentialId(config) != null) continue;
    let token: string;
    try {
      token = decryptSecret(config.token, getEncryptionKey()).trim();
    } catch {
      console.warn(`[credentials] The Slack token of channel ${row.id} cannot be opened; it is left as it is`);
      continue;
    }
    if (!token) continue;
    try {
      const id = await db.transaction(async (tx) => {
        await tx.update(notificationChannels).set({ updatedAt: new Date() }).where(eq(notificationChannels.id, row.id));
        const [current] = await tx
          .select({ config: notificationChannels.config })
          .from(notificationChannels)
          .where(eq(notificationChannels.id, row.id));
        const now = (current?.config ?? {}) as Record<string, unknown>;
        if (now.token !== config.token) return null;
        const credentialId =
          made.get(token) ??
          (await saveSlackChannelCredential(tx as unknown as DbClient, { name: row.name, token, createdBy: null }));
        const { token: _sealed, ...rest } = now;
        await tx
          .update(notificationChannels)
          .set({ config: { ...rest, credentialId } })
          .where(eq(notificationChannels.id, row.id));
        return credentialId;
      });
      if (id != null) {
        made.set(token, id);
        moved++;
      }
    } catch (err) {
      console.warn(`[credentials] The Slack token of channel ${row.id} could not be moved; it is left as it is`, err);
    }
  }
  return moved;
}
