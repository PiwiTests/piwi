import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { instanceLimits, loadOperatorLimits } from '../../utils/operator-limits';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Get the limits that apply',
    description:
      'Each limit `PUT /api/operator/limits` sets, as it applies now: `{ value, source }`, `source` being `operator` (set through that route), `environment` (its variable) or `default`. `storageQuotaBytes` (`PIWI_STORAGE_QUOTA_BYTES`, null without a quota), `importMaxBytes` (`PIWI_IMPORT_MAX_BYTES`), `submitMaxBytes` (`PIWI_SUBMIT_MAX_BYTES`), `retentionDays` (`PIWI_RETENTION_DAYS`, the days of runs the nightly sweep keeps; null or 0 keeps every run) and `readOnly` (`false` unless the operator turned it on). `retentionDays` also says `pending`: a lowered retention waiting its 14 days, `{ value, source, appliesAt }`, else null. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  await loadOperatorLimits({ db: await getDatabase(), fresh: true });
  return { limits: instanceLimits() };
});
