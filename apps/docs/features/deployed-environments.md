---
title: Deployed environments
description: "How Piwi reads a Playwright run against a deployed environment, whose application is not the tests' commit: the deployed commit, the application's changes, the first failing deploy and what bisect can find."
lang: en-US
---

# Deployed environments

A deployed environment, such as Staging or Production, runs whatever version of the application was last deployed
there, whatever the commit of the tests that run against it. Piwi reads a run of one as two versions: the tests', the
run's commit, and the application's, its **deployed commit**. An environment, a discovered one included, is built
from the checkout until a project admin turns its **Built from the checkout** setting off
([Environments](./environments#built-from-the-checkout-or-deployed)): only then is it deployed. The setting also tells
an agent, through the MCP tool `list_environments`, whether a failure's commit holds the code that ran.

## The deployed commit

The first source that names one wins:

1. **The server under test** reports the commit it was built from (`appCommit`), through an
   [instrumentation package](/guide/backend-logs#server-environment).
2. **A deploy marker** of the environment carries the commit its pipeline deployed
   ([Recording deploys from CI](./timeline-markers#recording-deploys-from-ci)): a run takes the latest one before it
   started.

With neither, the deployed version is unknown, and every view below says it may differ from the run's commit.

The application is assumed to live in the project's repository, as in a monorepo: the commits between two deployed
commits are read there, with the project's [source control](/guide/source-control) credential. For an application
kept in another repository, only its deployed commits mean something: the range and the suspect lines look for them in
the project's repository.

## What changes for a run of a deployed environment

- **The run page** names the deployed commit in its facts line (`app a1b2c3d`), and **Details → Application** says
  where it comes from.
- **The Changes tab** adds a **Deployed to Staging** card beside the tests' commits: the deployed commit of both runs,
  the application's commits between them, and the environment's deploy markers between the two runs
  ([What changed in a run](./run-changes)).
- **[Suspect lines](./server-coverage#suspect-lines)** are read on the application's range, from the last green run's
  deployed commit to the failing run's, since the coverage is the deployed application's. With the run's deployed
  commit unknown, they are read on the tests' range, and say so.
- **[Uncovered changes](./uncovered-changes)**: what the run reached of the application is the deployed version's.
  When that is not the change's head, or is unknown, the answer and the pull request comment say so, and the reach
  counts as any run's.
- **The [AI diagnosis](./ai-diagnosis)** gets an Environment Under Test section: the environment's name and
  description, whether it is built from the checkout, the deployed commits, the application's range and the deploy
  markers.
- **Bisect** walks the tests' commits, so against a deployed environment it can find a change of the tests, never one
  of the application. The Reproduce section and the [fix plan](./fix-plans) list the deploys between the last passing
  run and the failing one instead.

## The first failing deploy

A [failure cluster](./failure-clusters) first seen in a deployed environment names its **first failing deploy**: the
deploy marker between the last run of that environment where one of its tests passed and the run it first failed in.
When several fall there, the latest is the one the first failing run tested. When none does, the line says that no
deploy happened since the last pass: as far as the markers tell, the application did not change, so the tests, the
data or the infrastructure did.

The cluster's **What changed** line leads with it, the execution page's since line names it ("New regression after
Staging deploy 7 (a1b2c3d) on Staging"), and the AI diagnosis and the MCP tool `get_cluster` (`firstFailingDeploy`)
carry it with both runs' deployed commits.

## An environment's activity

In **Project → Settings → Environments**, each environment opens its activity: its last run, its last
[environment incident](./environment-incidents), its deploy markers with their commits, and for a deployed one the
commits and application versions its recent runs ran against, each with where the commit came from.

## Limits

- A deploy marker counts for the environment it names. A marker with no environment counts for none.
- A deployed commit from a deploy marker is the commit posted, not proof of what the servers run: a server that reports
  its own wins over the marker.
- Bisect never walks the history of an application kept in another repository.

## Related

- [Environments](./environments)
- [Timeline markers](./timeline-markers)
- [What changed in a run](./run-changes)
- [Failure clusters](./failure-clusters)
- [Backend instrumentation](/guide/backend-logs)
- [Glossary: deployed environment](/guide/concepts#deployed-environment)
