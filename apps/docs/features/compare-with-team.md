---
title: Compare with team instance
description: 'In the Piwi desktop app, see whether a Playwright test that fails on your machine fails in your team’s CI too: the same error, each environment’s results, and what differs from the closest CI pass.'
lang: en-US
---

# Compare with team instance

<Needs desktop />

A test fails in the desktop app, on your machine. Compare with team instance answers the first question you ask: is it
this machine, or does the CI see it too? The desktop app asks the team instance it is connected to how the same test
does in that project's CI, and shows the answer on the failure's page, with the facts behind it. Nothing runs, and
your run's results, its error and your machine's environment stay on your machine.

## What it shows

On a failing execution, the situation block gets a **Team CI** line:

- **One sentence of conclusion**, from the rules below, with a link to what it read on the team instance: the cluster
  of the same error, or the CI execution.
- **The test's results on the team instance**, one strip per environment its CI ran it in (`mco`, `integration`), the
  environment of your run first, and one strip for your teammates' own runs reported there, each with its pass rate.
  A busy environment never hides the others: each keeps its latest results.
- **Open on the team instance**, which opens the test's page there in your browser.
- **The environment differences from the closest CI pass**, in a side panel.

The test's own page shows the same strips in a **Team CI** card, without the conclusion. Neither shows while the app
is connected to no team instance, or the project's folder is linked to no project of it.

The results are the team's CI runs. Your teammates' runs show apart and never count in the conclusion: their machines
are not the reference. A run someone asked for with [Run on my machine](./run-on-my-machine) is theirs alone and never
shows, nor do Flake Lab and bisect runs.

## The conclusion

The sentence comes from the first rule that applies. When your run has an [environment](./environments), the rules
read that environment's CI results alone, since two deployed environments do not run the same application; the team
instance reads your run's label as it reads a run's, so an alias names its environment. A CI run marked as an
[environment incident](/guide/concepts#environment-incident) never counts.

1. **Same error in CI**: the team instance holds the same error in a [failure cluster](./failure-clusters), seen in CI
   in the last 30 days, in your run's environment. The failure is not specific to your machine. A CI failure a retry
   passed counts too.
2. **Passes in CI on this commit**: the latest CI result on the commit you ran passed, so the failure is likely
   specific to your machine. When your checkout had uncommitted changes, the sentence says so instead.
3. **Fails in CI too**: the latest CI result on your commit, else the latest one, failed. When the fingerprints could
   be compared, the sentence adds that the error is another one than yours.
4. **Passes in CI on another commit**: the latest CI result passed, on a commit that differs from yours or that one of
   the two runs did not record, so there is no conclusion to draw yet.
5. **No CI result to compare with**.

The same error is found by the failure's fingerprint, which both servers compute the same way. When the desktop app and
the team instance run Piwi versions that compute it differently, the sentence never claims the error is new: rule 1 is
left out.

## What differs from the closest CI pass

The [closest CI pass](/guide/concepts#closest-ci-pass) is the passing CI execution your run is compared with. The side
panel lists what differs between the two, as the [environment diff](./evidence) of a failure does against the last
pass: the time zone and locale of the machine and the browser, headless or not, the Playwright, Node and browser
versions, the viewport, the operating system, the CI image. The keys that always differ between a machine and the CI
(the branch, the CI provider, the reporter's version) show apart, as varying naturally. A difference is a fact to
check, never the verdict: the side panel says which run it compared with, and opens it on the team instance.

## Setting it up

- **Connect the desktop app to the team instance**: **Settings → Desktop app → Connect**, then allow **Piwi Desktop**
  on the instance's page. The instance needs sign-in turned on, since the connection's key belongs to you. The same
  connection takes [Run on my machine](./run-on-my-machine) requests where an administrator turned it on; the
  comparison works either way.
- **Link the project's folder** to the team project in the same card, as Run on my machine does. The comparison reads
  the team project of the folder your local project is linked to.
- A connection made before the comparison existed cannot compare: the card says so, and connecting again replaces it.

It is on for every project. An administrator declines it for the instance on **Settings → Capabilities**, and a
project in its own settings, where a project can also turn it back on for itself: the team instance then refuses or
serves each comparison by those decisions.

## What leaves your machine

The desktop app sends the team instance the test's name and file, its Playwright project, your run's environment
label, branch and commit, and the fingerprint of the failure. It never sends the error's text, your machine's
environment or your code: it compares the environments itself. It reads only what you could read on the team
instance in a browser, with the key of its connection, and keeps each answer in memory for two minutes.

## Related

- [The desktop app](./desktop)
- [Run on my machine](./run-on-my-machine)
- [Environments](./environments)
- [Failure clusters](./failure-clusters)
