# Page, context and browser leaks: an audit, and the lifetime model that comes next

An audit of how Piwi finds the browsers, contexts, pages and API request contexts a Playwright suite keeps open, from
the ledger in the capture fixtures to the gate, the pull-request comment and MCP. It asks two questions. Does what is
built find what it claims, at the right line, without false alarms? And what should it find next? The answer to the
second is one more fact per object, its **last use**: today Piwi says what was never closed, and with the last use it
can say what stayed open longer than it was needed, and where the `close()` belongs.

**Status.** Proposed 2026-11-07, against `main` at v0.67.0 (`25681ad0`) on Playwright 1.64.1. It builds on
[resource-leaks.md](resource-leaks.md) (PRs 1 to 4 and part of 7 built, 5 and 6 not started) and
[resource-consumption-next.md](resource-consumption-next.md) (nothing built); where an item here sharpens one of
theirs, it says which. **Built 2026-11-07**, quick wins 1, 4 and 5 and medium items 6 and 7 in part:

- R1: a fixture with a `timeout` of its own is judged as a test fixture when its test's `After Hooks` steps tore it
  down, or once it opened objects in two tests of one worker; in both, only when its own teardown did not close them
  and no later test used them. Playwright's own worker fixtures (no location) are never judged. The first version judged
  any timed fixture whose object no later test used, and flagged Playwright's `browser` (`timeout: 0`) in a worker
  that ran one test. A boxed fixture (`box: true`) leaves no step, so only the two-test rule reads it.
- R2 (a page from `newPage` is never a popup), R3 (pages counted through every fold, a persistent context folded into
  itself with its browser), R5 (§5.1's connection wrapper marks pages used; the page-method wrappers remain for a
  Playwright without it), and R6 in part (listeners on contexts and the browser).
- §5.1's last use in every census, and its line on each leak and lingering finding: in the summary, `leakCheck: 'fail'`'s
  error, the Resources tab (an open-in-editor link), the pull-request comment and `get_resource_profile`.
- §5.3's **lingering** verdict, report-only, never counted by the gate: for a browser, context or page the test body
  opened, measured from its last use (a wait on the client counts until it ends) to when its close began, before Piwi's
  reads and Playwright's trace export. The connection of a browser the worker connects to is followed too.
- §6.2's tails on the run's workers timeline: each leaked object under its worker's row from its scope's end to its
  close or the worker's end, each lingering one from its last use to its close, the share of open pages left open on the
  open pages track and strip, a tooltip with the object's lines, a click that opens its test, and **Show leaks**.

Built since: R4 (the fixture-free tier tallied per scope; an API request context stays uncounted, since its
`dispose()` leaves no step), S1 to S3 and S5 to S7 (the history changes a finding only from full default-branch runs,
moves one only from them, keys it by its opening line, joins a finding another run stored at once, and counts a clean
run only when its report could show the finding; the gate checks the capability), S4 (a handle's line and count on the
Resources tab) and S8 in part (each new leak in the pull-request comment with its fix, and every fact).

Not built: R6's per-method counts (init scripts, bindings, DevTools sessions), R7, over-scoped and churn, S8's
servers and processes and its line for a leak the change fixed, S9, the failure timeline's object lanes, and §6's
larger items. All of R1 to R4 and S1 to S8 were filed as PiwiTests/piwi#1174.

## 0. The findings that matter most

