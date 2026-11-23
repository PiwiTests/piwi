---
title: Fails on CI, passes locally
titleTemplate: "Playwright test: :title | Piwi"
description: "A Playwright test fails on CI and passes on your machine: see what differs between the two, check that it is the cause, reproduce it locally, then pin it in the config."
lang: en-US
---

# Why does my Playwright test fail on CI but pass on my machine?

Something differs between the two machines, and when the test reads a date, a price or a sorted list, it is often
the time zone or the language. A CI runner usually runs in `UTC` with `en-US`, your laptop in its own, and a browser
takes both from its machine unless the Playwright config sets them.

Piwi records where each run executed, so you can read what differs and prove it before changing anything.

## 1. See what differs

The run page's **Environment** line names the runner's time zone, locale, OS and Node.js version. Click it for every
snapshot, shard by shard: the runner, each browser, each server under test
([what each records](/features/run-environment)).

Then put the failure next to a pass:

- **Your machine's run.** Report a run of the test from your machine to the same project, select it and the CI run
  on the project's **Runs** tab, and **Compare**: the **Changes** tab's **Environment changes** section lists the
  fields that differ ([comparing two runs](/features/run-changes#picking-another-baseline)).
- **The test's last pass.** The failing execution's **State** tab diffs its environment against the test's last
  passing execution ([which one](/features/run-changes#one-execution-s-baseline)).

The runner's fields need only the reporter. A browser's own time zone and locale need the
[capture fixtures](/guide/capture-fixtures): without them, the diff infers them from the config, else the runner, and
labels them so. A server under test answers only through an
[instrumentation package](/guide/backend-logs#server-environment). Nothing recorded, from an older reporter or with
collection off? Print the time zone and locale in a CI step and in your terminal:

```bash
node -e "console.log(Intl.DateTimeFormat().resolvedOptions())"
```

## 2. Check whether it is the cause

A test that has ever passed on a retry has a **Flakiness** tab. Its suspects include the runner's time zone or
locale when the test's failures share one value and its passes another, which takes both sides in its
default-branch history: CI's failures, and passes reported from somewhere else, such as your machine
([how suspects are found](/features/flaky-tests#suspects)).

<figure>
  <img src="/screenshots/flakiness-tab.png" alt="A flaky test's Flakiness tab: two suspects with their counts among failures and passes, the lab condition and result of each, the context a lab cannot apply, and the experiment that reproduced the flake">
  <figcaption>A test's suspects, each with the condition the Flake Lab applies to test it.</figcaption>
</figure>

A suspect is a correlation. The [Flake Lab](/features/flake-lab) turns it into a verdict: it runs the test with the
browser in the suspect's time zone or locale, next to a control run, and says whether the failure reproduces.
**Copy command** on the tab gives the command, with the test's id:

```bash
npx @piwitests/reporter flake 1842
```

It needs the capture fixtures, which apply the condition inside the page, and the reporter's `PIWI_DASHBOARD_URL` and
`PIWI_API_KEY`; the [desktop app](/features/flake-lab#in-the-desktop-app) runs it for you. The lab sets the browser
only, so a date your test code computes in Node.js does not follow it. Without the fixtures, for a test that fails on
every CI attempt and so has no Flakiness tab, or for a date computed outside the browser, the
[next step](#_3-reproduce-it-on-your-machine) is the same check by hand.

## 3. Reproduce it on your machine

Run the test with CI's time zone and `LANG`, as its runner snapshot shows them.

From Piwi, make them the project's [run variables](/features/run-variables): a project admin adds a `TZ` row and a
`LANG` row in **Project → Settings → Run variables**. Every run Piwi starts for the project then gets them:
[Run on my machine](/features/run-on-my-machine) from the desktop app or [Piwi Runner](/features/piwi-runner), and the
editors' runs. Every command Piwi gives to copy, such as a run's retry command, starts with them. Run on my machine
is experimental and off until an administrator turns it on; a copied command needs no app. Run variables apply to
everyone on the project, so remove the rows when you are done, unless CI's values should be everyone's.

Not a project admin, or not running it through Piwi: set them in the terminal.

::: code-group

```bash [Linux / macOS]
TZ=UTC LANG=en_US.UTF-8 npx playwright test
```

```powershell [Windows (PowerShell)]
$env:TZ='UTC'; $env:LANG='en_US.UTF-8'; npx playwright test
```

:::

An `LC_ALL` set on your machine wins over `LANG`. On Windows, `LANG` changes the locale of neither Node.js nor the
browser, and a browser may not follow `TZ`: the PowerShell command reproduces neither reliably. Pin
`use.timezoneId` and `use.locale` in the config instead, the next step.

## 4. Fix it for good

Pin the browser's time zone and locale in the Playwright config, so the browser runs the same on every machine,
Windows included:

```ts
// playwright.config.ts
export default wrapConfig(
  defineConfig({
    use: { timezoneId: 'UTC', locale: 'en-US' },
  }),
);
```

They reach the browser only. A date your test code computes still follows the machine's `TZ`, and so does a server
the config starts: give that date an explicit `timeZone`, and set `TZ` in `webServer.env`.

If the failure is a bug your users in other time zones would meet, pinning hides it: test that zone on purpose, with
a Playwright project of its own. If the lab reproduced the failure, [`piwi flake verify`](/features/flake-lab#verify-a-fix)
proves the fix under the same condition.

## 5. When it is not the environment

If nothing differs, or running with CI's values still passes on your machine, the cause is elsewhere:

- **A server under test restarted during the run, or its clock is off the runner's.** The run's **Environment** line
  warns, and so does the State tab's diff ([the rule](/features/run-environment#where-it-shows)). A clock offset
  breaks token expiry and "created just now" checks. Both need the instrumentation package; without it, read the
  server's own logs.
- **The app under test was down.** Everything fails at once, fast, on a navigation or connection error. Piwi flags
  such a run as an [environment incident](/features/environment-incidents), and
  [Forty tests are red](./mass-failure) is the recipe.
- **CI is slower or busier.** A slow route, the load of the shard and a test running alongside can be suspects on
  the same Flakiness tab, and [Regression or flake?](./regression-or-flaky) tells a new failure from an old flake.

## Related

- [Run environment](/features/run-environment): what each snapshot records, and where it shows
- [Flake Lab](/features/flake-lab): confirm a suspect by experiment, then verify the fix
- [Run variables](/features/run-variables): what they apply to, and the names they refuse
- [Regression or flake?](./regression-or-flaky): when the question is your change, not the machine
