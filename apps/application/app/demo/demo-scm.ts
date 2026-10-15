/**
 * Canned source-control history for demo mode.
 *
 * The real dashboard grounds an AI diagnosis in the code that changed by talking
 * to a live SCM provider (GitHub/GitLab/Bitbucket) over the network. The demo has
 * no server and no repo, so this module serves a small, believable repository
 * history — commits, authors, dates, and unified-diff patches — per demo project.
 *
 * All of the data comes from the failure-story fixture module
 * (`#shared/demo/failure-stories.mjs`): the source files are the same arrays the
 * seeded errors, snippets and line numbers derive from, the commit lists include
 * every story's suspect commit, and the suggested-fix patches are derived from
 * (and therefore always apply against) those same sources. This module only
 * shapes that data for the demo API surfaces:
 *  - the commit picker / browser and baseline diff (app/demo/api/scm.ts)
 *  - the "SCM diff since last green" + "Source files" context sections
 *    (app/demo/api/diagnosis-context.ts)
 *  - the diagnosis `autoSelectedCommits` and the verifiable suggested-fix patch
 *    (app/demo/api/ai.ts and scripts/generate-demo-seed.mjs)
 *  - a covered file's source at the git blob its coverage names (the execution
 *    page's Coverage section)
 */

import { sameFilePath } from '@piwitests/core/locator-break';
import type { ScmChangedFile, ScmChanges, CommitListItem } from '~~/types/api';
import type { SourceAtBlob } from '~~/server/utils/source-at-blob';
import { gitBlobId } from '#shared/utils/hash';
import {
  FAILURE_STORIES,
  SCM_REPOS,
  projectCoveredFilePaths,
  projectSourceFilePaths,
  sourceText,
} from '#shared/demo/failure-stories.mjs';

export interface DemoCommit {
  sha: string;
  message: string;
  author: string;
  /** ISO-8601 timestamp. */
  date: string;
  branch: string;
  files: ScmChangedFile[];
}

export interface DemoScmProject {
  repositoryUrl: string;
  defaultBranch: string;
  branches: string[];
  /** Newest first. */
  commits: DemoCommit[];
  /** SHAs the diagnoses flag as most-suspect (fed into `autoSelectedCommits`). */
  suspectShas: string[];
  /** Full source files shown to the model to ground patch suggestions. */
  sourceFiles: Array<{ path: string; content: string }>;
}

// ── Per-project canned repositories (assembled from the fixture module) ─────

export const DEMO_SCM_PROJECTS: Record<number, DemoScmProject> = Object.fromEntries(
  Object.entries(SCM_REPOS).map(([pid, repo]) => {
    const projectId = Number(pid);
    const suspectShas = FAILURE_STORIES.filter((s) => s.projectId === projectId).map((s) => s.suspectSha);
    return [
      projectId,
      {
        repositoryUrl: repo.repositoryUrl,
        defaultBranch: repo.defaultBranch,
        branches: repo.branches,
        commits: repo.commits as DemoCommit[],
        suspectShas: [...new Set(suspectShas)],
        sourceFiles: projectSourceFilePaths(projectId).map((path) => ({ path, content: sourceText(path) })),
      } satisfies DemoScmProject,
    ];
  }),
);

// ── Suggested-fix patches ────────────────────────────────────────────────────
// One verifiable fix per failure story, derived by the fixture module from the
// same source arrays served above — `validatePatch` (via #shared/patch) reports
// `applies` for every one of them by construction.

export const DEMO_FIX_PATCHES: Record<string, { file: string; patch: string }> = Object.fromEntries(
  FAILURE_STORIES.map((s) => [s.key, { file: s.diagnosis.fix.file, patch: s.diagnosis.fix.patch }]),
);

/** All seeded source files across every demo project, keyed by repo-relative path. */
export function allDemoSourceFiles(): Map<string, string> {
  const map = new Map<string, string>();
  for (const proj of Object.values(DEMO_SCM_PROJECTS)) {
    for (const f of proj.sourceFiles) map.set(f.path, f.content);
  }
  return map;
}

/**
 * The source of a file of a project's canned repository at a git blob: the
 * authored file, among its source files and the files its coverage names,
 * whose path matches `path` and whose git blob id is `blob`. Null when the
 * repository holds no such version.
 */
