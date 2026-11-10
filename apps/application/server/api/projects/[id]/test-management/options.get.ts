import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { failProviderCall, requireTestManagementClient } from '../../../../utils/integrations/test-management/endpoint';
import {
  testManagementOptionsCache,
  testManagementOptionsFailureCache,
} from '../../../../utils/integrations/picker-cache';
import { INTERACTIVE_MAX_WAIT_MS } from '../../../../utils/integrations/test-management/limiter';
import { ZEPHYR_INTERACTIVE_TIMEOUT_MS } from '../../../../utils/integrations/test-management/zephyr-scale';
import { folderOptions, type TestManagementPickerOptions } from '#shared/integrations/test-management-picker';
import { TEST_MANAGEMENT_PROJECT_KEY } from '#shared/integrations/test-management-binding';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'List what the test management binding form offers',
    description:
      "Reads a test management connection for the binding form: its `projects` and, when `projectKey` is given, that project's result `statuses` and test cycle `folders`. Cached for five minutes per connection and project, and a failed read for thirty seconds; the whole read, every request of it, ends within ten seconds with 502; a provider that answers 401 marks the connection failed, and one that answers 429 pauses the connection: until the pause ends the answer is 429 with `Retry-After`, without a call. A connection with more requests queued than can start within that time answers 429 with `Retry-After` too. Never returns the token. Requires `project:manage` (Project admin on the project).",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'connectionId', in: 'query', required: true, schema: { type: 'integer' } },
      { name: 'projectKey', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();

  const query = getQuery(event);
  const connectionId = Number(query.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    throw apiError({ statusCode: 400, message: 'Invalid connection' });
  }
  const projectKey = typeof query.projectKey === 'string' && query.projectKey ? query.projectKey : null;
  if (projectKey !== null && !TEST_MANAGEMENT_PROJECT_KEY.test(projectKey)) {
    throw apiError({ statusCode: 400, message: 'Invalid project key' });
  }

  const { client } = await requireTestManagementClient(event, db, connectionId, {
    timeoutMs: ZEPHYR_INTERACTIVE_TIMEOUT_MS,
    signal: AbortSignal.timeout(ZEPHYR_INTERACTIVE_TIMEOUT_MS),
    maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
    deadlineAt: Date.now() + ZEPHYR_INTERACTIVE_TIMEOUT_MS,
  });
  const cacheKey = `${connectionId}:${projectKey ?? ''}`;
  const cached = testManagementOptionsCache.get(cacheKey);
  if (cached) return cached;
  const failed = testManagementOptionsFailureCache.get(cacheKey);
  if (failed) throw apiError(failed);

  try {
    const projects = await client.listProjects();
    const options: TestManagementPickerOptions = {
      projects: projects.map((project) => ({ key: project.key, enabled: project.enabled })),
      statuses: [],
      folders: [],
    };
    if (projectKey) {
      const statuses = await client.listStatuses(projectKey);
      const folders = await client.listFolders(projectKey);
      options.statuses = statuses.map((status) => ({ name: status.name, isDefault: status.isDefault }));
      options.folders = folderOptions(folders);
    }
    testManagementOptionsCache.set(cacheKey, options);
    return options;
  } catch (err) {
    try {
      return await failProviderCall(event, db, connectionId, err);
    } catch (refusal) {
      const { statusCode, message } = refusal as { statusCode: number; message: string };
      if (statusCode === 502) testManagementOptionsFailureCache.set(cacheKey, { statusCode, message });
      throw refusal;
    }
  }
});
