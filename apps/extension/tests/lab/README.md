# The replay lab

Records what a person does on a real app with the real extension, then plays the recording back two ways: with the
extension's own **Replay**, in a fresh browser, and as the **spec** the converter writes, run by Playwright. A step
that fails in both points at the recording (a locator that does not hold); one that fails only in the replay points at
the replay (pacing, events a real mouse sends). It found most of what the recorder and the replay got wrong on the Piwi
dashboard, and it is where a new kind of page gets tried first.

It is not part of CI: it needs a running app, takes several minutes, and a scenario can fail because the app changed.

Two sets of scenarios: the dashboard's (`scenarios.ts`, the default) and public sites' (`wild.ts`, `LAB_SET=wild`),
recorded as **Report a bug** records them: TodoMVC, The Internet, UI Testing Playground, Swag Labs, DemoQA,
Wikipedia, Hacker News, Books to Scrape and Conduit, each scenario picked for something a locator or a replay has to
cope with. `LAB_SET=all` runs both.

## Running it

The scenarios use the Piwi dashboard with its seeded data, on port 3000. From `apps/application`:

```bash
npm run app:seed:dev
npm run app:dev:bg        # http://localhost:3000, in the background
```

Then, from `apps/extension`:

```bash
npm run extension:lab                        # build, record, replay, run the specs, print the table
npm run extension:lab -- --grep palette      # the scenarios whose name matches
LAB_DRY=1 npm run extension:lab -- --grep x  # drive the scenarios in a plain browser only, to write one
LAB_SKIP_BUILD=1 npm run extension:lab       # keep dist/ as it is
```

`LAB_ORIGIN` points it at another server (`http://localhost:3000` by default), and `LAB_SETTLE_MS` sets how long it
waits after the first load (5000 by default: the dashboard's dev server hydrates slowly; a scenario can set its own).

The public sites need no server:

```bash
LAB_SET=wild LAB_REPLAYS=3 LAB_WORKERS=2 npm run extension:lab   # each recording replayed three times, two at once
LAB_SET=wild LAB_DRIVER=events npm run extension:lab              # replayed with the page's events, as in Firefox
LAB_DIST=tests/lab/out/dist-before LAB_SKIP_BUILD=1 npm run extension:lab   # another build, kept to compare with
```

`LAB_REPLAYS` replays each recording that many times, each in a fresh browser, so a step that plays only sometimes
shows (the table says how many passed). `LAB_WORKERS` runs that many scenarios at once (the public sites' only: the
dashboard's share its data). `LAB_DRIVER=events` loads the extension without `debugger`. `LAB_DIST` loads another
build than `dist/`.

The table it prints, also in `out/summary.md`:

| Scenario         | Steps | Extension replay                                  | Playwright                      |
| ---------------- | ----- | ------------------------------------------------- | ------------------------------- |
| palette-shortcut | 4     | passed (12 s)                                     | passed                          |
| …                |       | stopped at step 3: Nothing on this page matches … | failed: strict mode violation … |

`out/` holds, per scenario, the steps (`results/<name>.steps.json`), what happened (`results/<name>.json`), a
screenshot at the end of the recording and of the replay (`shots/`), and the spec Playwright ran (`specs/`). A failed
lab test also has Playwright's own report (`npx playwright show-report tests/lab/out/...`). `out/` is ignored by git.

## How it works

- `harness.ts` copies `dist/` into `out/ext-<worker>/` with the scenarios' origins as host permissions (the grant a
  person gives in the popup), launches Chromium with it in a new profile, Chrome's password manager off (its warning
  about a leaked password, after a login, makes the tab ignore input), and talks to the background script from an
  extension page, as the popup does: `piwi-start-recording`, then `piwi-start-replay`.
- The scenario drives the page with Playwright's trusted input, at a person's pace. The recorder's events are read from
  session storage and turned into steps by the same code as the review panel.
- The replay starts in a fresh browser on the scenario's first page and runs until it is done or stops. It passes when
  every step played and it ended on the URL the recording ended on. A step the replay hands to the person ends it
  there, with the replay's reason, except a password: the harness types the scenario's next `secrets` entry and
  answers **I did it, continue**, as the developer would. The table says how it acted: trusted input through the
  debugging protocol, or the page's own events and why.
- The spec is written with the stable locators and URL checks the recorder's own export uses. Its first load waits
  `LAB_SETTLE_MS` before acting: a server-rendered app ignores input until it has hydrated, which says nothing about
  the locators.

## Adding a scenario

In `scenarios.ts` (or `wild.ts`, with the site's full URL as `start`): a name, the route it starts on, and what a
person does. Use roles and names as a person reads them,
and the helpers there: `type` (typed at a person's speed), `retype` (select and type over), `pickInPopup` (an entry of
the popup that just opened) and `pause`. Keep it repeatable: fill a form and cancel it, set a filter, open a menu and
close it, but save nothing a second run would find changed. Check it with `LAB_DRY=1` first.

A scenario for something the extension cannot do yet gets a `knownGap`: the lab reports it without failing, and it
stays as the test for when it can.

## What it does not cover

- Other browsers: the lab loads the extension in Chromium only.
- Pages behind a login, beyond a form the scenario fills: the dashboard's dev server runs without authentication.
- The browser's own date and color pickers: a date is typed, as Playwright's `fill` does.
- A file step's file comes from `out/files/`, where the harness writes one by the recorded name: it answers the
  replay's request for the file as the developer would, in the replay's panel.
