---
title: Agent skills
description: "Seven SKILL.md files, installed by the reporter's CLI, that teach a coding agent what to do with Piwi's evidence: investigate a failure, heal a locator, fix a flaky test, write the missing one."
lang: en-US
---

# Agent skills

<Needs reporter />

The [MCP server](/features/mcp) gives an agent read access to your results; **skills** tell it what to *do* with them.
A skill is a single `SKILL.md` file, the portable open format (front matter plus Markdown instructions) that Claude
Code and other coding agents read from a project's skills directory. Piwi ships seven, and the reporter's CLI installs
them into your test project.

## What each skill does

| Skill | What it does |
|------|--------------|
| `setup-piwi` | Wire a Playwright project up to a dashboard: the same work `npx @piwitests/reporter init` does, driven by an agent. |
| `investigate-failure` | Investigate a failed run and propose a fix grounded in Piwi's evidence: error, steps, console, network, and the diff since the last green run. |
| `apply-locator-healing` | Replace a brittle locator with Piwi's ranked [healed locator](/features/locator-healing) at its call site, then re-run to confirm. |
| `stabilize-flaky-tests` | Reproduce the highest-impact [flaky tests](/features/flaky-tests) with the [Flake Lab](/features/flake-lab), fix what the reproducing condition points at (never by adding retries), then prove it with `piwi flake verify`. |
| `run-the-right-tests` | After a UI change, fix the locators it breaks with [preflight](/features/preflight); run the tests a change [impacts](/features/change-impact), down to those that ran the changed lines; or pick and run the right [selection](/features/test-selection) for the task (smoke, recently broken, a time budget) instead of the whole suite. |
| `write-the-missing-test` | Take the top [scenario gap](/features/scenario-gaps) in scope, draft it from the graph, finish the assertion and add it in the same change. |
| `fix-a-reported-bug` | Take a [bug report](/features/bug-reports), write its failing test with `piwi bug <id> --write`, reproduce, fix, then remove `test.fail()` and run the spec and the tests that visit the page. |

Each skill prefers a connected Piwi [MCP tool](/reference/mcp-tools) and falls back to the dashboard UI when MCP is
not connected, so a skill works before the MCP server is set up, only more slowly.

## What agents report back

Each workflow skill ends by telling Piwi what the agent did, so the next diagnosis, the fix verification and the gap
detectors learn from it:

| Skill | Reports back with |
|------|--------------|
| `investigate-failure` | `record_diagnosis` (its own diagnosis, shown as written by an agent), `submit_diagnosis_feedback` (a rating of Piwi's) and `report_fix_attempt` (the change, its commit and the diagnosis it followed) |
| `apply-locator-healing` | `report_fix_attempt` with the locator edit |
| `write-the-missing-test` | `triage_gap` (accepted, covered by a test, or dismissed with a reason) |

The fix's commit carries a `Piwi-Cluster: <id>` trailer, the line `get_fix_plan` suggests. When the cluster's tests
pass on a later commit, Piwi records the attempt **verified**, tied by its commit, the trailer or its branch; a later
failure records it **regressed**. The cluster page's **Activity** section lists every attempt and every write an agent
made to the cluster over MCP, with the API key it used.

## Where it is

The skills ship inside the reporter package. `npx @piwitests/reporter init` installs the six workflow skills as part
of setup (everything but `setup-piwi`, which an agent runs before the reporter exists). The **MCP server** page of the
dashboard (`/mcp`) lists them next to the tools.

## Use it

```bash
npx @piwitests/reporter skills add          # install all seven into .claude/skills/
npx @piwitests/reporter skills list         # see what each one does
npx @piwitests/reporter skills add investigate-failure --dir .cursor/skills   # one skill, elsewhere
```

Invoke the CLI through the package name so npx resolves this package; a plain `npx piwi …` works once the reporter
is a project dependency. `init` takes `--skills <list>` (or `all`, `none`), `--skills-dir` and `--no-skills` to
change what setup installs. The [CLI reference](/reference/cli#skills) lists every flag.

The skills are agent-agnostic Markdown: only the destination is tool-specific, so `--dir` points the install wherever
your agent reads skills from. Each installed file carries `piwi-version` and `piwi-hash` in its front matter. A later
`skills add` replaces a skill you never touched that an older release installed, reporting it **outdated**, and keeps
one you **edited** unless you pass `--force`.

On the [desktop app](/features/desktop), the MCP server page also installs the workflow skills into a project's
linked folder, with the same rules.

Once installed, ask in plain words: "why did the last CI run fail", "fix the flaky checkout test", "write the test
we're missing for this change". The agent picks the skill whose description matches.

## Prompts, the no-install alternative

The MCP server also serves every workflow skill as a **prompt**, which a client shows as a slash command with nothing
to install: `investigate_failure`, `apply_locator_healing` and the rest, each with an optional `focus` (a run, a
cluster, a test). The text is the skill shipped with the server's own version. A `setup_piwi` prompt knows this
instance's URL, whether it requires an API key and its existing projects, which a static skill cannot. Prompts need
MCP; installed skills work offline. See [MCP server](/features/mcp#prompts).

## Limits

- **Instructions, not code.** A skill tells an agent which evidence to read and in which order; the agent still
  writes the fix, and you review it.
- **Updated with the reporter.** A newer reporter ships newer skills; `skills add` updates the copies you never
  edited, and `--force` replaces the edited ones too.
- **Reporting back needs write access.** The write-back tools need a key whose owner holds the matching
  [project role](/operate/project-access#what-each-role-can-do) (Maintainer covers all of them); with a Viewer's key
  the agent reports what it did to you instead.

## Related

- [MCP server](/features/mcp): the tools the skills call
- [MCP tools](/reference/mcp-tools): every tool, by module
- [Piwi CLI: skills](/reference/cli#skills): every flag of `skills` and `init`