export async function getDemoSourceAtBlob(projectId: number, path: string, blob: string): Promise<SourceAtBlob | null> {
  if (!getDemoScmProject(projectId)) return null;
  const wanted = blob.toLowerCase();
  const candidates = new Set([...projectSourceFilePaths(projectId), ...projectCoveredFilePaths(projectId)]);
  for (const candidate of candidates) {
    if (!sameFilePath(candidate, path)) continue;
    const content = sourceText(candidate);
    if ((await gitBlobId(content, wanted.length === 64 ? 'sha256' : 'sha1')) === wanted) {
      return { path, blob: wanted, content };
    }
  }
  return null;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

export function getDemoScmProject(projectId: number): DemoScmProject | null {
  return DEMO_SCM_PROJECTS[projectId] ?? null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Commit list in the shape the commit picker/browser expects. */
export function listDemoCommits(projectId: number, limit = 50, branch?: string): CommitListItem[] {
  const proj = getDemoScmProject(projectId);
  if (!proj) return [];
  const commits = branch ? proj.commits.filter((c) => c.branch === branch) : proj.commits;
  return commits.slice(0, limit).map((c) => ({
    sha: c.sha,
    shortSha: shortSha(c.sha),
    message: c.message,
    author: c.author,
    date: c.date,
  }));
}

/** File-level diff for a single commit (ScmChanges shape). */
export function getDemoCommitDiff(projectId: number, sha: string): ScmChanges | null {
  const proj = getDemoScmProject(projectId);
  if (!proj) return null;
  const commit = proj.commits.find((c) => c.sha === sha || shortSha(c.sha) === sha);
  if (!commit) return null;
  return {
    commits: [{ sha: commit.sha, message: commit.message }],
    files: commit.files,
    patchesOmitted: false,
  };
}

/** Aggregate all commits newer than (and excluding) the baseline SHA. */
export function getDemoChangesSince(projectId: number, baselineSha: string | null): ScmChanges | null {
  const proj = getDemoScmProject(projectId);
  if (!proj) return null;
  let commits = proj.commits;
  if (baselineSha) {
    const idx = proj.commits.findIndex((c) => c.sha === baselineSha || shortSha(c.sha) === baselineSha);
    // Commits are newest-first; everything before the baseline index is newer.
    commits = idx >= 0 ? proj.commits.slice(0, idx) : proj.commits;
  }
  return aggregateCommits(commits);
}

/**
 * The range a demo cluster's What changed reads with no baseline picked, full
 * SHAs: from the project's oldest commit, as if it were the last passing run's,
 * to its newest. The diagnosis context diffs it and the suspect lines join it.
 */
export function getDemoDefaultRange(projectId: number): { from: string; to: string } | null {
  const commits = getDemoScmProject(projectId)?.commits;
  const newest = commits?.[0];
  const oldest = commits?.[commits.length - 1];
  return newest && oldest ? { from: oldest.sha, to: newest.sha } : null;
}

/** Aggregate an explicit set of selected commit SHAs. */
export function getDemoChangesForShas(projectId: number, shas: string[]): ScmChanges | null {
  const proj = getDemoScmProject(projectId);
  if (!proj) return null;
  const set = new Set(shas);
  const commits = proj.commits.filter((c) => set.has(c.sha) || set.has(shortSha(c.sha)));
  return aggregateCommits(commits);
}

function aggregateCommits(commits: DemoCommit[]): ScmChanges {
  // Merge file entries by filename, concatenating patches and summing stats.
  const byFile = new Map<string, ScmChangedFile>();
  for (const c of commits) {
    for (const f of c.files) {
      const existing = byFile.get(f.filename);
      if (existing) {
        existing.additions += f.additions;
        existing.deletions += f.deletions;
        if (f.patch) existing.patch = existing.patch ? `${existing.patch}\n${f.patch}` : f.patch;
      } else {
        byFile.set(f.filename, { ...f });
      }
    }
  }
  return {
    commits: commits.map((c) => ({ sha: c.sha, message: c.message })),
    files: [...byFile.values()],
    patchesOmitted: false,
  };
}

/** Aggregate stats for the commits since a baseline (for the commit browser header). */
export function getDemoAggregate(
  projectId: number,
  baselineSha: string,
): { filesChanged: number; linesAdded: number; linesRemoved: number } | null {
  const changes = getDemoChangesSince(projectId, baselineSha);
  if (!changes) return null;
  return {
    filesChanged: changes.files.length,
    linesAdded: changes.files.reduce((s, f) => s + f.additions, 0),
    linesRemoved: changes.files.reduce((s, f) => s + f.deletions, 0),
  };
}
