-- Custom SQL migration file, put your code below! --

-- Pin each project to the repository its latest run with a remote URL names.
UPDATE projects
SET repository_url = (
	SELECT trim(json_extract(t.metadata, '$.scm.remoteUrl')) FROM test_runs t
	WHERE t.project_id = projects.id
		AND json_valid(t.metadata)
		AND json_type(t.metadata, '$.scm.remoteUrl') = 'text'
		AND trim(json_extract(t.metadata, '$.scm.remoteUrl')) <> ''
	ORDER BY t.start_time DESC, t.id DESC
	LIMIT 1
)
WHERE repository_url IS NULL;
--> statement-breakpoint
-- `git@host:owner/repo` reads as `https://host/owner/repo`.
UPDATE projects
SET repository_url = 'https://' || substr(repository_url, 5, instr(repository_url, ':') - 5)
	|| '/' || substr(repository_url, instr(repository_url, ':') + 1)
WHERE repository_url LIKE 'git@%:%';
--> statement-breakpoint
-- `ssh://` and `git://` remotes read over https.
UPDATE projects
SET repository_url = 'https://' || substr(repository_url, 7)
WHERE repository_url LIKE 'ssh://%' OR repository_url LIKE 'git://%';
--> statement-breakpoint
-- Credentials never stay in the URL: drop what precedes the `@` of the authority.
UPDATE projects
SET repository_url = substr(repository_url, 1, instr(repository_url, '://') + 2)
	|| substr(repository_url, instr(repository_url, '@') + 1)
WHERE (repository_url LIKE 'https://%' OR repository_url LIKE 'http://%')
	AND instr(repository_url, '@') > 0
	AND instr(repository_url, '@') < instr(repository_url, '://') + 2
		+ instr(substr(repository_url, instr(repository_url, '://') + 3) || '/', '/');
--> statement-breakpoint
-- No trailing slash, no `.git` suffix.
UPDATE projects
SET repository_url = rtrim(repository_url, '/')
WHERE repository_url IS NOT NULL;
--> statement-breakpoint
UPDATE projects
SET repository_url = rtrim(substr(repository_url, 1, length(repository_url) - 4), '/')
WHERE repository_url LIKE '%.git';
--> statement-breakpoint
-- Anything else that is not a web URL with an owner and a repository, or that
-- still carries an `@` before its path, pins nothing.
UPDATE projects
SET repository_url = NULL
WHERE repository_url IS NOT NULL
	AND (
		NOT (repository_url LIKE 'https://%/%' OR repository_url LIKE 'http://%/%')
		OR instr(substr(repository_url, instr(repository_url, '://') + 3), '@') BETWEEN 1 AND
			instr(substr(repository_url, instr(repository_url, '://') + 3) || '/', '/')
	);
