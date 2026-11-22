# Accessibility: the scans and checks a suite already runs, kept over time

A proposal to make Piwi read the accessibility checks a Playwright suite runs: the axe-core scans Playwright's docs
recommend, and Playwright's own accessibility assertions. It records what a spike showed, the design, the stages and
the questions left open.

**Status.** Proposed 2026-11-22, nothing built. A spike ran axe-core scans through the reporter
([section 2](#2-what-happens-today)). Not on [`ROADMAP.md`](../ROADMAP.md) yet. The contracts it would add are entry
D70 of [1.0-stabilization.md](1.0-stabilization.md).

**Summary.** Playwright's accessibility guide has a test scan the page with `@axe-core/playwright`, attach the
results as `accessibility-scan-results`, and assert that `violations` is empty. Piwi records all of it and reads none
of it as accessibility. A failing scan is a ten-kilobyte JSON diff explained as _toEqual assertion failed_. Every run
of a red scan test falls in the same failure cluster, whether a violation was fixed or a new one appeared. The forty
kilobytes of results each scan attaches are a file nobody opens. This plan reads the scan into violations (the rule,
its impact, the WCAG criteria, the element, its page), follows each across runs, and reports what changed: a new
violation is a regression on the run page, in pull-request feedback and in the gate; a fixed one closes. A project
gets its open violations by page and rule, a trend, a quality report section and MCP tools, and the Test Map raises the
pages no scan has covered. Piwi never runs axe itself: the suite chooses its scanner, version and rules.

## Terms

- **Scan**: one axe-core result attached by a test: a JSON attachment whose `testEngine.name` is `axe-core` and which
  holds a `violations` array, whatever its name.
- **Violation**: one element a rule failed on in one scan: the rule's id (`image-alt`), its impact (`minor`,
  `moderate`, `serious`, `critical`), its tags, the element's `target` selector, its `html` and axe's
  `failureSummary`.
- **Criterion**: a WCAG success criterion, read from a rule's tags (`wcag143` is 1.4.3).
- **Place**: where a violation is: the scan's page key (`pageKey` of its `url`, `packages/core/src/page-key.ts`), or
  the story the test mounted for a component test ([component-tests.md](component-tests.md)).
- **Open violation**: a violation identity (rule, place, target) seen in the newest scan of its place on a branch.
  **New**: open now and absent from the baseline run. **Fixed**: in the baseline, absent from a newer scan of the same
  place.

## 1. What a Playwright suite has for accessibility

- **Assertions**, all present in Playwright 1.59, the reporter's floor: `toHaveAccessibleName`,
  `toHaveAccessibleDescription`, `toHaveAccessibleErrorMessage`, `toHaveRole` and `toMatchAriaSnapshot`.
- **Emulation**: `reducedMotion`, `forcedColors`, `colorScheme`, and since 1.63 `contrast` (`prefers-contrast`).
- **Scans with axe-core**, through Deque's `@axe-core/playwright` (4.14.0 today), which Playwright's
  [accessibility testing guide](https://playwright.dev/docs/accessibility-testing) recommends: `new AxeBuilder({ page })`,
  narrowed with `include`, `exclude`, `withTags(['wcag2a', 'wcag2aa'])` or `disableRules`, then `analyze()`. The guide
  attaches the whole result as `accessibility-scan-results` (`application/json`) and asserts
  `expect(results.violations).toEqual([])`. For known issues it suggests a `toMatchSnapshot` of violation
  fingerprints (rule and targets) kept in the repository.
- **A result** holds `testEngine`, `url`, `timestamp`, `toolOptions` and four lists: `violations`, `incomplete`,
  `passes` and `inapplicable`. Each rule carries `id`, `impact`, `tags`, `help`, `helpUrl` and `nodes`, each node its
  `target`, `html`, `impact` and `failureSummary`.

## 2. What happens today

### The spike

Playwright 1.64.1, `@axe-core/playwright` 4.14.0 (axe-core 4.14.1), the reporter 0.75.0 from its packed tarball, a
local dashboard. A component with an image without `alt`, a button without a name and grey text on white; one scan test
written as the guide writes it, one scan of a clean component, one `toHaveAccessibleName` check. Run twice, the second
time with the contrast fixed.

| What                               | Result                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The attachment                     | Stored as a plain file (`files`, subtype `accessibility-scan-results`, `application/json`): 42 to 50 KB a scan, a passing test's included     |
| Its content                        | 3 violations (`button-name` and `image-alt`, critical; `color-contrast`, serious), 4 passes, 53 inapplicable rules: violations are 5 KB of it |
| The failure                        | A 10.9 KB error, the JSON diff of the violations, explained as _toEqual assertion failed_                                                     |
| The second run                     | 2 violations instead of 3, the same failure cluster: a fixed violation, like a new one, changes nothing Piwi shows                            |
| The scan's page                    | The component gallery's URL for a component test, so the story is what places a violation there                                               |
| The `toHaveAccessibleName` failure | Explained in one line (`matched 2 imgs — strict mode`): Playwright's own assertions already go through the usual path                         |

### What Piwi already has

- **ARIA snapshots**, captured on failure and sampled on passing runs (`internal/capture/capture-fixtures.ts`,
  `internal/support/aria-sampling.ts`), behind the page diff against the last green run (`shared/page-diff.ts`), the
  accessibility tree of the failing step (`FailingStepSnapshot.vue`), locator healing and the
  `element-present-but-blocked` clue.
- **The page inventory** (opt-in): the role and accessible name of each control of a page
  (`internal/capture/page-inventory.ts`), the Test Map's controls.
- **The locator index** records each assertion as `expect.<matcher>` per page (`locator_usages.action`), so
  `toHaveAccessibleName` and the others are already counted per page.
- **Emulation settings** captured per execution (`metadata-collector.ts`) and compared in the environment diff
  (`shared/environment-diff.ts`). The browser badge shows motion and forced colors, not `contrast`.
- **Failure nouns** for the accessibility matchers (`packages/core/src/describe-failure.ts`), except
  `toHaveAccessibleErrorMessage`.
- **Piwi Picker's Playwright view** marks operable elements with no role, or no name and no test id
  (`apps/extension/src/content/playwright-view-scan.ts`).
- **No reading of any user JSON attachment.** The only attachments parsed are Piwi's own `piwi-*` and Playwright's
  `error-context` (`server/utils/import-evidence.ts`).
- Nothing about axe, WCAG violations or accessibility in the docs, and no accessibility test of Piwi's own UI.

## 3. Design

### 3.1 Reading a scan (server)

- **At ingest**, a JSON attachment of 2 MB at most whose top level has `testEngine.name === 'axe-core'` and a
  `violations` array is read once, wherever it arrived from (`case-files`, `upload`, an import). The name
  `accessibility-scan-results` is the guide's, so it is a hint, never the test.
- **What is kept**: per violation and node, the rule, impact, criteria (`wcagNNN` tags; the `wcag2a`, `wcag2aa`,
  `wcag21aa` level tags), the `target`, the first 500 characters of `html` and of `failureSummary`, `help` and
  `helpUrl`; per scan, the counts of `passes`, `incomplete` and `inapplicable`, the engine's version, and the
  `toolOptions` tags it ran with. Rule text comes from the scan, so Piwi carries no copy of axe's rules.
- **Where**: a table `accessibility_violations` (project, execution, run, branch, place, rule, impact, criteria,
  target, html, summary, identity hash) and the scan's summary in the file row's `metadata` (the `files.metadata`
  column the visual diff uses). The file stays as attached: it is the evidence, and retention removes it with the
  run.
- **The place** is the page key of the scan's `url`, or the story mounted last when the execution is a component one.
- **The identity** of a violation is its rule, place and target, the target with positional parts
  (`:nth-child(3)`) dropped so a list's reorder keeps the identity.

### 3.2 On an execution

- **An Accessibility section** in the evidence tabs (`EvidenceTabs.vue`): each violation with its impact, rule, WCAG
  criteria, element (target and `html`), axe's summary and the rule's help link, then the scan's counts. It shows on a
  passing execution too: a scan that fails nothing still found what it found.
- **A clue, `accessibility-violations`** (strong, `shared/failure-clues.ts`), for a failing execution whose scan has
  violations and whose error is an assertion on them: _3 accessibility violations: `button-name`, `image-alt`
  (critical), `color-contrast` (serious); 1 new since the last passing run_. The error text's JSON diff is folded
  behind it.
- **`toHaveAccessibleErrorMessage`** gets its noun in `describe-failure.ts` (_accessible error message_).
- **The browser badge** shows `contrast: 'more'` as it shows forced colors.

### 3.3 Across runs

- **The baseline** is the one every run comparison takes (`shared/run-baseline.ts`: the same environment, then the same
  branch, the base branch, the default branch). New and fixed are counted only for places both runs scanned: a place
  scanned once is neither.
- **The run page** gets a line under its changes: _2 new accessibility violations, 1 fixed_, opening the list by place
  and rule.
- **Pull-request feedback** (`shared/pr-feedback.ts`) adds the new violations, one line each, with the place and the
  test that scanned it.
- **The gate**: `maxNewAccessibilityViolations` (`packages/core/src/gate.ts`, `piwi gate --max-new-a11y-violations <n>`
  beside `--max-new-regressions` and `--max-new-leaks`), and `minAccessibilityImpact`, the lowest impact that counts
  (`serious` by default).
- **Accepting a violation**, with a reason and an optional end date or linked ticket: it stays listed, apart, and no
  longer counts as new or open for the gate. This replaces the guide's fingerprint snapshot, which lives in one
  test's files and goes stale silently. A violation can be filed as an issue through the issue tracker integration,
  with its element, summary and help link.
- **Gating on what is new.** With the gate reading violations, a team can scan without asserting
  (`expect.soft`, or no `expect` at all) on pages with known debt: the test stays green, the debt is listed, and a new
  violation still stops the build. The docs say so, beside the guide's strict form.

### 3.4 A project's accessibility

- **An Accessibility view** on the project: open violations grouped by place, by rule or by criterion, filtered by
  impact, branch and environment, with each one's first-seen run and its scanning tests.
- **A trend**: open violations by impact per day, kept in a daily table as `coverage_daily` keeps coverage, so it
  survives retention; an Analytics widget and a quality report section (open by impact, new and fixed in the period,
  the places never scanned).
- **MCP**: `list_accessibility_violations` (project, branch, place, rule, impact, status) and the violations of an
  execution in its existing tools, so an agent fixing one gets the element, the summary and the help link.

### 3.5 The places no scan covers

- **A detector, `page-never-scanned`** (blind-spot, [gap detectors](../apps/docs/reference/gap-detectors.md)): a page
  or story some test of the default branch reaches, in a project that scans at least one place, which no scan covered
  in the last 30 days. Confidence 0.5; its evidence names the tests that reach it, the ones to add a scan to.
- **Piwi Picker** shows a page's open violations on the live page, from the instance, as the Tested elements overlay
  shows the tested ones.

## 4. Decisions

| #   | Decision                                                                                                                  | Why                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Piwi reads scans; it never runs one.** No axe-core in the reporter, the capture fixtures or the server.                 | The suite chooses the scanner, its version, its rules and where to scan; the reporter's bundle and each test's cost stay as they are; nothing of axe-core ships with Piwi. |
| D2  | **A scan is recognized by its content**, `testEngine.name` and `violations`, never by the attachment's name.              | The guide's name is a convention a team can change; the content is axe-core's format.                                                                                      |
| D3  | **axe-core's format only.** Another engine's results are read once they are written in it.                                | It is the one Playwright's docs recommend; others (Lighthouse, IBM Equal Access, pa11y) differ in shape and in their rules.                                                |
| D4  | **New and fixed are counted per place both runs scanned.**                                                                | A scan added to a new page is not a regression; a scan removed is not a fix.                                                                                               |
| D5  | **Clustering is left as it is.** The failure cluster of a scan test stays one cluster; violations are followed beside it. | A violation is not a failure: most are found by scans that fail nothing.                                                                                                   |

## 5. Stages

| Stage | Builds                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | Reading a scan at ingest; `accessibility_violations`; the execution's Accessibility section; the `accessibility-violations` clue (new against the last pass); the noun and the badge; a docs page |
| S2    | Identity across runs: new and fixed by the baseline ladder, the run page's line, pull-request feedback, the gate's two policies, accepting a violation, filing an issue, the MCP tool             |
| S3    | The project's Accessibility view, the daily trend, the Analytics widget and the quality report section                                                                                            |
| S4    | `page-never-scanned`; open violations in Piwi Picker                                                                                                                                              |
| S5    | Independent: axe-core scans in the dashboard's own E2E suite (`apps/application/tests`, a development dependency only), on the pages the docs screenshots show                                    |

Each stage ships with its docs section and the demo seed (a project with scans, a new violation in its latest run, a
fixed one and an accepted one).

## 6. Open questions

- **Identity under markup changes.** A target selector changes with the markup around the element, which reads as one
  violation fixed and one new. Whether to also match on the rule, the place and the `html` without its attributes.
- **The file's size.** A scan's `passes` and `inapplicable` lists are nine tenths of its file. Whether Piwi stores the
  attachment without them, which changes a user's file, or keeps it whole and lets retention handle it.
- **A scan from the capture fixtures.** An opt-in that runs the project's own `@axe-core/playwright` (resolved from the
  project, never bundled) on each page a test leaves would give scans to suites that write none. It costs every test a
  scan, and D1 says the suite decides.
- **`incomplete` results**, the ones axe could not decide (often contrast over an image): listed apart, or left out.
- **A failure only under an emulation setting** (`forcedColors: 'active'`, `contrast: 'more'`): whether a clue names
  the setting when the same test passes in a project without it.
