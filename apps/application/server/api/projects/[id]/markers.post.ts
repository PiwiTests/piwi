import { z } from 'zod';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { createMarker, markerRunBelongsToProject } from '#shared/handlers/markers';
import { MARKER_CATEGORY_IDS } from '#shared/marker-categories';

defineRouteMeta({
  openAPI: {
    tags: ['Markers'],
    summary: 'Create a project timeline marker',
    description:
      "Creates a dated timeline marker for a project. An optional `runId` links the marker to one of the project's runs; a `release` marker linked to a run keeps that run forever (retention never deletes it) until the marker is deleted or recategorized. `environment` names one of the project's environments by its key, an alias or a run's label, resolved as a run's label is (a label nothing takes creates a discovered environment), and the marker answers it with its `environmentId`. A `deploy` marker's `commit` (7 to 40 hexadecimal characters) is the commit deployed there: a run of that environment started after it reads its application at that commit. Requires `marker:write` (Contributor and above on the project).",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'marker:write',
  },
});

const createMarkerSchema = z.object({
  label: z.string().min(1, 'Label is required').max(120, 'Label must be at most 120 characters'),
  occurredAt: z.coerce.date(),
  category: z.enum(MARKER_CATEGORY_IDS as [string, ...string[]]).optional(),
  environment: z.string().max(120).nullish(),
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, 'commit must be 7 to 40 hexadecimal characters')
    .nullish(),
  description: z.string().max(2000).nullish(),
  runId: z.coerce.number().int().positive().nullish(),
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);

  const body = await readBody(event);
  const validation = createMarkerSchema.safeParse(body);
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: validation.error.issues });
  }

  const db = await getDatabase();
  if (validation.data.runId && !(await markerRunBelongsToProject(db, id, validation.data.runId))) {
    throw apiError({ statusCode: 400, message: 'runId must be a run of this project' });
  }
  return await createMarker(db, id, validation.data);
});
