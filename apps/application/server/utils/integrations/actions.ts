/**
 * The integration outbox — every outbound write to a tracker is a durable row,
 * retried with backoff, deduped by a unique key, and listable. It is the third
 * instance of the shape auto-heal and notifications already use; the retry
 * arithmetic is shared through `server/utils/outbox.ts`.
 *
 * A click enqueues an action and asks for one immediate attempt (`runActionNow`),
 * so the issue resolves in a single round-trip when Jira is up and degrades to a
 * background retry (`sweepIntegrationActions`, every minute) when it is not. A
 * successful `create-issue` writes the entity link and the result together, and
 * records on the link what Piwi wrote: an `update-issue` replaces the title and
 * description only while they still read that way, so an edit made in the
 * tracker is never overwritten.
 *
 * A refusal no retry can change — Jira answering that the request itself is
 * wrong (a missing required field, a project the account cannot see), or a
 * transition whose screen requires a field the project gives no value for —
 * fails the action at once instead of retrying it for hours.
 *
 * An action runs only through the connection its project is bound to when it
 * runs: one whose project is bound to another connection, or to none, is
 * skipped.
 */
import { and, eq, inArray, lt, lte } from 'drizzle-orm';
import { bugReports, entityLinks, integrationActions } from '../../database/schema';
import { getStorage } from '../../storage';
import { bugReportStorageDir } from '#shared/handlers/bug-reports';
import { attachKey } from '#shared/integrations/action-keys';
import type { DbClient } from '../../database';
import type { IssueDocument } from '#shared/integrations/document';
import type { IssueLocale } from '#shared/integrations/messages';
import type { IssueIncludeOptions } from '#shared/integrations/types';
import type { LinkEntityType } from '#shared/handlers/links';
import type { IntegrationAction } from '../../database/schema';
import type { IssueTracker } from './types';
import { createTracker } from './connections';
import { boundConnectionId } from './bound-connection';
import { JiraError } from './jira/client';
import { mergeEntityLinkMetadata, writeCreatedIssueLink } from './entity-links';
import {
  descriptionDigest,
  documentDigest,
  type AutomaticFiling,
  type WrittenIssueRecord,
} from '#shared/integrations/automation';
import {
  claimOutboxRows,
  nextAttempt,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_PROCESSING,
  OUTBOX_SWEEPABLE_STATUSES,
} from '../outbox';
import {
  fieldPayload,
  missingRequiredFields,
  missingTransitionFieldsMessage,
  TRANSITION_SKIPPED_FIELDS,
  type FieldValues,
} from '#shared/integrations/fields';
import { matchTransition } from '#shared/integrations/transitions';

/** The snapshot a `create-issue` action carries — enough to retry deterministically. */
export interface CreateIssueActionPayload {
  projectKey: string;
  issueType: string;
  title: string;
  document: IssueDocument;
  labels: string[];
  assigneeId?: string | null;
  priority?: string | null;
  componentId?: string | null;
  /** Extra field values, as the tracker API takes them, keyed by field id. */
  fields?: Record<string, unknown>;
  /** The language the body was rendered in, so a retry stays consistent. */
  locale?: IssueLocale;
  /** The entity the created known-issue link attaches to — normally the cluster. */
  linkEntityType: LinkEntityType;
  linkEntityId: number;
  /** Set when a rule filed the issue: what it counted, kept on the link for the description updates. */
  automatic?: AutomaticFiling | null;
  /** What the body carries, kept on the link so a description update carries the same. */
  include?: IssueIncludeOptions | null;
  /** The share link the body carries, kept on the link so a description update reuses it. */
  shareUrl?: string | null;
}

/** An update action's snapshot: the rebuilt title and description of an issue Piwi filed. */
export interface UpdateIssueActionPayload {
  issueKey: string;
  /** The link that remembers what Piwi wrote. */
  linkId: number;
  /** The new title, or null to leave the title alone (a person chose it when filing). */
  title: string | null;
  document: IssueDocument;
}

