---
title: Leak history in CI
description: "How Piwi follows each resource leak across runs, decides when it is fixed or new to a branch, and blocks a merge or comments on a pull request with it."
lang: en-US
---

# Leak history in CI

<Needs reporter fixtures />

The [resource leaks](./resource-leaks) each run reports are kept across runs, so a pull request can be held to the leaks
it adds, and a fix is known to have held.

## Each finding's history

Each finding keeps a history: the run it was first seen in and the runs that showed it. A finding is known by the line
or fixture that opened it, so renaming its test or fixture, or opening and closing another context in its file, keeps
its history. A leak that an edit above its line moved keeps it too.

Only a full run of the default branch changes a finding. A leak is fixed once five such runs came without it, each able
to have shown it: with the fixtures on, its report not cut at the 100 findings the dashboard keeps, and a test of the
leak's file passed while none failed, was interrupted or did not run. What such a test left open is never judged, so
with one anywhere in the run, a leak a fixture or a helper opened is not counted either. Such a run that shows the leak
again reopens it. Any other run, a partial run or a branch forked before the fix, only adds its showing. On the Resources tab each finding says whether it is new to
the base branch (the pull request's target, else the default branch), or since which run it has been there.

## Where CI reads it

Three places read it:

- [`piwi gate`](/guide/ci#blocking-a-merge): `--max-leaks <n>` fails when the run left more than `n`
  objects open, counted per opening line; `--max-new-leaks <n>`, when more than `n` were never seen on the base branch.
  A run that sent no resource report fails either rule rather than passing on silence, and so does a run of a project
  that declined the **Resources** capability, whose leaks are not measured. Neither counts a lingering object.
- The [pull-request comment](./pr-feedback) lists each leak the branch introduces under **Left open by this change**,
  and each open leak of the default branch that a full run of the branch no longer shows under **Closed by this
  change**.
- Agents read `list_resource_findings` and `get_resource_profile` over [MCP](/reference/mcp-tools).

```bash
npx @piwitests/reporter gate --max-new-leaks 0
```

## Related

- [Resource leaks](./resource-leaks): what a run reports, and how to fix each finding
- [Pull-request feedback](./pr-feedback): the comment that lists the leaks a branch adds
- [CI & sharding](/guide/ci#blocking-a-merge): the gate's other policies
