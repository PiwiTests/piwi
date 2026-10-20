import { z } from 'zod';
import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { canAccessProject, resolveLinkEntityProjectId } from '../../utils/project-access';
import { createIssue } from '../../utils/integrations/create';
import type { CreateIssueResponse } from '#shared/integrations/types';
import { normalizeFieldValues } from '#shared/integrations/fields';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Create an issue from a failure or a bug report',
    description:
      "Enqueues a create-issue action and makes one immediate attempt. A duplicate of an issue already filed for the same cluster (from the cluster or any of its executions) or the same bug report is a no-op answered with `alreadyFiled`; once that issue's link is removed or the issue is Done, the next create files a new one. When the tracker does not answer, the response is `pending` with the tracker's error: the outbox retries it and links the issue once it is created, and creating again retries it at once. `fields` sets tracker fields (field id → `{ value, label }`, the value as the tracker API takes it) over the project's field defaults. When the create screen still has an empty required field, nothing is sent: the response is `failed` with `missingFields`. A refusal from the tracker comes back with `fieldErrors` when it names fields, and is not retried; creating again replaces the refused request. `include.includeShareLink` creates one share link for the issue, recorded as the caller's, and needs `share:create` on the project: without it the issue carries no share link. Requires `issue:create` (Contributor and above on the project).",
    'x-required-permission': 'issue:create',
  },
});

const schema = z.object({
  entityType: z.enum(['failure_cluster', 'test_runs_case', 'bug_report']),
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
});

export default eventHandler(async (event): Promise<CreateIssueResponse> => {
  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  }
  const input = parsed.data;

  // The permission gate comes before the entity lookup, so a member who holds
  // `issue:create` on no project learns nothing about which ids exist.
  const user = await requireAuth(event);
  const db = await getDatabase();
  const projectId = await resolveLinkEntityProjectId(db, input.entityType, input.entityId);
  if (!projectId) throw apiError({ statusCode: 404, message: 'Entity not found' });
  if (!(await canAccessProject(db, user, projectId, 'issue:create'))) {
    throw apiError({ statusCode: 403, message: 'No access to this project' });
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
  });
  if (!outcome) throw apiError({ statusCode: 404, message: 'Entity or cluster unavailable' });

  return {
    actionId: outcome.actionId,
    status: outcome.status,
    key: outcome.key,
    url: outcome.url,
    alreadyFiled: outcome.alreadyFiled,
    error: outcome.error,
    missingFields: outcome.missingFields,
    fieldErrors: outcome.fieldErrors,
  };
});
