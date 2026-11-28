import { getDatabase } from '../../database';
import { diagnosesInProgress } from '../../utils/ai-diagnosis';
import { assistantAnswersInProgress } from '../../utils/assistant/running';
import { eventStreams, runRequests } from '../../utils/instance-activity';
import { requireOperator } from '../../utils/operator';
import { getOperatorUsage, type OperatorUsage } from '../../utils/operator-usage';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the instance’s usage and what it is doing now',
    description:
      'For whoever runs the instance without an account in it: a hosting provider, a deployment script. Counts only, never a name, an address, a result or a file. `now`: what a restart would cut, as the admin activity route counts it: the runs initializing, running or finalizing, with the last time one reported anything, and this server process’s `requestsInProgress`, `diagnosesInProgress`, `assistantAnswersInProgress` and `openEventStreams`. The instance has nothing to wait for when `runsInProgress`, `requestsInProgress`, `diagnosesInProgress` and `assistantAnswersInProgress` are 0. Then the projects, the users, the runs by when they started (in all, in the last 24 hours and 30 days, and the latest start), the stored files, the bytes the storage quota counts (the stored files and traces Settings → Storage counts, and the results of runs) and the quota (`quotaBytes`, the operator’s or `PIWI_STORAGE_QUOTA_BYTES`, null without one) with what it refuses: `over` (`{ since, ceilingBytes }` once the instance went over its quota, the ceiling past which it refuses new runs; null below it), `filesRefused` and `runsRefused`, the reporter versions that started runs in the last 90 days, the most recently heard first, 50 at most and only what reads as a version, the `limits` that apply now (`storageQuotaBytes`, `importMaxBytes`, `submitMaxBytes`, `retentionDays`; `GET /api/operator/limits` says where each comes from) and `readOnly`. Open only to the token of `PIWI_OPERATOR_TOKEN`, as a Bearer token: never to a session or an API key. Answers 404 while that variable is unset, shorter than 32 characters or holding a space. The right token always passes; a client network that sent ten wrong tokens in 15 minutes gets 429, with `Retry-After`.',
    security: [{ operatorToken: [] }],
  },
});

export default eventHandler(async (event): Promise<OperatorUsage> => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return getOperatorUsage(await getDatabase(), {
    requestsInProgress: runRequests.value,
    diagnosesInProgress: diagnosesInProgress(),
    assistantAnswersInProgress: assistantAnswersInProgress(),
    openEventStreams: eventStreams.value,
  });
});