/** The bookkeeping a tracker link keeps about the issue Piwi filed. */
export interface FiledIssueMeta {
  /** What Piwi last wrote; absent when Piwi did not file the issue or could not read it back. */
  written?: WrittenIssueRecord | null;
  /** Set once the description was found edited in the tracker: Piwi no longer replaces it. */
  descriptionEdited?: boolean;
  /** Set when a rule filed the issue. */
  automatic?: AutomaticFiling | null;
  /** The language, the include toggles and the share link the issue was filed with. */
  locale?: IssueLocale | null;
  include?: IssueIncludeOptions | null;
  shareUrl?: string | null;
}

/** A comment action's snapshot — the rendered body, keyed to an issue. */
export interface CommentActionPayload {
  issueKey: string;
  document: IssueDocument;
}

/**
 * A transition action's snapshot. `transitionId` is resolved at binding time; a
 * `statusName` lets the action match a transition by its target status against
 * the actual issue's transitions when the id is unknown (a French-configured
 * site names them in French, so the match is on the site's own names, by id).
 */
export interface TransitionActionPayload {
  issueKey: string;
  transitionId?: string | null;
  statusName?: string | null;
  /** Values for the fields the transition's screen asks for, from the project settings. */
  fields?: FieldValues;
}

/** An attach action's snapshot: one stored file to attach to an issue. */
export interface AttachActionPayload {
  issueKey: string;
  /** The file's path in Piwi's storage. */
  storagePath: string;
  name: string;
  mime: string;
}

export interface CreateIssueResult {
  key: string;
  url: string;
  issueId: string | null;
}

export interface EnqueueInput {
  connectionId: number;
  projectId: number;
  kind: string;
  entityType: string;
  entityId: number;
  dedupeKey: string;
  payload: unknown;
  requestedBy?: number | null;
}

/**
 * Enqueue an action. A duplicate dedupe key is a no-op that returns the existing
 * row — a second click, or a duplicate event, never files twice.
 */
export async function enqueueAction(db: DbClient, input: EnqueueInput): Promise<IntegrationAction> {
  const [existing] = await db
    .select()
    .from(integrationActions)
    .where(eq(integrationActions.dedupeKey, input.dedupeKey));
  if (existing) return existing;

  const [row] = await db
    .insert(integrationActions)
    .values({
      connectionId: input.connectionId,
      projectId: input.projectId,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      dedupeKey: input.dedupeKey,
      status: 'pending',
      attempts: 0,
      scheduledFor: new Date(),
      payload: input.payload as never,
      requestedBy: input.requestedBy ?? null,
    })
    .onConflictDoNothing({ target: integrationActions.dedupeKey })
    .returning();
  // A racing insert can still lose the unique-key contest — fall back to the winner.
  if (!row) {
    const [winner] = await db
      .select()
      .from(integrationActions)
      .where(eq(integrationActions.dedupeKey, input.dedupeKey));
    return winner!;
  }
  return row;
}

/** The action already queued under a dedupe key, or null. */
export async function findActionByKey(db: DbClient, dedupeKey: string): Promise<IntegrationAction | null> {
  const [row] = await db.select().from(integrationActions).where(eq(integrationActions.dedupeKey, dedupeKey));
  return row ?? null;
}

/**
 * Free a done action's dedupe key, so the same write can be made again: the
 * issue it filed was unlinked, and a new filing is wanted. The row stays, with
 * its result, as the record of what was filed.
 */
export async function retireAction(db: DbClient, id: number): Promise<void> {
  const [row] = await db
    .select({ dedupeKey: integrationActions.dedupeKey })
    .from(integrationActions)
    .where(eq(integrationActions.id, id));
  if (!row) return;
  await db
    .update(integrationActions)
    .set({ dedupeKey: `${row.dedupeKey}:retired:${id}` })
    .where(eq(integrationActions.id, id));
}

