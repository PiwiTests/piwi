import { getDatabase } from '../database';
import { extractApiKey, getUserByApiKey, isAuthEnabled } from '../utils/auth';
import { getProjectScope } from '../utils/project-access';
import { TtlCache } from '../utils/ttl-cache';
import { parseAnalyticsScope } from '#shared/analytics/scope';
import { resolveCiCost } from '#shared/handlers/ci-cost';
import {
  collectProjectMetrics,
  OPENMETRICS_CONTENT_TYPE,
  renderOpenMetrics,
} from '#shared/handlers/analytics/open-metrics';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Metrics for a Prometheus or Grafana scraper',
    description:
      "The metric catalog's current values per project in the OpenMetrics text format: one gauge family per metric (`piwi_test_pass_rate_percent`, `piwi_wasted_ci_minutes_minutes`, …) with `project` and `project_id` labels, over the last 7 days unless `period` names another. Your scraper pulls from Piwi; Piwi sends nothing anywhere. Off unless PIWI_METRICS_ENABLED=true (404 otherwise). With authentication on, the request must carry an API key (Bearer or X-API-Key), and the samples cover the projects of its user; a session cookie is refused. Answers are cached for 60 seconds.",
    parameters: [
      {
        name: 'period',
        in: 'query',
        required: false,
        schema: { type: 'string', default: 'last-7d' },
        description: 'Period in compact form (`last-7d`, `last-30d`, `this-month`, …)',
      },
      {
        name: 'allBranches',
        in: 'query',
        required: false,
        schema: { type: 'boolean' },
        description: 'Count every branch instead of each project’s default branch',
      },
      {
        name: 'allEnvironments',
        in: 'query',
        required: false,
        schema: { type: 'boolean' },
        description: 'Count every environment instead of each project’s default environment',
      },
    ],
  },
});

const cache = new TtlCache<string>(60_000, 100);

export default eventHandler(async (event) => {
  if (process.env.PIWI_METRICS_ENABLED !== 'true') throw apiError({ statusCode: 404, message: 'Not found' });

  const db = await getDatabase();
  let access: Awaited<ReturnType<typeof getProjectScope>> = 'all';
  let who = 'all';
  if (isAuthEnabled(event)) {
    const key = extractApiKey(event);
    const user = key ? await getUserByApiKey(key) : null;
    if (!user) {
      setResponseHeader(event, 'WWW-Authenticate', 'Bearer');
      throw apiError({ statusCode: 401, message: 'An API key is required (Authorization: Bearer pd_…)' });
    }
    access = await getProjectScope(db, user);
    who = `user:${user.id}`;
  }

  const query = { period: 'last-7d', ...getQuery(event) };
  const key = `${who}|${new URLSearchParams(query as Record<string, string>).toString()}`;
  let body = cache.get(key);
  if (!body) {
    const { cost } = await resolveCiCost(db as any);
    const { samples, ids, periodLabel } = await collectProjectMetrics(
      db as any,
      parseAnalyticsScope(query),
      access,
      cost,
    );
    body = renderOpenMetrics(samples, { ids, periodLabel, cost });
    cache.set(key, body);
  }
  setResponseHeader(event, 'Content-Type', OPENMETRICS_CONTENT_TYPE);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return body;
});
