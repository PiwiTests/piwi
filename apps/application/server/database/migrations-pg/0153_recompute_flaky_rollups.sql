-- Custom SQL migration file, put your code below! --

-- The daily analytics rollups sum each run's flaky count, which the passed-after-failure backfill recounted: the
-- rollups of every stored run are computed again at the next start (`backfillAnalyticsRollups`).
DELETE FROM "app_settings" WHERE "key" = 'analytics_rollups_backfilled_at';