/**
 * Enqueue an action, or give an earlier one with the same dedupe key a new
 * payload when it has already failed or was skipped: a person who changes the
 * request after a refusal (another issue type, a filled-in field) sends the new
 * request, not the one that was refused. An action that succeeded, that is
 * queued and has not been tried yet, or that an attempt holds (even one claimed
 * while this runs) is returned as it is.
 */
export async function enqueueOrReplaceAction(db: DbClient, input: EnqueueInput): Promise<IntegrationAction> {
  const action = await enqueueAction(db, input);
  const failedBefore =
    action.status === 'failed' || action.status === 'skipped' || (action.status === 'pending' && action.attempts > 0);
  if (!failedBefore) return action;
  const [replaced] = await db
    .update(integrationActions)
    .set({
      payload: input.payload as never,
      status: 'pending',
      attempts: 0,
      error: null,
      scheduledFor: new Date(),
      finishedAt: null,
      requestedBy: input.requestedBy ?? action.requestedBy,
    })
    .where(and(eq(integrationActions.id, action.id), eq(integrationActions.status, action.status)))
    .returning();
  return replaced ?? action;
}

/**
 * Record a write Piwi did not send, for an action no person waits on (an
 * automatic create): a `failed` row for a refusal (a required field left
 * empty), a `skipped` one for a write left to a person (an issue already
 * carries the failure), each with the reason the activity list shows. A failed
 * or skipped row already under the key takes the new status, reason and
 * payload; any other row under it is returned as it is.
 */
