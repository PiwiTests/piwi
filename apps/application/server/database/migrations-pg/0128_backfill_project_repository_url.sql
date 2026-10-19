-- Custom SQL migration file, put your code below! --

-- Pin each project to the repository its latest run with a remote URL names.
UPDATE projects
SET repository_url = latest.url
FROM (
	SELECT DISTINCT ON (t.project_id) t.project_id, btrim(t.metadata #>> '{scm,remoteUrl}') AS url
	FROM test_runs t
	WHERE jsonb_typeof(t.metadata #> '{scm,remoteUrl}') = 'string'
		AND btrim(t.metadata #>> '{scm,remoteUrl}') <> ''
	ORDER BY t.project_id, t.start_time DESC, t.id DESC
) AS latest
WHERE latest.project_id = projects.id AND projects.repository_url IS NULL;
--> statement-breakpoint
-- `git@host:owner/repo` reads as `https://host/owner/repo`; `ssh://` and `git://` remotes over https.
UPDATE projects
SET repository_url = regexp_replace(
	regexp_replace(repository_url, '^git@([^:/]+):', 'https://\1/'),
	'^(ssh|git)://',
	'https://'
)
WHERE repository_url IS NOT NULL;
--> statement-breakpoint
-- Credentials never stay in the URL; no trailing slash, no `.git` suffix.
UPDATE projects
SET repository_url = regexp_replace(
	regexp_replace(regexp_replace(repository_url, '^(https?://)[^/]*@', '\1'), '/+$', ''),
	'\.git/*$',
	''
)
WHERE repository_url IS NOT NULL;
--> statement-breakpoint
-- Anything else that is not a web URL with an owner and a repository pins nothing.
UPDATE projects
SET repository_url = NULL
WHERE repository_url IS NOT NULL AND repository_url !~ '^https?://[^/@]+/[^/].*$';