1. **"Could have been closed" is invisible.** A popup used for one check and left to the `page` fixture, an admin
   context used in the first second of a long test, a `beforeAll` context that only the first test of its block uses:
   each is clean today, because each is closed in the end. A wrapper on the worker's connection to Playwright gives
   every object its last use, with its line, at no cost the prototype could measure ([§5](#5-the-lifetime-model)).
2. **No finding says where the fix goes.** A leak names the line that opened it. The line that should close it is the
   object's last use, which nothing records. "Close it after `tests/cart.spec.ts:24`, its last use" is the sentence a
   reader needs, and the edit an editor quick fix or an agent applies ([§6.1](#61-every-finding-carries-its-edit)).
3. **A test-scoped fixture with its own `timeout` is read as worker-scoped** (R1). Its leaked context is never reported,
   and the page the test opened in it is blamed on the test's line instead.
4. **The fixture-free tier misses two of the three commonest leaks** (R4): `browser.newPage()` and
   `request.newContext()`. It also names closed lines as leaks, and one `page.close()` elsewhere in the file can cancel
   a real leak.
5. **The finding history is branch-blind** (S1, S2). A feature branch forked before a fix reopens the fixed finding and
   resets its clean-run count. A branch run can move the default branch's finding to the branch's line numbers, and
   two runs finishing out of order duplicate it.
6. **The gate ignores a declined `resources` capability** (S3). It still reads the leaks, while nothing records their
   history, so every leak is new forever and `--max-new-leaks 0` fails every leaky run, the default branch's included.
7. **Piling up is watched on pages and their contexts only** (R6). Listeners added to a worker-scoped context or
   browser, init scripts, bindings and DevTools sessions added per test: the battery added one of each in four tests,
   and nothing was reported.
8. **Idle is about pages only** (R7). A browser launched for nothing, a context that never got a page and an API
   context never called are not reported.
9. **The reader cannot act from where the finding is shown** (S4 to S9). No surface gives a fix. The run's Resources
   tab drops the line of a server or child process left running. The pull-request comment gives the same advice for
   every kind, and it is wrong for three of them. The editor, the failure clues and the notifications show nothing.
10. **A lingering page costs what it does while it waits, for the rest of its test.** In the A/B run
    ([§5.4](#54-what-lingering-costs)), polling popups left to the fixture added 41% to the renderers' CPU and 0.1 GB
    to the peak. The tests did not get slower on a machine with headroom. Lingering is a small finding per occurrence,
    and a common one. Its last-use line matters most as the fix location of the leaks that are not small.

## 1. Method

- **A battery of 34 patterns**, in 13 spec files and a project without the fixtures, run on one worker through the
  built reporter (0.67.0) and `extendPiwiFixtures`. It used Playwright 1.64.1 and the sandbox's Chromium (build 1248,
  headless), and produced the real end-of-run summary. A second reporter kept every `piwi-resources` census, which a
  script fed to `buildResourceReport` to list every finding past the summary's ten.
  [Appendix A](#appendix-a-the-battery) lists the patterns.
- **A prototype of last-use tracking**: a worker fixture of about 100 lines that wraps the worker connection's
  `sendMessageToServer`. It ran over the same battery, and alone against 3,000 locator calls to price it.
- **An A/B run of lingering pages**: 16 tests on 4 workers, three rounds of each variant, measured by the reporter's
  own machine panel.
- **A read of the downstream code**: storage and identity, the run's Resources tab, the gate, the pull-request
  comment, MCP, the failure clues, the editor service, the notifications and the demo. Each defect listed in
  [§4](#4-defects-after-the-reporter) was checked against the code at the lines it names.

## 2. What the ledger finds today

| # | Pattern | Today | The right answer |
|---|---|---|---|
| A1 | `browser.newContext()` never closed | leaked context at its line, with its page | ✓ |
| B1 | test-scoped user fixture with no teardown | leaked, `fixture "leakyCtx"` at the opening line | ✓ |
| B2 | the same fixture with `{ timeout: 20_000 }` | context missed; its page reported as a leaked page at the test's line | leaked context, in the fixture (R1) |
| B3 | worker fixture page that one test of the worker uses | nothing (held by design) | over-scoped ([§5.3](#53-new-verdicts)) |
| C1 | a helper in another file opens and leaks, two callers | leaked at the helper's line, 2 tests | ✓, but the callers are not named ([§6.3](#63-helpers-and-their-callers)) |
| D1 | `chromium.launchPersistentContext()` never closed | "leaked browser" at its line, its page not counted | ✓, labeled a persistent context with its page (R3) |
| D2 | `chromium.launch()` in a `test.step`, never closed | leaked browser at its line, with its page | ✓ |
| E1 | `playwright.request.newContext()` never disposed | leaked API context at its line | ✓ |
| E2 | API context created and disposed, never called | nothing | idle (R7) |
| F1 | asks for `page`, calls `request` only | idle page, `fixture "page"` | ✓ |
| F3 | a context that never got a page | nothing | idle (R7) |
| F4 | a browser launched and closed, nothing opened in it | nothing | idle (R7) |
| F5 | a page used only through `keyboard.press` and `page.$` | idle | used (R5) |
| G1 | popup used for one check, then left to the `page` fixture | nothing | lingering: 2.55 s of a 2.8 s test after its last use |
| G2 | admin context used first, closed on the test's last line | nothing | lingering: 2.6 s after its last use |
| G3 | the same as G1 with a polling popup | nothing | lingering, with the CPU it used |
| G4 | five pages opened in a loop, each used once, closed at the end | nothing | five open at once, one in use (detail) |
| H1 | `beforeAll` context that only the first of four tests uses | nothing | over-scoped: held through three tests that never used it |
| I1 | three tests that each launch and close their own browser | nothing | churn: launch and close took 152 to 180 ms of tests of 276 to 322 ms |
| J1 | `void context.close()` at the end of the test | nothing | ✓ |
| J2 | context a file-level `afterAll` closes | nothing | ✓ |
| J3 | `await using context = …` | nothing | ✓ |
| K1–K5 | per test, on worker-scoped objects: a context listener, a browser listener, `addInitScript`, `exposeBinding`, an undetached `newCDPSession` | nothing | piling (R6) |
| L1 | `beforeEach` caches a context in a module variable | leaked past its test, 1 test | ✓ (the fix is a worker fixture) |
| N1 | two contexts opened on one line with `Promise.all` | one finding, 2 contexts | ✓ |
| M1 | no fixtures: `browser.newPage()` never closed | nothing | probable (R4) |
| M2 | no fixtures: `request.newContext()` never disposed | nothing | probable (R4) |
| M4 | no fixtures: `chromium.launch()` never closed | probable browser, naming M4's line and M6's clean line | probable, M4's line only (R4) |
| M6 | no fixtures: a context closed with its browser | nothing, by accident (M7 balances it) | nothing (R4) |
| M7 | no fixtures: `browser.newPage()` closed by `page.close()` | its "Close context" step is counted | nothing (R4) |

**With the fixtures, every object left open was reported at the right line except one** (B2). Nothing clean was flagged
except F5, a documented limit. The hand-over, `await using`, an unawaited close, a file-level `afterAll`, a helper's
line, a persistent context's line and two objects opened on one line all read right. **Without the fixtures, one of
three leaks was found**, and its finding named a clean line too.

## 3. Defects in the reporter

### R1. A test-scoped fixture with a timeout reads as worker-scoped

`runnableOf` decides a fixture is worker-scoped when its runnable carries a timeout slot (`resource-ledger.ts:310`).
Playwright gives a slot to worker fixtures and to any fixture with its own `timeout` (`_setupDescription` in
`playwright/lib/worker/workerProcessEntry.js`). Trigger, B2: a test-scoped fixture with `{ timeout: 20_000 }` that
never closes its context. `leakVerdict` drops worker-held objects (`resource-verdicts.ts:242`), so the context is never
a finding. The page the test opened in it is reported instead, as a leaked page at the test's line, which points the
reader at the wrong file and the wrong fix. Fix: read the fixture's `registration.scope` from the fixture runner's
instance whose setup description is the runnable's `fixture` (internal, feature-checked), and keep the slot only as
the fallback.

### R2. Every page a test opens with `newPage` is recorded as a popup

The capture fixtures wrap `context.newPage` and `browser.newPage` (`capture-fixtures.ts:3328`, `:3365`). Playwright
names an API call after the first frame outside `playwright-core` (`captureLibraryStackTrace`), so the call reaches the
ledger as `browserContext.originalNewPage`, and `viaNewPage` (`resource-ledger.ts:784`) is false for every such page.
Its birth carries `trigger: "browserContext.originalNewPage"`, and its line is taken from the last call that began,
not from the `newPage` call. The two differ under `Promise.all`. Nothing visible depends on it today, because the
fold and the messages read `opener`, but a popup rule or the last-use model would inherit it. Fix: the wrappers tell
the ledger which page they returned, rather than the ledger guessing from the API name.

### R3. Pages two levels down are not counted, and a persistent context is called a browser

`groupLeaks` counts a leaked page into the group of its leaked ancestor only when that ancestor is the group's root
(`resource-verdicts.ts:343-350`). A page under a context under a leaked browser is not counted. D1 reads
"leaked browser … 1 test" with no page, and so does `launch()` then `newContext()` then `newPage()`. A context from
`launchPersistentContext` is folded into the browser that `context.browser()` returns, so the summary calls it a
browser. Fix: walk every folded ancestor to the root, and label the root by the call that opened it.

### R4. The fixture-free tier counts the wrong steps

Without the fixtures, the reporter tallies `Create context`, `Launch persistent context`, `Launch browser` and
`Connect over CDP` against `Close context` and `Close browser`, per spec file (`resource-verdicts.ts:59-68`,
`:584-610`). From the battery:

- `browser.newPage()` emits `Create page`, and its implicit context has no step, so M1 is never counted.
  `request.newContext()` emits `Create request context`, which is not tallied, so M2 is never counted.
- `page.close()` on a `browser.newPage()` page emits `Close context` (M7). That close is counted, and it cancels a
  leaked context elsewhere in the file.
- A context closed by its browser's `close()` has no close step: alone in a file, M6 is a probable context.
- `where` lists every line of the file that opened that kind of object, closed ones included. M4's finding names
  M6's clean line. The list is also the finding's identity, so adding a properly closed `newContext()` to the file
  makes the old leak look new to the gate (S5).

Fix: tally per scope (the test with its each-hooks, a describe's all-hooks), and pair each close with the latest
unpaired open of its kind. Count `Create request context` against its dispose step. Let `Close browser` close the
contexts opened under it in the scope. Name only the unpaired lines. The title cannot tell `browser.newPage()` from
`context.newPage()`, but the source line at the step's location can. Without it, leave pages out and say so.

### R5. "Used" is a list of page methods

A page is used when it navigates, loads, builds a locator through the wrapped factories, or runs one of seven methods
(`USE_METHODS`, `resource-ledger.ts:166`). The keyboard, the mouse, `page.$`, the frame-level `page.click(selector)`,
`screenshot`, `pdf` and `content` do not count, so F5 reads idle. To count those seven, the ledger replaces them
on every page with own-property wrappers (`:807-821`), a per-page side effect. The connection wrapper of
[§5.1](#51-reading-the-last-use) replaces both: any user call on the page, or on anything under it, is a use, and no
page method is replaced.

### R6. Piling up is watched on pages and contexts only

The census counts listeners and route handlers on pages, and open pages and route handlers on contexts
(`resource-ledger.ts:938-956`). In K1 to K5, a long-lived context or browser gained one of each of these per test,
and nothing was reported:

- a listener on a context or on the browser;
- `addInitScript`, which then runs in every later page;
- `exposeBinding` and `exposeFunction`;
- `newCDPSession` without `detach`.

`tracing.start` without `stop` on a long-lived context is the same case (not in the battery). Separately, a page's
listener count includes the 21 that Piwi's own capture adds to each instrumented page. A piling finding's "from" then
starts above anything the test added. Fix: count listeners on contexts and the browser too. Count the user calls per
method on long-lived objects through the connection wrapper (`addInitScript`, `exposeBinding`, `newCDPSession` minus
`detach`, `tracingStart` minus `tracingStop`), under the same piling rule. Subtract Piwi's own listeners.

### R7. Idle is a verdict about pages only

`buildResourceReport` judges only pages idle (`resource-verdicts.ts:197`). E2, F3 and F4 are reported as nothing. The
browser case is the one that costs most: [resource-leaks.md](resource-leaks.md)'s
"chromium launched in 4 workers for 120 tests; 112 never opened a page" is still unbuilt. The ledger already knows,
per worker, whether the fixture browser ever got a context.

## 4. Defects after the reporter

### S1. A stale branch reopens a fixed finding

`recordRunResourceFindings` reopens a fixed finding and resets its clean runs on any run that shows it and started
later, whatever its branch (`shared/handlers/resource-findings.ts:187-203`). Only default-branch runs count as clean
(`countCleanRun`, `:236`). Trigger: the default branch fixes a leak and is marked fixed after five clean runs; a
feature branch forked before the fix pushes, and the finding reopens as "Back after its fix". A branch pushed
regularly keeps a fixed leak from ever reading fixed. Fix: a run outside the default branch records its occurrence
and never changes the status or the clean count.

### S2. A branch run moves the default branch's finding

Moves are paired from any run (`pairMoved`, `:363`; its candidates at `:133-146` have no branch condition). A pull
request with an edit above a leak moves the open finding to the branch's line numbers, as its `place`, `site` and
fingerprint. Out of order, it splits the finding. A default-branch run that started before the pull request's run, but
finishes after it, no longer matches the moved row: the row was last seen later than the run started. The run inserts
a second row under the old fingerprint. The moved row then collects clean default-branch runs and is marked fixed while
the leak is still there. Fix: pair moves only from default-branch runs, and match the run's start against the
occurrences, not against `lastSeenAt`.

### S3. The gate ignores a declined `resources` capability

`recordRunResourceFindings` records nothing when the project declined the capability (`:117`), but the gate calls
`runFindingsNovelty` without that check (`server/api/test-runs/[id]/gate.post.ts:230-245`), and the finish routes
still store the report. Every leak is then new against a base branch with no history, so `--max-new-leaks 0` fails
every leaky run. The pull-request comment does check the capability (`server/utils/scm/pr-feedback.ts:462`). Fix: the
same check in the gate. A leak rule on a project that declined the capability is reported as not measured.

### S4. The Resources tab drops a handle's line

`findingView` returns no `where` for a `handle` finding (`shared/resource-copy.ts:122`), and the tab links a line only
through `where` (`app/components/run/RunResources.vue:57`). The line of a server or a child process left running is
measured, sent and stored, and never shown. The count of handles is left out of the facts too.

### S5. A finding's identity holds text that changes without the leak changing

The fingerprint is `verdict|kind|scope|where|growth.what|detail`, with `detail` for idle and handle findings
(`shared/resource-fingerprint.mjs:21`). Each item below makes the gate count an old leak as a new one:

- a probable leak's `where` lists every opening line of its kind in the file (R4), so a new, closed `newContext()`
  changes it;
- an idle finding's `detail` lists every user fixture of the test with its line;
- a handle finding's `detail` holds the test's title, not the line, so renaming the test changes it, and two servers
  on two lines of one test fold into one;
- a fixture leak's `where` holds the fixture's title.

Fix: an identity built from the opening line, or from the fixture's location when there is no line, with text kept
for display only.

### S6. Two runs that find the same new leak at once lose one run's history

The insert has no conflict handling and runs outside a transaction, against a unique key on project and fingerprint
(`resource-findings.ts:167`). Two jobs of a matrix that introduce the same leak and finish together: the second insert
throws. The error is logged and swallowed (`server/utils/run-finalize-side-effects.ts:104`), and the rest of that run's
occurrences are never written. Fix: an upsert in one transaction per run.

### S7. A run that could not have shown a finding still vouches for it

A run counts as clean for a finding when the ledger ran (`countCleanRun`). What a failed test left open is never judged
(by design: its worker shuts down), and the wire keeps 100 findings. A leaking test that fails in five default-branch
runs, or a finding past the cap, is marked fixed. Fix: a run vouches for a finding only when the tests that showed it
passed in the run, and the report was not cut.

### S8. The pull-request comment gives one piece of advice for every leak

"Close each before its test ends, or set `leakCheck: 'fail'`" (`shared/pr-feedback.ts:179`) is wrong for three kinds.
A `beforeAll` leak is closed in `afterAll`. A probable leak means the fixtures are off, and without them `leakCheck`
does nothing. A fixture's leak is fixed in its teardown. The facts are cut to three (`:174`), which usually drops the
held time. Servers and processes left running are never listed, and there is no line for a leak the change fixed.

### S9. Where nothing is shown yet

- **The editor**: no diagnostic, hover or quick fix (`packages/editor/src`), which PR 5 of
  [resource-leaks.md](resource-leaks.md) plans.
- **The failure clues**: none of `pages-left-open`, `cpu-starved`, `out-of-memory` or `disk-full` exists, and
  `worker-pollution` reads only whether the previous test failed.
- **The notifications**: the fixed and reopened findings `recordRunResourceFindings` returns are discarded.
- **Analytics**: no rollup column or widget for leaks over time.
- **MCP**: `list_resource_findings` gives no fix. `detail` and `growth` are never stored, so a handle finding names
  no test, and a piling finding has no numbers.
- **The demo**: its handle finding has no line, and nothing in it is fixed or reopened.

## 5. The lifetime model

Every finding today is about one moment: the scope's end. The ledger knows when an object was born and when it
closed. It does not know when the test last needed it. Adding that turns a list of leaks into a lifetime per object
(born, used, last used, closed), and three questions become answerable: where the `close()` goes, what stayed open
after it was needed, and what was opened for more tests than used it.

### 5.1 Reading the last use

Every call a test makes reaches the worker connection's `sendMessageToServer(object, method, params, options)`.
`options` carries the API name, the user's stack frames and `internal`, which is set on Piwi's own reads
(`internalCall`) and on Playwright's artifact recorder. The object's `_parent` chain names the page, the context and
the browser it belongs to. The probe recorded these chains on 1.64.1:

| Call | Object chain |
|---|---|
| `page.setContent`, `locator.textContent`, `page.$`, `page.evaluate`, `page.click`, `page.title` | Frame < Page < BrowserContext < Browser |
| `elementHandle.textContent` | ElementHandle < Frame < Page < … |
| `keyboard.press`, `page.screenshot`, `page.waitForEvent` | Page < BrowserContext < Browser |
| `context.request.get` | APIRequestContext < BrowserContext < Browser |
| `context.newPage`, `browserContext.close` | BrowserContext < Browser |

The prototype's core:

```typescript
const OWNERS = new Set(['Page', 'BrowserContext', 'Browser', 'APIRequestContext']);
connection.sendMessageToServer = function (object, method, params, options) {
  const result = original.call(this, object, method, params, options);
  if (!options?.internal && options?.frames?.length) {
    const touch = () => {
      for (let owner = object; owner; owner = owner._parent)
        if (OWNERS.has(owner._type)) lastUse.set(owner, { at: Date.now(), frame: options.frames[0], api: options.apiName });
    };
    touch();
    result.then(touch, touch); // a long call (a wait, an assertion) is in use until it returns
  }
  return result;
};
```

- **Cost.** 3,000 `locator.textContent()` calls took 1.01 to 1.15 ms each with and without the wrapper; the difference
  was below the run-to-run noise. The bench's `resources` rung should hold it.
- **What it replaces.** The seven page-method wrappers and the locator factories' `noteResourceUse` (R5): "used"
  becomes "a user call landed on it". The same wrapper counts calls per method on long-lived objects (R6).
- **What the census gains, per object:** `lastUse { at, site, api, test }`, the number of uses, and for an object that
  outlives a test, the tests that used it.
- **Risk.** `_connection`, `sendMessageToServer`, `_parent`, `_type` and the `internal` flag are private. They were
  checked on 1.64.1 only, and the floor (1.59) is to be checked before building. Each is feature-detected; without
  them, the ledger keeps today's signal. The same Playwright change that broke them would break the
  `_instrumentation` hooks the ledger already rests on.

### 5.2 What the prototype saw

| Object | Last use | Closed | After its last use |
|---|---|---|---|
| G1 popup | `07-lingering.spec.ts:7`, its one check | by the `page` fixture's teardown | 2,551 ms |
| G2 admin context | `07-lingering.spec.ts:18` | `admin.close()` on the test's last line | 2,606 ms |
| G3 polling popup | `07-lingering.spec.ts:31` | by the fixture's teardown | 2,544 ms |
| G4 five pages | each one's check, `:43` | in a loop at the end | 49 to 338 ms each |
| H1 `beforeAll` context | `08-overscoped.spec.ts:14`, in the first test | in `afterAll`, after three more tests | 703 ms, across tests |
| A1 leaked context | `01-baseline.spec.ts:5` | by the worker's shutdown | 14.2 s |
| C1 helper's contexts | `helpers/open.ts:5` | by the worker's shutdown | 13.7 and 13.9 s |

The last row is where the fix for A1 goes: right after line 5. An object a fixture closes has a last use in the test
(G1), and an object used in one test and held through others has a last test that used it (H1).

### 5.3 New verdicts

| Verdict | Rule | Example | Fix it names |
|---|---|---|---|
| **lingering** | closed within its own test, by the test or a test-scoped fixture, after an unused tail of at least 2 s and a third of the test | G1, G2, G3 | close it after its last-use line, or `await using` in a block that ends there |
| **over-scoped** | a `beforeAll` or worker-fixture object that fewer tests used than it was held through | H1: used by 1 of 4 tests; B3: by 1 test of its worker | open it in the tests that use it, or split the describe block; a worker fixture one file uses becomes a `beforeAll`/`afterAll` pair or a test-scoped fixture |
| **churn** | a browser a test launches and closes, launched the same way by the next tests of its worker | I1: launch and close took 152 to 180 ms of each 276 to 322 ms test | a worker-scoped fixture |
| **idle**, extended | a context with no page, a browser with no context, an API context never called; per worker, a fixture browser that served no page | E2, F3, F4 | drop the call, or the fixture that asks for `browser` |
| **leaked**, with its last use | as today, plus the last-use line | A1: "close it after `01-baseline.spec.ts:5`" | `close()` there, or `await using` |

Pages open at once against pages in use (G4: five open, one in use) is a detail of a lingering finding, not a verdict.

**Rules for the new verdicts.** They are report-only: they never fail a test, and `--max-leaks` never counts them.
Their thresholds are absolute and relative together, so a short test with a 50 ms tail stays quiet. The thresholds are
tuned on the dashboard's own suite, which runs the same ledger through the dogfood mirror, before they are shipped.

### 5.4 What lingering costs

Sixteen tests on 4 workers, each opening a polling popup (a 3-million-step loop every 40 ms, standing in for an
animating or polling application) for one check, then working on its main page for about 4.5 s. Three rounds of each
variant, read from the reporter's machine panel:

| | Left to the `page` fixture | Closed after its last use |
|---|---|---|
| CPU, all processes | 24.3 to 25.4 s | 22.0 to 23.0 s |
| renderers | 9.3 to 9.6 s | 6.6 to 6.8 s |
| peak memory (PSS) | 1.8 GB | 1.7 GB |
| median test (first two rounds) | 4.69 to 4.90 s | 4.91 to 4.92 s |
| machine busy | 33 to 34% | 29 to 30% |

The renderers used about 41% more CPU, and the peak grew by about 100 MB. The tests did not get slower, because the
machine had idle cores. With one-second tests and the machine saturated, a first variant showed no difference: the
tail was too short to matter. A lingering page therefore costs what the page does while it waits, and only until its
test ends. It turns into time only on a saturated machine, which is what [resource-leaks.md](resource-leaks.md)
measured for leaked contexts (CPU pressure from 29% to 66%). Lingering ranks below leaks and over-scoped objects. Its
value is that it is common, its fix is one line, and the line is known.

## 6. Thinking large: what the lifetime model opens

### 6.1 Every finding carries its edit

The last-use line makes the fix concrete enough to write. Each verdict maps to one edit:

| Finding | The edit |
|---|---|
| leaked past its test, last use in the test's block | `await using` at the declaration, or `await x.close()` after the last-use line |
| leaked past its describe block | `test.afterAll(async () => { await x.close(); })` in that block |
| leaked by a test-scoped fixture | the close after `use()` in that fixture |
| lingering | `await x.close()` after the last-use line |
| over-scoped `beforeAll` | the open moved into the one test that uses it |
| churn | a worker-scoped fixture holding the browser |
| idle `page` fixture | the `page` argument removed, or the auto fixture opted out |
| handle | `close()` or `kill()` in an `afterEach` |

The same edit reaches four places:

- **the summary line**: "close it after `cart.spec.ts:24`";
- **the pull-request comment**, as a GitHub suggestion block on the diff, when the last-use line is part of the
  change;
- **the editor**: PR 5's quick fix, which needs exactly this line;
- **MCP**: a fix plan in `list_resource_findings`, as idea 17 of
  [resource-consumption-next.md](resource-consumption-next.md) asks.

S8's advice per kind comes from the same table.

### 6.2 Object lanes on the timelines

On the execution's failure timeline, each object a test touched gets a bar from its birth to its close, with a tick
per use and its unused tail hatched. The bar continues as a dashed tail past the test when the object leaked. This is
the resources lane PR 7 planned and did not build, with the uses added. On the run's workers timeline, the hatched
tails of leaked and over-scoped objects follow their worker's row across tests, which is the "tails" PR 7 also left
unbuilt. A failure that happened next to a busy lingering popup is then visible without reading a table.

### 6.3 Helpers and their callers

C1's finding points at `helpers/open.ts:3`, which is right, and stops there. The fix is often in the callers, which
should close what the helper returns, and the last-use line is in the caller. Keeping the spec's own frame beside
the first user frame gives "opened at `helpers/open.ts:3`, called from `03-helpers.spec.ts:5` and `:9`". The edit then
lands where the reader works.

### 6.4 A scope advisor over history

Each run records which tests used each worker-fixture and `beforeAll` object. Over runs, that answers a question no
single run can: the narrowest scope that serves every test that uses the object. Examples: "`adminPage` is used by one
file: a `beforeAll` there would free a page per worker for the rest of the run"; "`apiClient` is a worker fixture used
by every test: right as it is". It is the opposite of churn: churn is a scope too narrow for its object, over-scope is
one too wide.

### 6.5 What-if runs that measure the saving

[resource-leaks.md](resource-leaks.md)'s D12 forbids stating a saving that was not measured. The lifetime model can
measure it on the project's own suite. A lab run, like the flake lab's conditions, replays a run with each lingering
or over-scoped object closed right after its recorded last-use call. The call is identified by its line and its count
in the earlier run. The lab run is compared with a control run. Only a finding whose saving was measured this way
states one.

### 6.6 What a lingering page does

The capture fixtures already keep each page's network requests. The requests a page made after its last use are its
background traffic: "the popup polled `/api/notifications` 38 times after its last use". That names what the page was
doing, and it is idea 15 of [resource-consumption-next.md](resource-consumption-next.md) (long-lived connections and
timers), reached without a new reader.

### 6.7 Live, in the editor

While a test runs, or stands at a stop, the run channel can carry the open objects with the age of each one's last
use: "popup, idle 12 s". The pause bar could close one. A developer then sees a lingering page while the test is
still running, not after the run.

### 6.8 Upstream

Two small Playwright changes would retire most of the private reads: a target object on `onApiCallBegin`, and a
fixture's scope on the runnable. [resource-leaks.md](resource-leaks.md) Part 5 already lists the second.

## 7. The plan

### Quick wins

1. R1: the fixture scope read from its registration.
2. S3: the gate checks the capability.
3. S4: a handle's line on the tab and in the pull-request comment; S8's advice per kind.
4. R3: pages counted through every folded ancestor; a persistent context labeled as one.
5. R2: the `newPage` wrappers mark the page they return.

### Medium

6. The last use in the census (§5.1), replacing the page-method wrappers (R5); "close it after line X" on every leak,
   in the summary, the tab, the pull-request comment and MCP.
7. Lingering and over-scoped findings, report-only, with thresholds tuned on the dogfood suite.
8. Idle contexts, browsers and API contexts; churn (R7).
9. Piling on contexts and browsers, and per-method counts on long-lived objects (R6).
10. The fixture-free tier rebuilt per scope (R4).
11. The history: branch-aware reopening and moves, stable identities, an upsert in a transaction, and vouching only
    when the report could show the finding (S1, S2, S5, S6, S7).

### Larger

12. The editor's diagnostics and quick fixes from §6.1's table (PR 5), and suggestion blocks in the pull-request
    comment.
13. Object lanes and tails on both timelines (§6.2, PR 7's remainder).
14. The scope advisor (§6.4) and what-if runs (§6.5).
15. The failure clues of PR 5, with the lingering pages of the failing test among the neighbors they read.

## 8. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A use is a user call on the object or on anything under it. Piwi's and Playwright's internal calls never count, and neither does network traffic. | "Interacted with" is what the reader means. Background traffic is the lingering page's cost, not its use. |
| D2 | Lingering, over-scoped, churn and the new idle kinds are report-only: they never fail a test, and the leak rules of the gate never count them. | They are costs and advice. A leak is a defect. |
| D3 | A finding states a saving only when a what-if run measured it (§6.5). | D12 of [resource-leaks.md](resource-leaks.md). |
| D4 | A finding's identity holds only what changes when the leak changes: its verdict, its kind, and its opening line or fixture location. | S5: titles, counts and lists of other lines make an old leak read as new. |
| D5 | History changes status only from runs that can vouch: full runs of the default branch, with the tests that showed the finding passing. | S1, S2, S7. |

## 9. Open questions

- Should lingering be judged against the test's duration, or against the wall time of the calls after the last use?
  A test that ends in a long wait on the main page makes every other page "linger".
- Is an object that a helper returns, and the test never touches again, used by the test or only by the helper? The
  last use is the helper's line either way. The fix differs.
- Should over-scope count the tests that ran in the block, or only those that passed? A failed test restarts its
  worker, which ends the hold anyway.
- How long a history should the scope advisor want before it recommends a narrower scope?

## Appendix A. The battery

Each pattern ran on one worker, in its own file where scope matters (02 and 11 declare worker fixtures, so each ran in
a worker of its own), against a static server the global setup started: a home page with two buttons that open a
popup and a polling popup.

- **01** baseline: A1.
- **02** user fixtures: B1 (no teardown), B2 (the same with `{ timeout: 20_000 }`), B3 (worker-scoped, one user).
- **03** a helper in `helpers/open.ts` that opens a context, a page and navigates, called by two tests: C1.
- **04** `launchPersistentContext` in a temporary profile (D1); `chromium.launch()` in a `test.step` (D2).
- **05** `playwright.request.newContext()` left open (E1), and created and disposed with no call (E2).
- **06** `page` asked, `request` used (F1); `newContext()` then `close()` (F3); `launch()` then `close()` (F4);
  `keyboard.press` and `page.$` on `about:blank` (F5).
- **07** the four lingering patterns G1 to G4, each test about 2.8 s.
- **08** a `beforeAll` context with an `afterAll` close, used by the first of four tests (H1).
- **09** three tests that each launch, use and close a browser (I1).
- **10** an unawaited `close()` (J1), a file-level `afterAll` close (J2), `await using` (J3).
- **11** worker-scoped context and page, and four tests each adding a context listener, a browser listener,
  `addInitScript`, `exposeBinding` and a `newCDPSession` (K1 to K5).
- **12** a `beforeEach` that caches a context in a module variable, three tests (L1).
- **13** `Promise.all([browser.newContext(), browser.newContext()])` left open (N1).
- **bare/** the M patterns, run with `test` from `@playwright/test` and no fixtures.

## Appendix B. Checked and found sound

- An object handed on within a file and closed by a later test or a file-level `afterAll`, an unawaited `close()` and
  `await using` are never flagged.
- A helper's line is the leak's line, and two contexts opened on one line are one finding with a count of two.
- A persistent context's line is its `launchPersistentContext` call, and its first page is not mistaken for a popup.
- A leak in a `test.step` keeps the line inside the step.
- With one worker, the summary's held times run to the worker's shutdown, from the shutdown census.