export async function recordRefusedAction(
  db: DbClient,
  input: EnqueueInput & { error: string; status?: 'failed' | 'skipped' },
): Promise<IntegrationAction> {
  const now = new Date();
  const status = input.status ?? 'failed';
  const existing = await findActionByKey(db, input.dedupeKey);
  if (existing) {
    if (existing.status !== 'failed' && existing.status !== 'skipped') return existing;
    const [updated] = await db
      .update(integrationActions)
      .set({ status, error: input.error, payload: input.payload as never, finishedAt: now })
      .where(eq(integrationActions.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [row] = await db
    .insert(integrationActions)
    .values({
      connectionId: input.connectionId,
      projectId: input.projectId,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      dedupeKey: input.dedupeKey,
      status,
      attempts: 0,
      scheduledFor: now,
      payload: input.payload as never,
      requestedBy: input.requestedBy ?? null,
      error: input.error,
      finishedAt: now,
    })
    .onConflictDoNothing({ target: integrationActions.dedupeKey })
    .returning();
  return row ?? (await findActionByKey(db, input.dedupeKey))!;
}

/**
 * HTTP statuses of a tracker refusal no retry can change: the request itself is
 * wrong or not allowed. A 401 (a token that may be renewed), a 429 (rate
 * limit) and any 5xx or network failure are retried.
 */
const FINAL_REFUSAL_STATUSES = new Set([400, 403, 404, 405, 410, 413, 422]);

/**
 * A write Piwi refuses before calling the tracker, because a field the tracker
 * requires has no value: a retry would be refused the same way.
 */
export class RequiredFieldsError extends Error {
  constructor(
    message: string,
    /** The empty fields, by id, with Jira's names. */
    readonly missing: { id: string; name: string }[],
  ) {
    super(message);
    this.name = 'RequiredFieldsError';
  }
}

/** Whether an attempt's error is a refusal that retrying cannot change. */
export function isFinalRefusal(err: unknown): boolean {
  if (err instanceof RequiredFieldsError) return true;
  return err instanceof JiraError && FINAL_REFUSAL_STATUSES.has(err.status);
}

/** The per-field errors an attempt's error carries, keyed by field id. */
function errorFields(err: unknown): Record<string, string> | undefined {
  if (err instanceof JiraError) return err.fieldErrors;
  if (err instanceof RequiredFieldsError) {
    return Object.fromEntries(err.missing.map((f) => [f.id, `${f.name} is required.`]));
  }
  return undefined;
}

/** Retry-after seconds carried on a 429, in milliseconds, or null. */
function retryAfterMs(err: unknown): number | null {
  if (err instanceof JiraError && err.retryAfterSeconds != null) return err.retryAfterSeconds * 1000;
  return null;
}

/** What Piwi just wrote, read back from the tracker; null when the tracker cannot say. */
async function readBackWritten(
  tracker: IssueTracker,
  key: string,
  sourceTitle: string,
  document: IssueDocument,
): Promise<WrittenIssueRecord | null> {
  if (!tracker.readIssueText) return null;
  const text = await tracker.readIssueText(key).catch(() => null);
  if (!text) return null;
  return {
    descriptionDigest: await descriptionDigest(text.description),
    documentDigest: await documentDigest(document),
    title: text.title,
    sourceTitle,
  };
}

/** Perform one create-issue against the tracker and record the link + result. */
async function applyCreateIssue(
  db: DbClient,
  tracker: IssueTracker,
  action: IntegrationAction,
): Promise<CreateIssueResult> {
  const payload = action.payload as CreateIssueActionPayload;
  const created = await tracker.createIssue({
    projectKey: payload.projectKey,
    issueType: payload.issueType,
    title: payload.title,
    body: payload.document,
    labels: payload.labels,
    assigneeId: payload.assigneeId ?? null,
    priority: payload.priority ?? null,
    componentId: payload.componentId ?? null,
    fields: payload.fields,
  });
  // The create response carries no status; read it back once so the chip shows a
  // status the moment the key exists (best-effort — the key still lands if not).
  const enriched = (await tracker.getIssue(created.key).catch(() => null)) ?? created;
  const issue = { ...created, ...enriched, id: created.id ?? enriched.id };
  const result: CreateIssueResult = { key: issue.key, url: issue.url, issueId: issue.id };
  const written = await readBackWritten(tracker, issue.key, payload.title, payload.document);
  const metadata: FiledIssueMeta = {
    ...(written ? { written } : {}),
    ...(payload.automatic ? { automatic: payload.automatic } : {}),
    ...(payload.locale ? { locale: payload.locale } : {}),
    ...(payload.include ? { include: payload.include } : {}),
    ...(payload.shareUrl ? { shareUrl: payload.shareUrl } : {}),
  };

  await db.transaction(async (tx) => {
    await writeCreatedIssueLink(tx as unknown as DbClient, {
      entityType: payload.linkEntityType,
      entityId: payload.linkEntityId,
      connectionId: action.connectionId,
      createdBy: action.requestedBy ?? null,
      metadata: Object.keys(metadata).length ? (metadata as Record<string, unknown>) : null,
      issue: {
        provider: tracker.provider,
        url: issue.url,
        key: issue.key,
        externalId: issue.id,
        title: issue.title,
        statusText: issue.status,
        statusColor: issue.statusColor,
        statusCategory: issue.statusCategory ?? null,
      },
    });
    await tx
      .update(integrationActions)
      .set({ status: 'done', result: result as never, error: null, attempts: action.attempts, finishedAt: new Date() })
      .where(eq(integrationActions.id, action.id));
  });

  // A bug report's screenshots follow the issue, one queued attach each.
  if (payload.linkEntityType === 'bug_report' && tracker.attach) {
    for (const file of await bugReportAttachments(db, payload.linkEntityId)) {
      const attach = await enqueueAction(db, {
        connectionId: action.connectionId,
        projectId: action.projectId,
        kind: 'attach',
        entityType: 'bug_report',
        entityId: payload.linkEntityId,
        dedupeKey: attachKey(payload.linkEntityId, issue.key, file.name),
        payload: { issueKey: issue.key, ...file } satisfies AttachActionPayload,
        requestedBy: action.requestedBy ?? null,
      });
      await runActionNow(db, attach.id).catch(() => null);
    }
  }

  return result;
}

/** The screenshots of a bug report, as files to attach. */
async function bugReportAttachments(
  db: DbClient,
  bugReportId: number,
): Promise<Array<{ storagePath: string; name: string; mime: string }>> {
  const [row] = await db
    .select({ evidence: bugReports.evidence })
    .from(bugReports)
    .where(eq(bugReports.id, bugReportId));
  const shots = ((row?.evidence ?? null) as { screenshots?: Array<{ file: string }> } | null)?.screenshots ?? [];
  return shots.map((shot) => {
    const name = shot.file.replace(/^screenshots\//, '');
    return { storagePath: `${bugReportStorageDir(bugReportId)}/${name}`, name, mime: 'image/png' };
  });
}

/** Attach one stored file to its issue. */
async function applyAttach(tracker: IssueTracker, action: IntegrationAction): Promise<void> {
  const payload = action.payload as AttachActionPayload;
  if (!tracker.attach) throw new Error('this tracker takes no attachments');
  const bytes = await getStorage().readFile(payload.storagePath);
  await tracker.attach(payload.issueKey, { name: payload.name, bytes: new Uint8Array(bytes), mime: payload.mime });
}

/** What a done `update-issue` action records: whether it changed the issue, or found it up to date. */
export interface UpdateIssueResult {
  updated: boolean;
}

/**
 * Replace the title and description of an issue Piwi filed, only while they
 * read as Piwi wrote them: an edit made in the tracker is never overwritten,
 * and an update that would send what is already there sends nothing. Returns
 * why nothing was written (`skipped`), or whether the issue changed.
 */
async function applyUpdateIssue(
  db: DbClient,
  tracker: IssueTracker,
  action: IntegrationAction,
): Promise<{ skipped: string } | UpdateIssueResult> {
  const payload = action.payload as UpdateIssueActionPayload;
  if (!tracker.updateIssue || !tracker.readIssueText) return { skipped: 'this tracker cannot update an issue' };
  const [link] = await db
    .select({ metadata: entityLinks.metadata })
    .from(entityLinks)
    .where(eq(entityLinks.id, payload.linkId));
  const meta = (link?.metadata ?? null) as FiledIssueMeta | null;
  const written = meta?.written;
  if (!link || !written) return { skipped: 'Piwi did not write this description' };
  if (meta?.descriptionEdited) return { skipped: 'the description was edited in the tracker' };

  const current = await tracker.readIssueText(payload.issueKey);
  if (!current) return { skipped: 'the issue no longer exists' };
  if ((await descriptionDigest(current.description)) !== written.descriptionDigest) {
    await mergeEntityLinkMetadata(db, payload.linkId, { descriptionEdited: true });
    return { skipped: 'the description was edited in the tracker' };
  }

  const nextDocumentDigest = await documentDigest(payload.document);
  const body = nextDocumentDigest !== written.documentDigest ? payload.document : undefined;
  // A title changed in the tracker stays as it is.
  const title =
    payload.title != null && current.title === written.title && payload.title !== written.sourceTitle
      ? payload.title
      : undefined;
  if (!body && title === undefined) return { updated: false };

  await tracker.updateIssue(payload.issueKey, { title, body });
  const after = await tracker.readIssueText(payload.issueKey).catch(() => null);
  // Without the text read back, a later update cannot tell Piwi's text from an edit, so it writes nothing.
  const next: WrittenIssueRecord | null = after
    ? {
        descriptionDigest: await descriptionDigest(after.description),
        documentDigest: nextDocumentDigest,
        title: title !== undefined ? after.title : written.title,
        sourceTitle: title ?? written.sourceTitle,
      }
    : null;
  await mergeEntityLinkMetadata(db, payload.linkId, { written: next });
  return { updated: true };
}

/** Perform one comment against the tracker (queued by the comment policies). */
async function applyComment(tracker: IssueTracker, action: IntegrationAction): Promise<void> {
  const payload = action.payload as CommentActionPayload;
  await tracker.addComment(payload.issueKey, payload.document);
}

/**
 * Perform one transition. Prefers the configured id; falls back to the
 * transition whose target status name matches (case-insensitively), read from
 * the actual issue so the match is on the site's own names. A no-op when the
 * transition is not available (already there, or renamed away).
 *
 * The transition's screen is read with it: the project's values for its fields
 * are sent, and a field it requires with no value refuses the transition before
 * Jira is asked, naming the field.
 */
async function applyTransition(tracker: IssueTracker, action: IntegrationAction): Promise<void> {
  const payload = action.payload as TransitionActionPayload;
  const available = await tracker.listTransitions(payload.issueKey);
  const target = matchTransition(available, payload.transitionId) ?? matchTransition(available, payload.statusName);
  if (!target) return;
  const values = payload.fields ?? {};
  const screen = target.fields ?? [];
  const missing = missingRequiredFields(screen, values, {}, TRANSITION_SKIPPED_FIELDS);
  if (missing.length) {
    throw new RequiredFieldsError(
      missingTransitionFieldsMessage(missing, payload.issueKey, target.toStatus ?? target.name),
      missing.map((f) => ({ id: f.id, name: f.name })),
    );
  }
  await tracker.transition(payload.issueKey, target.id, fieldPayload(values, screen, TRANSITION_SKIPPED_FIELDS));
}

/** Why an action whose project is bound to another connection, or to none, was not run. */
const NOT_BOUND = 'the project is not bound to this connection';

export type ActionOutcome =
  | { status: 'done'; result?: unknown }
  | { status: 'skipped'; reason: string }
  | {
      status: 'failed';
      error: string;
      final?: boolean;
      /** The attempt failed but the action stays queued: the outbox tries it again. */
      retrying?: boolean;
      fieldErrors?: Record<string, string>;
    };

/**
 * Run one action once, after the caller has claimed its row. Marks the row
 * terminal on success or skip; on failure bumps attempts and reschedules with
 * backoff (honoring a 429 `Retry-After`) until the cap turns it `failed`.
 * Returns the outcome for the caller.
 */
export async function runAction(db: DbClient, action: IntegrationAction): Promise<ActionOutcome> {
  const now = new Date();
  const attempts = action.attempts + 1;

  // An action writes only through the connection its project is bound to.
  if ((await boundConnectionId(db, action.projectId)) !== action.connectionId) {
    await db
      .update(integrationActions)
      .set({ status: 'skipped', error: NOT_BOUND, attempts, finishedAt: now })
      .where(eq(integrationActions.id, action.id));
    return { status: 'skipped', reason: NOT_BOUND };
  }

  const tracker = await createTracker(db, action.connectionId);
  if (!tracker) {
    await db
      .update(integrationActions)
      .set({ status: 'skipped', error: 'connection has no usable credentials', attempts, finishedAt: now })
      .where(eq(integrationActions.id, action.id));
    return { status: 'skipped', reason: 'connection has no usable credentials' };
  }

  try {
    if (action.kind === 'create-issue') {
      const result = await applyCreateIssue(db, tracker, { ...action, attempts });
      return { status: 'done', result };
    }
    if (action.kind === 'comment') {
      await applyComment(tracker, action);
      await db
        .update(integrationActions)
        .set({ status: 'done', error: null, attempts, finishedAt: now })
        .where(eq(integrationActions.id, action.id));
      return { status: 'done' };
    }
    if (action.kind === 'update-issue') {
      const update = await applyUpdateIssue(db, tracker, action);
      if ('skipped' in update) {
        await db
          .update(integrationActions)
          .set({ status: 'skipped', error: update.skipped, attempts, finishedAt: now })
          .where(eq(integrationActions.id, action.id));
        return { status: 'skipped', reason: update.skipped };
      }
      await db
        .update(integrationActions)
        .set({ status: 'done', error: null, result: update as never, attempts, finishedAt: now })
        .where(eq(integrationActions.id, action.id));
      return { status: 'done', result: update };
    }
    if (action.kind === 'attach') {
      await applyAttach(tracker, action);
      await db
        .update(integrationActions)
        .set({ status: 'done', error: null, attempts, finishedAt: now })
        .where(eq(integrationActions.id, action.id));
      return { status: 'done' };
    }
    if (action.kind === 'transition') {
      await applyTransition(tracker, action);
      await db
        .update(integrationActions)
        .set({ status: 'done', error: null, attempts, finishedAt: now })
        .where(eq(integrationActions.id, action.id));
      return { status: 'done' };
    }
    await db
      .update(integrationActions)
      .set({ status: 'skipped', error: `unsupported action kind '${action.kind}'`, attempts, finishedAt: now })
      .where(eq(integrationActions.id, action.id));
    return { status: 'skipped', reason: `unsupported action kind '${action.kind}'` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final = isFinalRefusal(err);
    const next = final
      ? { status: 'failed' as const, scheduledFor: action.scheduledFor }
      : nextAttempt(attempts, now, action.scheduledFor, retryAfterMs(err));
    await db
      .update(integrationActions)
      .set({
        status: next.status,
        attempts,
        error: message,
        scheduledFor: next.scheduledFor,
        finishedAt: next.status === 'failed' ? now : null,
      })
      .where(eq(integrationActions.id, action.id));
    console.error(`[integrations] action ${action.id} failed (attempt ${attempts}/${OUTBOX_MAX_ATTEMPTS}): ${message}`);
    const fieldErrors = errorFields(err);
    return {
      status: 'failed',
      error: message,
      final,
      retrying: next.status !== 'failed',
      ...(fieldErrors ? { fieldErrors } : {}),
    };
  }
}

/**
 * Run one action immediately by id (the click path), regardless of its schedule.
 * Null when there is no such action, or when another attempt holds it.
 */
export async function runActionNow(db: DbClient, id: number): Promise<ActionOutcome | null> {
  const [action] = await db.select().from(integrationActions).where(eq(integrationActions.id, id));
  if (!action) return null;
  if (action.status !== 'pending') {
    if (action.status === 'done') return { status: 'done', result: action.result };
    if (action.status === 'skipped') return { status: 'skipped', reason: action.error ?? '' };
    if (action.status === OUTBOX_PROCESSING) return null;
    return { status: 'failed', error: action.error ?? '' };
  }
  const claimed = await claimOutboxRows(db, integrationActions, [action.id], { anySchedule: true });
  if (!claimed.has(action.id)) return null;
  return runAction(db, action);
}

/**
 * Process queued integration actions that are due now, including a claimed one
 * whose lease ran out. Each is claimed first and skipped when another attempt
 * holds it. Mirrors the heal sweeper.
 */
export async function sweepIntegrationActions(
  db: DbClient,
): Promise<{ done: number; failed: number; skipped: number }> {
  const now = new Date();
  let done = 0;
  let failed = 0;
  let skipped = 0;

  const due = await db
    .select()
    .from(integrationActions)
    .where(
      and(
        inArray(integrationActions.status, OUTBOX_SWEEPABLE_STATUSES),
        lte(integrationActions.scheduledFor, now),
        lt(integrationActions.attempts, OUTBOX_MAX_ATTEMPTS),
      ),
    );

  for (const action of due) {
    const claimed = await claimOutboxRows(db, integrationActions, [action.id]);
    if (!claimed.has(action.id)) continue;
    const outcome = await runAction(db, action);
    if (outcome.status === 'done') done++;
    else if (outcome.status === 'skipped') skipped++;
    else failed++;
  }

  return { done, failed, skipped };
}
