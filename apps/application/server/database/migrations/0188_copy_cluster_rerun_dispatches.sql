-- Each cluster's last CI re-run becomes a row of ci_dispatches: ended when a run
-- was matched to it, still open within the six-hour matching window, else
-- unreported. A dispatch stored without an id gets one.
INSERT OR IGNORE INTO `ci_dispatches` (
	`id`, `project_id`, `action_id`, `origin`, `kind`, `cluster_id`, `provider`, `preset`, `ref`, `args`, `files`,
	`tests`, `url`, `provider_run_id`, `state`, `run_id`, `by_user_id`, `by_name`, `created_at`, `updated_at`
)
SELECT
	COALESCE(json_extract(d, '$.id'), lower(hex(randomblob(8)))),
	project_id,
	json_extract(d, '$.actionId'),
	'page',
	'tests',
	cluster_id,
	json_extract(d, '$.provider'),
	json_extract(d, '$.preset'),
	json_extract(d, '$.ref'),
	COALESCE(json_extract(d, '$.args'), ''),
	json_extract(d, '$.files'),
	json_extract(d, '$.tests'),
	json_extract(d, '$.url'),
	COALESCE(json_extract(d, '$.pipelineId'), json_extract(d, '$.buildNumber')),
	CASE
		WHEN json_extract(d, '$.runId') IS NOT NULL THEN 'ended'
		WHEN at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 21600000 THEN 'dispatched'
		ELSE 'unreported'
	END,
	json_extract(d, '$.runId'),
	(SELECT `id` FROM `users` WHERE `users`.`id` = json_extract(d, '$.byUserId')),
	json_extract(d, '$.byName'),
	at_ms,
	at_ms
FROM (
	SELECT
		`id` AS cluster_id,
		`project_id`,
		`last_rerun_dispatch` AS d,
		CAST(COALESCE(json_extract(`last_rerun_dispatch`, '$.at'), 0) AS INTEGER) AS at_ms
	FROM `failure_clusters`
	WHERE `last_rerun_dispatch` IS NOT NULL
		AND json_valid(`last_rerun_dispatch`)
		AND json_extract(`last_rerun_dispatch`, '$.provider') IS NOT NULL
);
