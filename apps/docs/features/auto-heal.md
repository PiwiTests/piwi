---
title: Auto-heal PRs
description: "Piwi opens a pull request with a validated locator replacement or patch for a failure; you review and merge it, Piwi never does."
lang: en-US
---

# Auto-heal PRs

<Needs reporter fixtures scm admin />

When a locator breaks on your default branch and Piwi has high-confidence evidence for the replacement, it can open the
fix pull request itself: a branch, a one-line locator edit per broken call site, and a body that shows the change, the
score, where the replacement came from, and the command that verifies it. The CI gate runs on the PR like any other,
and [fix verification](./failure-clusters#did-the-fix-work) records the cluster as fixed once the tests pass.

It is **off by default**, and even once on it acts only on projects you list. Writing to your repository is the
strongest thing the dashboard does, so the posture is conservative by design.

## What it does, exactly

- Triggers only on a **full run on the default branch** — never a feature branch, and never a run reported from a
  heal branch (that would feed on itself). A run that recorded no branch at all is treated as the default branch.
- Edits are **deterministic one-line locator rewrites** taken from a passing run's captured snapshot, or from the
  run's own diff renaming the string the locator finds its element by. No AI-generated code is ever in the write path.
- Each edit must come from a stored snapshot (`prior-run`, `fingerprint`, or `cross-test`) or a
  [diff rename](./locator-healing#what-it-does) (`diff-rename`, scored 95) and score at or above the configured
  minimum — or be a locator **you confirmed** in the picker. A snapshot whose element name is gone from the failing
  page is skipped unless you confirmed the pick.
- Before committing, Piwi re-reads each file at the branch head and only writes lines it can still match exactly. A
  line that has drifted is dropped, not guessed.
- One PR per run, batching every qualifying edit. A duplicate run never opens a second PR for the same edits while
  their PR is open, however long it stays open; an attempt that failed or was skipped is retried by the next run that
  qualifies.

## After the PR opens

- **Closed without merging** — Piwi takes that as a no. An edit the closed PR carried (the same file, failing locator
  and replacement) is not proposed again, unless someone picks that replacement in the
  [locator picker](./locator-healing#use-it) after the PR was closed.
- **A run on the heal branch** — CI runs reported from the PR's branch are linked to the heal action. The first one
  in which every healed test passes is recorded as verified on the branch, and Piwi comments on the PR once to say so.
  It never marks a draft ready for review: that stays your call.
- **Merged** — the heal commit carries a `Piwi-Heal` trailer. When [fix verification](./failure-clusters#did-the-fix-work)
  finds it among the commits since the cluster last failed, the fix names the PR: in the pull-request comment, and as
  `healPr` on the [`cluster.fixed` event](/reference/notification-events). Keep the trailer when you squash.

## Requirements

- **`PIWI_SITE_URL`** must be set, so the links in the PR body resolve.
- A run that recorded its git remote URL (the reporter's `collectScmInfo`, on by default), and the **capture
  fixtures**, which record the snapshots every edit but a diff rename comes from.
- An **SCM token with write scope**, resolved as [Source control](/guide/source-control#set-the-token) describes: a per-project token, falling back
  to the global one. It needs:
  - **GitHub** — `repo` (classic), or a fine-grained token with `contents: write` + `pull_requests: write`.
  - **GitLab** — `api`.
  - **Bitbucket** — an access token that can write to the repository. Bitbucket Cloud has no draft pull requests, so
    the draft setting is ignored there.

Prefer a **per-project token** for auto-heal: the global token grants write everywhere it reaches.

## Enable it

Settings → Auto-heal (administrator only):

- **Open pull requests to heal broken locators** — the master switch.
- **Projects** — the explicit allowlist. Auto-heal ignores any project not listed.
- **Minimum score** — the stability score an edit needs (default 80). A confirmed pick is always eligible.
- **Open as draft** — open PRs as drafts (default on; ignored on Bitbucket).
- **Max open PRs** — a per-project ceiling on auto-heal PRs still open on your repository (default 3). Piwi checks
  the SCM for each PR it opened every ten minutes, and whenever the ceiling is reached, so a merged or closed PR
  stops counting.
- **Branch prefix** / **commit message** — the branch namespace (default `piwi/heal/`) and the commit subject
  (default `test: heal broken locators`, a conventional-commit subject so your commit lint accepts it).

## Limits

- **GitHub** (github.com), **GitLab** (gitlab.com, or a self-hosted host whose name contains `gitlab`) and
  **Bitbucket Cloud** (bitbucket.org) are supported; GitHub Enterprise and Bitbucket Server / Data Center are not.
- The default branch is resolved per project — an explicit setting in project settings, else the repository's default
  branch from the SCM provider, else the reporter's `defaultBranch` hint, else the branch most of the project's runs are on, else `main` — so the "default branch only" guard applies even when the reporter
  recorded no `defaultBranch` in its metadata.
- Retries use progressive backoff and record the provider's own error on the action, so a failure is visible rather
  than silent.
