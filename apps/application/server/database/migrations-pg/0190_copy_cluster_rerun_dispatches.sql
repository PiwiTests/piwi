-- Each cluster's last CI re-run becomes a row of ci_dispatches: ended when a run
-- was matched to it, still open within the six-hour matching window, else
-- unreported. A dispatch stored without an id gets one.
INSERT INTO "ci_dispatches" (
	"id", "project_id", "action_id", "origin", "kind", "cluster_id", "provider", "preset", "ref", "args", "files",
	"tests", "url", "provider_run_id", "state", "run_id", "by_user_id", "by_name", "created_at", "updated_at"
)
SELECT
	COALESCE(d->>'id', substr(md5(random()::text || cluster_id::text), 1, 16)),
	project_id,
	d->>'actionId',
	'page',
	'tests',
	cluster_id,
	d->>'provider',
	d->>'preset',
	d->>'ref',
	COALESCE(d->>'args', ''),
	d->'files',
	(d->>'tests')::integer,
	d->>'url',
	COALESCE(d->>'pipelineId', d->>'buildNumber'),
	CASE
		WHEN d->>'runId' IS NOT NULL THEN 'ended'
		WHEN at_ms > extract(epoch from now()) * 1000 - 21600000 THEN 'dispatched'
		ELSE 'unreported'
	END,
	(d->>'runId')::integer,
	(SELECT "id" FROM "users" WHERE "users"."id" = (d->>'byUserId')::integer),
	d->>'byName',
	to_timestamp(at_ms / 1000.0) AT TIME ZONE 'UTC',
	to_timestamp(at_ms / 1000.0) AT TIME ZONE 'UTC'
FROM (
	SELECT
		"id" AS cluster_id,
		"project_id",
		"last_rerun_dispatch" AS d,
		COALESCE(("last_rerun_dispatch"->>'at')::double precision, 0) AS at_ms
	FROM "failure_clusters"
	WHERE jsonb_typeof("last_rerun_dispatch") = 'object'
		AND "last_rerun_dispatch"->>'provider' IS NOT NULL
) AS stored
ON CONFLICT ("id") DO NOTHING;
