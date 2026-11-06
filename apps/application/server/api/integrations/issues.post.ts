import { z } from 'zod';
import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { canAccessProject, resolveLinkEntityProjectId } from '../../utils/project-access';
import { readProjectIntegration } from '../../utils/integrations/binding';
import { createIssue, filedByName } from '../../utils/integrations/create';
import { MAX_ISSUE_COMMENT_LENGTH } from '#shared/integrations/run-issue';
import type { CreateIssueResponse } from '#shared/integrations/types';
import { normalizeFieldValues } from '#shared/integrations/fields';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Create an issue from a failure, a run or a bug report',
    description:
      "Enqueues a create-issue action and makes one immediate attempt. `comment` is the caller's own words, placed first in the issue under their name. A run (`test_run`), and an execution with no failure cluster, may get several issues: each `submissionId` (one per opening of the create dialog) files at most one, and a request without it always files a new one. A duplicate of an issue already filed for the same cluster (from the cluster or any of its executions) or the same bug report is a no-op answered with `alreadyFiled`, and its `comment`, when given, is added to that issue (`commentAdded`); once that issue's link is removed or the issue is Done, the next create files a new one. When the tracker does not answer, the response is `pending` with the tracker's error: the outbox retries it and links the issue once it is created, and creating again retries it at once. A filing the tracker may have received without its answer coming back (a timeout, a connection lost after sending, a restart during the call) is never sent again: its next attempt fails with *Outcome unknown*. Check the tracker, then create again. `fields` sets tracker fields (field id → `{ value, label }`, the value as the tracker API takes it) over the project's field defaults. When the create screen still has an empty required field, nothing is sent: the response is `failed` with `missingFields`. A refusal from the tracker comes back with `fieldErrors` when it names fields, and is not retried; creating again replaces the refused request. `include.includeShareLink` creates one share link for the issue, recorded as the caller's, and needs `share:create` on the project: without it the issue carries no share link. `connectionId` must be the connection the project is bound to (its Issue tracker settings): any other connection, or a project bound to none, is refused with 403. Requires `issue:create` (Contributor and above on the project).",
    'x-required-permission': 'issue:create',
  },
});

const schema = z.object({
  entityType: z.enum(['failure_cluster', 'test_runs_case', 'test_run', 'bug_report']),
  entityId: z.number().int().positive(),
  connectionId: z.number().int().positive(),
  title: z.string().min(1).max(255),
  projectKey: z.string().min(1).max(100),
  issueType: z.string().min(1).max(100),
  labels: z.array(z.string()).optional(),
  assignee: z.string().nullable().optional(),
  locale: z.enum(['en', 'fr']).optional(),
  include: z
    .object({
      includeDiagnosis: z.boolean().optional(),
      includePatch: z.boolean().optional(),
      includeScreenshot: z.boolean().optional(),
      includeShareLink: z.boolean().optional(),
    })
    .optional(),
  fields: z.record(z.string(), z.object({ value: z.unknown(), label: z.string().optional() })).optional(),
  comment: z.string().max(MAX_ISSUE_COMMENT_LENGTH).optional(),
  submissionId: z.string().uuid().optional(),
});

export default eventHandler(async (event): Promise<CreateIssueResponse> => {
  // The permission gate comes before the body is read and the entity looked up,
  // so a member who holds `issue:create` on no project learns nothing about
  // which ids exist.
  const user = await requireAuth(event);
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const input = parsed.data;

  const db = await getDatabase();
  const projectId = await resolveLinkEntityProjectId(db, input.entityType, input.entityId);
  if (!projectId) throw apiError({ statusCode: 404, message: 'Entity not found' });
  if (!(await canAccessProject(db, user, projectId, 'issue:create'))) {
    throw apiError({ statusCode: 403, message: 'No access to this project' });
  }
  // A project's issues go through the connection it is bound to, never through another one.
  const { connectionId: boundConnectionId } = await readProjectIntegration(db, projectId);
  if (boundConnectionId === null) {
    throw apiError({ statusCode: 403, message: 'This project is not bound to an issue tracker' });
  }
  if (input.connectionId !== boundConnectionId) {
    throw apiError({ statusCode: 403, message: 'This project files its issues through the connection it is bound to' });
  }

  // A share link is public: only a caller who may create one gets it in the ticket.
  const include =
    input.include?.includeShareLink && !(await canAccessProject(db, user, projectId, 'share:create'))
      ? { ...input.include, includeShareLink: false }
      : input.include;

  const outcome = await createIssue(db, {
    entityType: input.entityType,
    entityId: input.entityId,
    connectionId: input.connectionId,
    title: input.title,
    projectKey: input.projectKey,
    issueType: input.issueType,
    labels: input.labels,
    assignee: input.assignee ?? null,
    locale: input.locale,
    include,
    fields: normalizeFieldValues(input.fields),
    requestedBy: user.id || null,
    siteUrl: process.env.PIWI_SITE_URL ?? null,
    comment: input.comment ?? null,
    filedBy: filedByName(user),
    submissionId: input.submissionId ?? null,
  });
  if (!outcome) throw apiError({ statusCode: 404, message: 'Entity or cluster unavailable' });

  return {
    actionId: outcome.actionId,
    status: outcome.status,
    key: outcome.key,
    url: outcome.url,
    alreadyFiled: outcome.alreadyFiled,
    commentAdded: outcome.commentAdded,
    error: outcome.error,
    missingFields: outcome.missingFields,
    fieldErrors: outcome.fieldErrors,
  };
});
