import type { TourCopyShape } from './types';

/**
 * The guided tour in English, the source language: every other copy file has
 * exactly its keys, which the compiler checks. `{count}` is filled with
 * `fillTourText`; `{{current}}` and `{{total}}` are driver.js's own progress
 * placeholders. A dashboard label is `**bold**`, as the screen spells it.
 */
export const EN_COPY = {
  ui: {
    launch: 'Guided tour',
    launchTitle: 'Pick your role and see the screens you would use most',
    promptTitle: 'Take a guided tour?',
    promptBody:
      'Pick what you do, and the tour walks you through the screens you would use most, on this demo’s sample data.',
    roles: 'Your role',
    stopCount: '{count} stops',
    later: 'Later',
    dismiss: 'Don’t show again',
    language: 'Language',
    next: 'Next',
    back: 'Back',
    done: 'Done',
    progress: '{{current}} of {{total}}',
    close: 'End the tour',
    docs: 'Read the docs',
    finishedTitle: 'That’s the tour',
    finishedBody: 'The other roles’ tours are under Guided tour, in the banner.',
  },
  profiles: {
    developer: {
      label: 'Developer',
      hint: 'Debug a failure and fix it',
      stops: {
        failure: {
          title: 'One failure, read top to bottom',
          body: 'Every failing execution opens on this block. The headline says what broke, **Most likely** gives the cause the evidence points to, and **Next** the one step to take: here, applying the patch the cluster’s AI diagnosis wrote.',
        },
        evidence: {
          title: 'The evidence, kept after CI',
          body: 'What the run captured for this execution, one tab per view: the steps, requests and console on one timeline, the page as it failed, the test’s source. A dot marks each tab that **Most likely** cites.',
        },
        locator: {
          title: 'The locator you should have used',
          body: "When a locator breaks, as getByRole('button') did here by matching three buttons, Piwi ranks replacements captured in the last run where the test passed. Copy the recommended one, or click the element on the failing page with **Pick from snapshot**.",
        },
        diagnosis: {
          title: 'An AI diagnosis, checked against your code',
          body: 'With an AI provider set, Piwi diagnoses a cluster from its evidence and the commits since it last passed. This one traces the users table’s 51 rows to the API’s default page size and suggests this patch, marked **Applies cleanly** against the code. A fix has since landed and held.',
        },
        coverage: {
          title: 'The server lines this test ran',
          body: 'Where a project records coverage, the **Source** tab lists the code a test ran. This failing test ran five files of the ASP.NET Core API, the users endpoints first with the suspect lines; open one to read the lines it ran. A file’s **tests** link opens every test that runs it, line by line.',
        },
        mcp: {
          title: 'Ask from your editor',
          body: 'Piwi is also an MCP server: Claude Code, Cursor or Copilot in VS Code can read failure clusters, their evidence and fix plans, and triage them without leaving the editor. **Client setup** has each client’s configuration; this demo’s endpoint is not live.',
        },
        simulate: {
          title: 'Watch a run arrive',
          body: '**Simulate a test run** streams a new run into the demo, the way the reporter does from CI. In **Run with failures**, two timeouts join the cluster of the first failure you saw, and a new error opens a cluster of its own.',
        },
      },
    },
    qa: {
      label: 'QA engineer',
      hint: 'Flaky, slow and missing tests',
      stops: {
        inbox: {
          title: 'Failures, grouped by cause',
          body: 'The **Failure inbox** lists every open failure cluster across the projects: one row per root cause, however many tests it breaks. Resolve, assign, snooze or quarantine a row from the keyboard, and the decision covers every test in it.',
        },
        flaky: {
          title: 'Flaky tests, ranked by cost',
          body: 'Tests that fail and then pass, ranked by the CI time their retries waste, each with a 0–100 score from its retries and flips, and its top suspect. **Quarantine** keeps a test running and reporting while the CI gate leaves it out.',
        },
        suspects: {
          title: 'What makes it flaky',
          body: 'Piwi compares this test’s failing and passing executions over 30 days and ranks what sets the failures apart. A slow cart API comes first, and delaying it in the Flake Lab reproduced the failure 3 times in 4.',
        },
        slow: {
          title: 'Which tests slow the suite down',
          body: '**Slowest tests** ranks the project’s tests by average duration over recent runs, with their worst and latest times. The credit card and PayPal checkouts are marked slower: their latest runs hit the 30 s timeout.',
        },
        lab: {
          title: 'Prove a fix before releasing a test',
          body: 'The Flake Lab reruns a flaky test under each suspect condition, next to a control, then again after the fix. “Table pagination works correctly” is **Verified fixed**: under the delay that reproduced it, the fix held 5 runs in 5, so its quarantine is proposed for release.',
        },
        gaps: {
          title: 'What your tests miss',
          body: 'The Test Map draws the app’s features from what the tests reach, then lists the tests that do not exist yet, ranked by exposure. One of them here: the tests still pass when POST /api/orders breaks.',
        },
      },
    },
    product: {
      label: 'Product owner',
      hint: 'Quality over time, and reports',
      stops: {
        health: {
          title: 'Every project at a glance',
          body: '**Project health** shows each project’s last 20 runs, its tendency and the pass rate of its latest run, failing projects first. Open one to see what failed.',
        },
        analytics: {
          title: 'Quality over time',
          body: '**Headline numbers** for every project over the last 30 days, against the 30 days before: pass rates, flaky tests, wasted CI minutes, open failure causes, time to fix. Where a project sets a target, the tile says how many meet it.',
        },
        dashboards: {
          title: 'A dashboard per team',
          body: 'Beside the built-in dashboards, a team keeps its own widgets and scope: **Checkout team** follows the checkout smoke tests, sprint by sprint. Any dashboard can go on a wall screen in TV mode or be scheduled as a report.',
        },
        reports: {
          title: 'Reports that send themselves',
          body: 'A schedule sends a quality report to its channels every day, week or month, in English or French, and keeps each one here as a snapshot. **Weekly engineering report** is one; in this demo, nothing is sent.',
        },
        issue: {
          title: 'Failures become tickets',
          body: 'This login failure is tracked in DEMO-42, filed from Piwi with the cluster’s fix plan as its description and now In Progress. The key and status follow the failure: on this page, on its executions and in the inbox. A cluster with no ticket offers **Create issue** and **Link an issue**.',
        },
        personas: {
          title: 'See it as your team does',
          body: '**Acting as** reloads the demo as one of seven seeded people, from an administrator to a stakeholder who can only read E2E Checkout. Each sees what their role allows.',
        },
      },
    },
    platform: {
      label: 'DevOps / platform',
      hint: 'CI speed and machine health',
      stops: {
        timeline: {
          title: 'Where the run’s time went',
          body: 'Each worker’s tests on one timeline, with the CPU, memory and open pages of the machine that ran them. This run was split across two CI shards, so each shard’s machine has its own tracks above its two workers.',
        },
        leaks: {
          title: 'Leaks between tests',
          body: '**Findings** lists what the tests left open past their scope, with the line that opened it. Here the loggedInContext fixture leaves a browser context open in all 10 tests, until the worker shuts down.',
        },
        incident: {
          title: 'When staging is down, not the tests',
          body: 'Ten of eleven tests failed connecting to staging, so Piwi flagged the run as an environment incident. Flaky scores, baselines, fix verification and the CI gate leave it out, and the trend charts get one marker for it.',
        },
        alerts: {
          title: 'Alerts where you work',
          body: 'A channel is where alerts go: email, a Slack or Microsoft Teams webhook, or a webhook of your own. A subscription then picks the projects and the events, such as a failed run, a new failure cluster or an environment incident.',
        },
        setup: {
          title: 'What is switched on',
          body: "**What's switched on** reads this instance’s data, not its config, to show which capabilities are in use, and what each of the others needs, such as a repository token or an AI provider. The steps above it connect a suite.",
        },
        simulate: {
          title: 'Watch a run stream in',
          body: '**Simulate a test run** streams a new run into the demo, the way the reporter does from CI. **Leaky run** replays the leak you just saw: a login fixture leaves a browser context open in every test.',
        },
      },
    },
  },
} satisfies TourCopyShape;
