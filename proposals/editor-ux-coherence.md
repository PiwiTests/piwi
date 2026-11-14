# One Piwi in the editor: a UX audit of the JetBrains plugin and the VS Code extension

An audit of what a developer meets of Piwi in the editor: the JetBrains plugin (`apps/jetbrains/`) as the maintainer
uses it in Rider, and the VS Code extension (`apps/vscode/`), both thin clients of the editor service
(`packages/editor/`). Their menus, icons, settings, gutter marks, panels and run controls are read side by side, with
their seams to the dashboard, the desktop app and Piwi Picker, against one aim: a developer who moves between Piwi's
tools meets one Piwi.

**Status.** Proposed 2026-11-05 against `main` at v0.66.0 (`e82b429f`), rechecked on 2026-11-10 at v0.68.0 (`0e27d76f`),
and trimmed on 2026-11-12 to the work left at `b0ff6772`, where every line reference points. Built and left out of this
document: the quick wins Q1, Q3, Q4, Q6, Q7, Q10, Q11, Q14, Q15, Q17 to Q22 and Q24, the medium step M19, the 34
findings they fixed, and the parts of Q2, Q5, Q8, Q9, Q12, Q13, Q16, Q23, M6, M13 to M15, M20, M22 and L1 that the
remaining rows no longer name; git keeps their record. The defects still open are listed in §11. Built since, in part:
Q27 (JetBrains says a stopped service is not running, with Restart the editor service first, #1255; one did-not-answer
sentence, as a warning with its fixes; the MCP copies confirmed, the .NET note offered, Connect… on the connect-first
answer), Q28 (a CI run's tests never drawn as running on the test lines, which name it 'CI run #130' beside their own
result; an agent's label on `RunSession`, in the status bars' progress and JetBrains' Run tab) and Q30 (Re-run failing
only while a test fails; the Worker tab's image named per kind of lane), with a picked locator sent to the project whose
run made it (#1289). Also built since, with their
findings: Q25 (the JetBrains plugin's labels in sentence case, as VS Code's, so its labels quoted below in Title Case
now read in sentence case), Q12, Q5's Test connection (ST9), and Q8's Documentation in the gear, the headline in the
hover alone and Reload Piwi with a glyph of its own (HM9, ST18), and Q13's run notices on failures only by default and a
run's balloon titled by its run, VS Code's Connect failures in JetBrains' words (ST20), and Q23, the desktop app's
product name, Piwi Desktop, which #1317 shipped (AC13); and M6's End the test off the square and Finish's step-out glyph
in the Runs window and the desktop app, and the pause bar in the editors' order (IC5); and M22's held failure worded as
the run page words it, and JetBrains' status item saying why a test stopped (LR15); and M2's stop popup, result icon
menu and failures tree built from registered actions, the tree's as new `Piwi.Failure.*` ids, with Find Action synonyms,
and the status popup's rows registered too (`Piwi.ShowStop` on Show Execution Point's key, `Piwi.OpenRunPage`,
`Piwi.OpenFailures`, `Piwi.NodeSettings`, `Piwi.GoToRecordedLines`), one `Piwi.RunControl` group for Tools → Piwi and
the status popup, and `Piwi.OpenTraceSoFar` (AC6, NF2); VS Code's run node opens its page from its menu too, and both
say Open the screenshot (HM11). M2 is built; HM11's Verify ×3 and Jump to Source on failure nodes join M7's action list,
and the status popup takes one entry per run page (HM3); its three new groups (`Piwi.RunControl`, `Piwi.StatusActions`,
`Piwi.FailureActions`) wait for NF10's register of group ids. M5 and part of Q2: VS Code's outcome marks in the
dashboard's colors and one flaky glyph, Piwi's shuffle, in both editors (the result icon and JetBrains' CI tab), and
Piwi Picker's dots in the same palette, a running ring in both editors where they drew a run triangle, all held by
`status-mark-colors.test.ts` (copies restated by hand, not generated); and the dashboard's Reproduce here as the
editors' monitor (IC11); both CI views draw a test's outcome with its line's own mark, JetBrains' through one
`PiwiIcons.outcome`. Q26, IC7 and Q9 in part: the JetBrains plugin draws a glyph of its own in `icons/` for the 13
actions that had none, Connect's plug and a CI run's cloud, its status item a shared run with Share live's broadcast; VS
Code's Run the tests that reach this file and 'Piwi: unreachable' leave the glyphs of the Piwi mark and Disconnect, and
its CI lists open a run with the run pages' globe; `menus.test.ts` and `PiwiPluginTest` fail on a glyph two concepts
share but those they list (NF1). M5's tray and Runs window: the desktop tray's dot in the outcome palette, a run that
waits in the pause bar's violet, Piwi Picker's Runs window counting failed and flaky in it, VS Code's flaky word after a
line in fuchsia (`piwi.flakyForeground`) and the hover's flaky test with the word (IC4 in part). Q8: the Piwi tool
window's header is one line, the connection a link to Settings (`3 Playwright configs` with several) and the baseline a
link to Compare with…, the baseline in VS Code's failures view description too, and JetBrains' status popup offers one
entry per page (HM12, HM3). M18: both failures trees list the run's flaky tests under 'Flaky in this run', from a
`flaky` list the instance's branch failures answer gains, each opening at its `test(…)` line, saying Flake Lab's rate
(`flaky 18%`) and offering its Flakiness tab and Flake Lab's commands in its menu (**Look into this flake…**,
`piwi.lookIntoFlake`, in VS Code), and VS Code's status tooltip and JetBrains' status popup open the group (**Show the
run's flaky tests**, `piwi.showFlakyTests`, `Piwi.ShowFlakyTests`) (HM10). Q16: VS Code's integration suite stops the
editor service and starts it again through Restart the editor service (HM19 in part). Q29: Connect's failure words are
one table in the editor service (`connect-failures.json`), which VS Code reads and `GlueTest` holds the JetBrains
plugin's copy to, JetBrains gaining the expired, not-yet-valid, other-name, not-HTTPS and page answers VS Code said
(NF7). M6: the pause bar every headed stop shows draws each control's glyph, drawn anew in `picker-dom` (IC6). M20: VS
Code's Testing view shows each test's average duration, quarantine, Playwright tags and owner, from the catalog through
`SpecTest`, and publishes each result with its own duration, a failure's or its latest run's (TL20). Q2: a fixture check
in each editor fails when a flaky test loses its flaky mark, VS Code's nightly suite reading its Testing item and its
line's mark, `PiwiPluginTest` the bundled service's answer for its line and the result icon that answer draws (TL13).
Q13 in part: VS Code's run verdict ends with **Settings**, which opens `piwi.runNotifications`; a service notice that
comes unasked, may come again and hides nothing the developer must hear carries a key (`NOTICE_KEYS`): an agent's action
and a run that was lost carry none, so a key is on some notices rather than on each. VS Code offers **Don't Show
Again** on it, kept in `piwi.hiddenMessages`. VS Code's own repeated messages, JetBrains' gear and the balloon test
remain (HM15 in part). M4 in
part: one failure-tree node table for both editors, held to the protocol's icon keys by `PiwiPluginTest`, a cluster
drawn as Lucide's `layers`, an owner as a person and a spec as a file, and Assert a region in the dashboard and the Runs
window as the viewport corners; and the brand asset generator writes the editors' outline mark, the body, lens and eye
at 16 px and with the check at 20 px: the JetBrains New UI's through `PiwiIconMappings.json`, VS Code's `$(piwi-mark)`
in a product icon font built from the mark's strokes drawn as fills, drawn by the status item, both trees' run node and
VS Code's views (IC8, IC9). Q9: the font also takes the plugin's flaky, Pause and watch and Stop sharing glyphs and the
new Reload Piwi (`icons/reload.svg`, JetBrains' too) and Run to the cursor glyphs, at one line weight, so every VS Code
command draws one (IC1). M1: one action catalog, `packages/editor/src/actions.ts`, gives each action its ids in both
editors and one title in sentence case, with an ellipsis wherever it asks for something first and each platform's word
for the cursor and the window; `tests/actions.test.ts` holds `package.json` and `plugin.xml` to it, and the titles that
differed now read alike (Connect…, Open the log, Run a saved selection…, Turn hold failures on or off for the run, Show
or hide the coverage marks, Finish the test, End the test, Record at the stop, Record here… for the caret alone), and a
confirmation takes no ellipsis (Stop sharing the run live, in the share menus too) (X1, AC7,
AC10, AC9 and NF3 in part). M3 in part: JetBrains' Tools → Piwi in six compact sections (run, record, run control,
dashboard, agents, connection), its editor submenu with Record a new test file… as VS Code's has, and a **Piwi** submenu
in both editors' file trees that runs a spec or the tests that reach a file and records a new test file, and JetBrains' New offering **Playwright test (recorded)…** on a folder of a Playwright config
alone (AC1, AC3 in part). M3's status menu: a click on VS Code's status item opens **Open the Piwi menu**
(`piwi.statusMenu`), a quick pick in the JetBrains popup's sections, its first row the item's own action, so Enter
still refreshes. M13 in part: VS Code's status tooltip links Connect only while not connected, gives the item's
failing count after the local runs, and says how many tests the failed results are when a test failed on several
Playwright projects (HM1). M4's record family: JetBrains draws Record's actions with a gray disc (`icons/record.svg`),
Stop recording with a ring around a square, and a recording's gutter mark and banner with a red dot in a ring, a gray
ring while paused, and VS Code a paused recording with `$(circle-large-outline)`; JetBrains' Pause recording draws the ring and Resume
recording Record's disc, and VS Code marks the recorded block's first line in the gutter with the same glyphs, which
`status-mark-colors.test.ts` holds byte for byte; JetBrains' mark is also a menu (IC2). M4 in part: Piwi Picker draws Stop recording as a square in a ring (`stop-circle`) and Share live as a broadcast mark
(`broadcast`), apart from the run's Stop and a share of a result, and Finish steps out (`step-out`). M5 in part: Piwi Picker counts a test that waits for you in the pause bar's violet, in the popup's Runs
tile, the toolbar's badge and the Runs window, held by `status-mark-colors.test.ts` (IC4); both editors tint a failing test, its failing line and a recording in
`STATUS_COLORS`' failed and running fills, the JetBrains schemes blending them over classic Default's or Darcula's background, and VS Code's
held failure's arrow takes the failed fill (LI3); VS Code's running ring spins, still under the system's reduced
motion (TL5 in part). Q5: `PiwiPluginTest` holds Settings → Tools → Piwi within 100 columns of its font, every text
the page fills itself holding a long sentence and an address (ST14). §14 adds the findings the code that built the plan raised. The live-run study,
[live-runs.md](../adr/live-runs.md), has built P0 to P6 and P8 to P10, each but for leftovers its Status names, and part
of P7 and P11, and §8 names what the editors still lack; this document owns where each editor hosts a run and the
debug-session question ([LI10](#li10)), the study the live model, its words and its phases. Nothing here is on
[`ROADMAP.md`](../ROADMAP.md) yet. It cites and does not restate
[editor-extensions-audit.md](../adr/editor-extensions-audit.md), [developer-loop-audit.md](developer-loop-audit.md) §8
(P1 to P15) and §9 (the vocabulary), [record-from-the-ide.md](record-from-the-ide.md),
[real-editor-checks.md](real-editor-checks.md), [live-view-next.md](live-view-next.md) Part 6 and
[extension-ux-audit.md](extension-ux-audit.md). A pull request that builds a step removes its row and the findings it
fixes, and names it in this paragraph; the one that ships the last step moves the document to `adr/`.

**Summary.**

- **What is left.** Most of the plan's quick wins are built; the steps left center on one concept table and the words
  both clients show (M4, M22), the status menu (M3, M13), the run controls in the debugger's
  places and one page per worker (M14, M15), one action list per test line and Debug with Piwi (M7, M8), the settings
  registry and onboarding (M10, M11), the Rider layer (M17) and the debug-session decision (L3).
- **The data is shared and mostly right; everything around it differs.** One action has up to five names and two places,
  one outcome up to seven marks and four colors, one click means one thing in Rider and another in VS Code, and only the
  coverage colors and the stop words are held to one source by a test.
- **Nine findings lead (§0)**, from one action spelled four ways to Rider's keys colliding with Piwi's and a JetBrains
  plugin that misreports a stopped service.
- **Nine principles (§2):** one name, one glyph and one outcome palette per concept, held by tests; one menu shape and
  one home per editor; the IDE's own places first; the service words and decides, the clients draw; every entry
  registered and discoverable; quiet and switchable; checked where it is used, Rider included.
- **Twenty larger items (§10) and a ranked plan (§12):** 11 quick wins, most of them first, then 22 medium and 7 large
  steps, each the size of a pull request.

Every finding carries a file reference; the plugin's Kotlin files, all in
`apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/`, and its manifest,
`apps/jetbrains/src/main/resources/META-INF/plugin.xml`, are cited by file name. **(seen)**: observed in Rider
2026.2.4.1 or VS Code 1.143.1 on the editor fixture, as §1 describes, and still so in the code. **(read)**: from the
code at `b0ff6772`, or from the 241 and 262 platform jars. **(counted)**: counted from the manifests
(`apps/vscode/package.json`, `plugin.xml`).

One name per concept, used throughout: the **Piwi tool window** (JetBrains) and the **Failures view** (VS Code),
together the **home**; the **status item**, the **status popup** (JetBrains' menu on its click) and the **status menu**
(the quick pick proposed for VS Code); **Tools → Piwi** (the `Piwi.Actions` group); the **result icon** (Piwi's gutter
icon on a JetBrains test line) and the **IDE run icon** beside it; the **Testing view** (VS Code's, with Piwi's test
controller); the **stop line** (VS Code's lens row and JetBrains' inlay above a stopped line); the **paused page** (VS
Code's webview, JetBrains' Paused Page tab); the **editor service**; the **editor fixture**
(`apps/vscode/scripts/lib/editor-fixture.mjs`, the stub instance both screenshot scripts use); the **action catalog**,
the **concept table** and the **outcome palette** (proposed in §2); the **live-run study**
([live-runs.md](../adr/live-runs.md)).

---

## 0. The findings that matter most

1. **The words both clients show beside their actions are written twice with no test between them**
   ([AC9](#ac9), [AC11](#ac11), [NF3](#nf3)). A stop control's short labels, the recording's words and the start
   options differ from one client to the other.

2. **The status item behaves differently in each editor.** VS Code paints the item red for CI failures the developer did not cause, shows up to nine run items, and
   counts one run twice in two wordings ([HM2](#hm2), [LR1](#lr1), [LR18](#lr18)).

3. **A stopped Piwi run's controls are missing where JetBrains' debugger keeps its own**: no Run menu, editor menu or
   Run tab entries, no way back to the stopped line in VS Code, and no page per worker carrying the controls
   ([LR3](#lr3), [LR4](#lr4), [LR8](#lr8)).

4. **From a test's own line, neither editor offers more than Run and Verify ×3, and nothing debugs it**: JetBrains'
   result icon opens a browser, VS Code's Testing menus have no Piwi entry and no Debug profile ([TL2](#tl2),
   [TL3](#tl3), [TL17](#tl17)).

5. **A CI or teammate run reads as the developer's own on the test lines, and an agent's run in the status bars**
   ([NF4](#nf4), [LR10](#lr10)).

6. **Most of Piwi's glyphs are tied to no table or test across its tools**: only the outcome, coverage and
   recording marks are ([X2](#x2)).

7. **In Rider, Piwi's chords collide with the Visual Studio, ReSharper and Visual Assist keymaps, and no check opens
   Rider** to see a spec beside the solution or a C# file ([AC12](#ac12), [RD3](#rd3), [RD4](#rd4)).

8. **The settings differ in each editor, and JetBrains introduces Piwi with one balloon**: VS Code's list is
   alphabetical with code values, the scopes differ, the gutter icons, locator warnings and tint cannot be switched off,
   and JetBrains has no Get Started ([ST7](#st7), [ST8](#st8), [ST12](#st12), [ST1](#st1)).

9. **JetBrains misreports a stopped service, and many of its messages give no way out** ([NF5](#nf5), [HM8](#hm8)).

The rest of this document is the evidence behind these and the smaller findings (§3 to §9 and §14), the larger
items (§10), the defects still open (§11) and the ranked plan (§12).

---

## 1. Method

Eight finder slices, one per area, read the code and the manifests. An adversarial verifier read each slice: of 195
findings, 194 were kept (122 confirmed, 47 amended with the verifier's correction, 25 added by the verifiers) and 1
refuted. Clustered by theme, they gave 134 clusters, 15 of them merged across themes: the audit's 119 findings of §2 (X1
to X3) and §3 to §9. The recheck added LR18, and 85 of the 120 remain open at `b0ff6772`.

Two hands-on runs drove Rider 2026.2.4.1 and VS Code 1.143.1 under Xvfb against the editor fixture, with the plugin and
the extension built at `e82b429f`; a scratch platform test listed the actions of `Piwi.Actions`, `EditorPopupMenu`,
`GenerateGroup` and `NewGroup` in WebStorm 2024.1. Platform facts were read from the 241 and 262 jars
(`PlatformIconMappings.json`, the bundled keymaps resolved with their parents, `javap`) and from the platforms' UI
guidelines.

Not covered: macOS and Windows; a fixture with a real `@playwright/test`, so the IDE run icon was never drawn; C# files
in Rider; a screen reader in JetBrains; Firefox for Piwi Picker. The screenshots stay outside the repository, cited only
as **(seen)**.

On 2026-11-12, four reviews read the code at `b0ff6772` against every finding and step: the findings fixed by then are
left out, the others carry their lines at that commit, and §14 adds what the new code raised.

---

## 2. One Piwi across tools: the principles

Piwi reaches a developer in six tools: the dashboard, Piwi Picker, the desktop app, VS Code, the JetBrains IDEs and,
since v0.68.0, Piwi Runner (`apps/runner`), the small app that runs a team instance's requests on the person's machine.
These rules hold them together; each larger item of §10 carries one or more.

1. **One name per concept, from the action catalog and a words table that both manifests and both clients are tested
   against, in sentence case in both editors.** ([AC11](#ac11))
2. **One glyph per concept and one meaning per glyph, from the concept table; a glyph no platform has, Piwi draws
   once.** ([X2](#x2))
3. **One outcome palette: `STATUS_COLORS` and the dashboard's status glyphs, restated in each tool and held to them by a
   test, as `coverage-mark-colors.test.ts` holds the coverage marks; flaky, quarantine and history always drawn.**
   ([LI3](#li3))
4. **One menu shape (Run, Record, Run Control, Dashboard, Agents, Connection, each showing what applies now) and one
   home per editor, with the same tabs, toolbar order and empty states.** ([HM6](#hm6))
5. **The IDE's own places first, with Run, Debug and Coverage meaning what the IDE means; Piwi's own marks only for what
   the IDE cannot show.** ([TL2](#tl2), [TL3](#tl3), [LR3](#lr3), [AC3](#ac3))
6. **The service words and decides, the clients draw, and a contract test fails when the service sends an icon key a
   client lacks.** ([AC11](#ac11), [HM8](#hm8), [HM16](#hm16))
7. **Registered and discoverable: every Piwi entry in a JetBrains popup is a registered action, every VS Code command
   has an icon and a when clause.** ([LI1](#li1))
8. **Quiet, and switchable where the IDE keeps its switches: an alarm only for what the developer's own work caused, one
   interruption, and an off switch for every mark.** ([HM2](#hm2), [HM15](#hm15), [ST8](#st8), [TL4](#tl4))
9. **Checked where it is used: both editors compared on the editor fixture without a JetBrains license, a Rider scene on
   `examples/sample-app`'s ASP.NET Core backend, and docs that claim only what a check holds.** ([LR6](#lr6),
   [RD4](#rd4))

<a id="x2"></a>**X2. The same concept is drawn differently in each Piwi tool, and no table or test ties the glyphs
together.** Only the coverage colors are tested
(`apps/application/tests/unit/coverage-mark-colors.test.ts`). **(read)** Fix: the concept table of [Appendix
A](#appendix-a-the-concept-table-first-draft), the missing glyphs drawn once, restated in each tool under the
concept-table test and a `status-mark-colors.test.ts` beside `coverage-mark-colors.test.ts`. ([M4](#m4), [LI2](#li2))

<a id="x3"></a>**X3. Piwi Picker's popup and the desktop app's tray keep lists of their own.** The status item opens one Piwi
menu in both editors, but neither Piwi Picker nor the tray takes its order and words. **(read)** Fix: Piwi Picker and
the tray take [LI4](#li4)'s order and words. ([M3](#m3), [LI4](#li4))

**What 1.0 allows.** [1.0-stabilization.md](1.0-stabilization.md) D25 lists every command, setting and action id of both
editors, held to the manifests by `apps/application/tests/unit/editor-ids-register.test.ts`; the group and view ids are
not in it yet ([NF10](#nf10)). Titles, icons, menus and their order are not frozen, so they may change before 1.0 and
after. Every id a step adds is registered in D25 in the same pull request.

## 3. Icons and the visual language

What works: the coverage marks are one palette across the dashboard and both editors, held by
`apps/application/tests/unit/coverage-mark-colors.test.ts`. **(read)** The glyphs still to draw are those
[Appendix A](#appendix-a-the-concept-table-first-draft), the concept table, marks as new.

## 4. Menus, actions, keys and names

### 4.1 Menus

<a id="ac3"></a>**AC3. Piwi is in neither Rider's Solution Explorer nor its Tests menu, and New offers Record a new test file…
on any folder of a project with a Playwright config.** Both editors' file trees have a **Piwi** submenu
(`Piwi.ProjectViewPopup`, VS Code's `piwi.explorerContext`), but in Rider 2026.2.4.1 a folder's menu offers the IDE's
Run Tests in tests/ and Solution Explorer's offers Run Unit Tests, with nothing from Piwi in either, and Add lists
Record a new test file… among the file kinds, on C# project folders too, since it needs only a Playwright config in the
project (`PiwiRecordingActions.kt:101-104`). **(seen)** Fix: the same group in Solution Explorer and the Tests menu
through an optional Rider descriptor, and New → Playwright Test (Recorded)…, which
[record-from-the-ide.md](record-from-the-ide.md) Part 2 plans, on config folders only. ([M3](#m3), [M17](#m17),
[LI4](#li4), [LI16](#li16))

### 4.4 Names

<a id="ac9"></a>**AC9. Inside JetBrains each stop control carries a full name and up to two short labels, kept apart from VS
Code's.** Finish the test in Tools → Piwi is Finish on the stop line (`Glue.kt`, `StopControl`), and Record at the stop
is Record in the stop's popup and on the inlay (`Glue.StopAction`), where VS Code's hover says Record
(`apps/vscode/src/run-control.ts`, `STOP_ACTIONS`); nothing holds the short labels of one client to the other's.
**(read)** Fix: a short label per control in the words table of [LI1](#li1), held by a test over both clients.
([M22](#m22), [LI1](#li1))

<a id="ac11"></a>**AC11. The stop's control labels and the recording's words exist twice, in the VS Code extension and
`Glue.kt`, with no test between them, and differ.** `apps/vscode/src/run-control.ts:1127` says Run to cursor where
`Glue.kt:2552` says Run to Caret, and a paused recording reads "paused · N" (`apps/vscode/src/glue.ts:1227-1229`) or
"recording paused · N" (`Glue.kt:3223`); `apps/application/tests/unit/stop-words-drift.test.ts` holds only the words for
why a test stopped. **(read)** Fix: the editor service sends the words and the clients map only icons; the rest comes
from the words table of [LI1](#li1), held by a test over both clients. ([M22](#m22), [LI1](#li1),
[LI6](#li6))

### 4.5 Keys

<a id="ac12"></a>**AC12. Piwi's Ctrl+Alt+Shift chords are already taken in the keymaps that Rider ships: R and K in the
Visual Studio, Visual Studio 2022, Visual Assist and ReSharper keymaps, and F in ReSharper's by Silent Code Cleanup, and
no key opens the Failures in either editor.** `plugin.xml:135`, `:158`, `:193`, `:204` bind K, F and R in `$default`
only; the table lists what Rider 2026.2.4.1's keymaps, resolved with their parents, bind to them (which action wins was
not checked), and `apps/vscode/ARCHITECTURE.md:895-897` names the Rider keymaps' letters but not their actions, and
plans no remedy. Nothing binds the Piwi tool window or the Failures view, though
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) Q8 names that key and its Status counts Q8 built.
**(read)** Fix: chords for the Visual Studio, Mac OS X 10.5+ and Visual Studio OSX keymaps, which the others inherit,
from one table a test checks against every keymap bundled with WebStorm, IDEA and Rider; one Failures chord in both
editors. ([M16](#m16), [LI15](#li15))

| Rider keymap | R: Record Here, Stop Recording | K: Run the Test at the Caret | F: Re-run the Failing Tests |
|---|---|---|---|
| Visual Studio, Visual Studio 2022, Visual Assist | `ChooseRunConfiguration` | `Git.Commit.And.Push.Executor` (and `Hg.`) | free |
| ReSharper | `ChooseRunConfiguration` | `Git.Commit.And.Push.Executor` (and `Hg.`) | `SilentCodeCleanup` |
| Visual Studio OSX, Visual Assist OSX (Cmd) | `ChooseRunConfiguration`, `ForceRefresh` | `CheckinProject` | free |
| ReSharper OSX (Cmd) | `ChooseRunConfiguration`, `ForceRefresh` | free | `SilentCodeCleanup` |
| Mac OS X 10.5+, VSCode OSX, Sublime Text (Mac OS X), macOS System Shortcuts (Cmd) | `ForceRefresh` | free | free |

## 5. The test line

What works: both editors draw the same answer per line from the editor service (`piwi/fileSummary`), so the pass rate,
the failing line and the evidence are the same data in Rider and in VS Code. **(read)** What differs is what a click
does, what the line says and which marks it carries.

<a id="tl1"></a>**TL1. VS Code's Testing view carries Piwi's results and none of its actions, and in both editors the
IDE's own test UI is mostly unused.** `apps/vscode/src/test-explorer.ts:127-135` creates two Run-kind profiles and no
Debug or Coverage profile, `apps/vscode/package.json` contributes no `testing/*` menu, and coverage is drawn as Piwi's
own decorations, outside the Test Coverage view; in JetBrains the IDE run icon has no Piwi entry. **(seen)** Fix: each
IDE's test UI as Piwi's home, Run, Debug and Coverage meaning what the IDE means, and Piwi's own marks kept for flaky,
quarantine and history, which no IDE shows ([editor-extensions-audit.md](../adr/editor-extensions-audit.md) L1 built the
view results-only). ([L2](#l2), [LI8](#li8))

### 5.1 The gutter and its menus

<a id="tl2"></a>**TL2. From a test's own gutter icon, neither editor offers more than Run and Verify ×3: JetBrains' left
click opens a browser, and VS Code's Testing menus have no Piwi entry.** A left click on the result icon runs the line's
command, `piwi.openInDashboard` (`PiwiTestAnnotator.kt:112-118`, `packages/editor/src/server.ts:3143-3147`), and its
right-click menu holds the registered `Piwi.RunTestAtCursor` and `Piwi.VerifyTestAtCursor` alone. VS Code's Testing
gutter offers Run Test and Execute Using Profile…, since `apps/vscode/package.json:590` declares no `testing/item/*` or
`testing/message/*` menu, and the hover links Run and Open in dashboard (`apps/vscode/src/glue.ts:664-673`). From the
gutter, nobody can open its trace, hand it to an agent, debug it or record into it, and in Rider the click that runs a
test on the IDE run icon opens a browser on Piwi's. **(seen)** Fix: one ordered action list per test line from the
service, in five groups ([LI7](#li7)), opened by either click in JetBrains from registered actions, and placed in VS
Code's `testing/item/gutter`, `testing/item/context` and `testing/message/context`. ([M7](#m7), [LI7](#li7))

<a id="tl3"></a>**TL3. The IDE run icon on a JS test carries no Piwi action, so a test with no Piwi result yet cannot be
run with Piwi from its line.** Without an instance, or for a test the catalog lacks, the service sends no result
(`packages/editor/src/server.ts:3069, 3106`), so a new test has no result icon. In WebStorm 2024.1,
`JSTestRunLineMarkersProvider` fills the IDE run icon's menu from the empty `JSTestRunLineMarkersAdditionalActionGroup`
(`js-testing.xml:17, 75`), and the icon starts the IDE's own run, which Piwi follows with no Stop. The fixture's
`@playwright/test` is a stub, so neither hands-on run drew the icon. **(read)** Fix: Piwi's test actions added to that
group, hidden outside a config's folder, checked in Rider 2026.2 and every IDE of `verifyIdes` against a real
`@playwright/test`: the remaining half of [developer-loop-audit.md](developer-loop-audit.md) P1. ([M9](#m9),
[LI7](#li7))

<a id="tl4"></a>**TL4. In JetBrains Piwi's result icon cannot be switched off, so a test line can carry two state icons
that disagree, the IDE's last local run and Piwi's latest.** The IDE run icon draws its last run from
`TestStateStorage`, and `PiwiTestAnnotator.kt:63-66` adds Piwi's from an external annotator; the Gutter Icons settings
page lists `LineMarkerProviderDescriptor`s, not an annotator's icon ([ST8](#st8)). A green check from the developer's
run can sit beside a red X from CI, and only the IDE's can be hidden. **(read)** Fix: a "Piwi test results" entry on
the Gutter Icons page, a descriptor whose switch the annotator reads. ([M9](#m9), [LI8](#li8))

<a id="tl5"></a>**TL5. A running test's mark does not spin, and in JetBrains a click on it opens a browser.** Both
editors draw the outcome palette's running ring (`test-running.svg`, `PiwiIcons.RUNNING`), still where the dashboard
spins its loader (`apps/application/app/utils/index.ts`), and JetBrains' click opens the dashboard
(`PiwiTestAnnotator.kt`). **(read)** Fix: the ring animated where the gutter allows it (an open question for JetBrains),
its click opening [TL2](#tl2)'s popup. When the mark appears, from local events, is the live-run study's P4
([LR9](#lr9), live-runs E3). ([M5](#m5), [LI3](#li3))

<a id="tl6"></a>**TL6. With the Testing view off, VS Code's gutter mark cannot be clicked and has no menu.** The marks
are decorations (`apps/vscode/src/extension.ts:489-496`), and `apps/vscode/package.json` contributes no
`editor/lineNumber/context` entry, so a test's only actions there are its hover's two links. **(seen)** Fix: Piwi's test
actions in `editor/lineNumber/context` behind a `piwi.testLines` context key. ([M7](#m7), [LI7](#li7))

### 5.2 One role per surface

<a id="tl7"></a>**TL7. Nine surfaces act on a failing test, each with its own subset of actions and words, and the quick
fixes mix navigation with edits under no Piwi name.** In VS Code: the Testing gutter, the hover, the lens row
(`packages/editor/src/server.ts:3155-3190`), six quick fixes (`server.ts:2690-2782`) and up to three desktop jobs
(`:2118-2123`), the editor menu, the Failures view and the profiles; in JetBrains, the result icon and the Piwi tool
window. Run has five names (Run with Piwi, Run this test, Run This Test, Run, Run the test at the cursor), Verify ×3 is
missing from the hover and the lens, and the quick fixes, all `CodeActionKind.QuickFix` with no Piwi prefix, sit in the
light bulb between Heal and TypeScript's Move to file. **(seen)** Fix: one role per surface in both editors: the gutter
acts ([TL2](#tl2)), the hover says why, the lens shows evidence, a quick fix only edits ("Piwi: use getByRole(…)"), and
the service owns every title, the words added to [developer-loop-audit.md](developer-loop-audit.md) §9's table.
([M7](#m7), [LI7](#li7))

<a id="tl9"></a>**TL9. Record here is in JetBrains' Alt+Enter list on any line of a script, imports included, and
missing from VS Code's Ctrl+.** `RecordHereIntention.kt:22-25` offers it anywhere under a config folder; VS Code
registers only the recorded-locator fixes (`apps/vscode/src/recording.ts:833-836`). **(read)** Fix:
[record-from-the-ide.md](record-from-the-ide.md) Part 2's two places, between tests and inside a test body, in both
editors, as a refactor-kind action from the service ([TL7](#tl7)). ([M7](#m7), [LI7](#li7))

### 5.6 Debug

<a id="tl17"></a>**TL17. Neither editor can debug a test from its line or its failure: VS Code has no Debug profile, the
dashboard's stop-at-the-failing-line run is reachable only through its link, and every plain Run stops at breakpoints.**
`apps/vscode/src/test-explorer.ts:127-135` creates Run-kind profiles only, so Debug Test reaches nothing.
`RunTestsArgs.debug` (`packages/editor/src/protocol.ts:334-339`) runs one test headed and stops once at the failing
line, but only the dashboard's Debug in my editor starts it; the failure nodes and the failure's quick fix offer Run but
no Debug (`packages/editor/src/server.ts:2689-2701`). Every run but Verify ×3 passes the breakpoints while
`piwi.breakpoints` is on, its default, and `withBreakpoints` makes it headed (`server.ts:3434-3457`). To stop a CI
failure at its line, a developer goes through the dashboard and a consent prompt, while yesterday's breakpoint pauses
Run with Piwi. **(seen)** Fix: Debug with Piwi, the dashboard's run for a failure and a headed run otherwise, as VS
Code's Debug profile and in [TL2](#tl2)'s list, on [TL3](#tl3)'s icon and on failure nodes (Debug this failure there;
§13), with no consent prompt; whether plain Run still stops is open (`piwi.breakpoints` keeps its key, and a new value
could keep stops for Debug). It is Piwi's run control, not an IDE debug session ([LI10](#li10)). ([M8](#m8),
[LI7](#li7))

### 5.7 The IDE's own test UI

<a id="tl18"></a>**TL18. Piwi's coverage sits beside each IDE's coverage rather than inside it: VS Code gets no Test
Coverage view, and JetBrains paints in the IDE coverage's strip.** VS Code draws its own borders
(`apps/vscode/src/extension.ts:628-657`) and never calls `TestRun.addCoverage`, which VS Code's engines floor, 1.91,
already offers, so no per-file percentage shows Piwi's data. JetBrains' coverage mark paints at `Position.LEFT`
(`PiwiCoverageMarks.kt:252`), the IDE coverage's strip, so after Run with Coverage the two bars overlap, and its click
shows only a hint (`:256-260`). **(read)** Fix: a Coverage profile and `FileCoverage` on the results run in VS Code; in
JetBrains, a click menu (Run the tests that ran these lines, Next uncovered line, Hide, Edit colors…) and Piwi's marks
skipped while the IDE shows its own. ([L2](#l2), [LI8](#li8))

<a id="tl19"></a>**TL19. JetBrains has no per-test view of a Piwi run in progress, while VS Code shows one in its
Testing view.** VS Code publishes a run in progress test by test (`apps/vscode/src/test-explorer.ts:163-183`); JetBrains
shows counts in the status item and "running x/y" on the Piwi tool window's run node (`Glue.kt:586-587`), and the IDE's
test tree comes only with its Playwright runner, off by default and never offered. **(read)** Fix: offer the runner once
([editor-extensions-audit.md](../adr/editor-extensions-audit.md) §6.4), and give other runs an SMTRunner console fed by
the run channel's test events. Local progress is [LR9](#lr9). ([L2](#l2), [LI8](#li8))

### 5.8 A test card

<a id="tl21"></a>**TL21. A test's tooltip and hover are one line, though the service holds its history, last failure,
owner, trace and screenshot.** `Glue.kt:832-833` and `apps/vscode/src/glue.ts:699-701` show the service's one-line
summary, while the dashboard's test page draws the history, flaky rate, owner and quarantine. To answer "my bug or a
flake?", the developer leaves the editor. **(seen)** Fix: a `piwi/testCard` request (the last N results as a strip, the
flaky rate, the last failure, owner, quarantine, the evidence and [TL2](#tl2)'s action list), a popup on the result icon
in JetBrains and the hover in VS Code, laid out like the dashboard's test row: the test counterpart of the element card
of [extension-ux-audit.md](extension-ux-audit.md) §4.1. ([L5](#l5), [LI7](#li7))

## 6. Settings, connection, onboarding and agents

What works: the API key never sits in a setting (VS Code's secret storage and the IDE's password safe, each per
instance), both clients take the connection order from the service (`packages/editor/src/context.ts:263`), and
`apps/vscode/tests/walkthrough.test.ts` fails when a walkthrough step names a command that is gone. **(read)** The
direction is one settings registry ([LI11](#li11)), one onboarding script ([LI12](#li12)), and the connection computed
once and shown first ([LI13](#li13)).

### 6.1 The first minutes

<a id="st1"></a>**ST1. A JetBrains IDE has no Get Started: onboarding is one balloon, shown once per installation and
only while nothing names an instance.** `PiwiProjectService.kt:342-354` shows it in a trusted project with a Playwright
config while nothing connects it or names an instance (`Glue.showsFirstRun`), with Connect…, Open the Failures and Learn
More but no Record. A Rider or WebStorm workspace connected through the environment, `.env` or the desktop app never
sees it, and nothing reopens a missed one. VS Code opens a six-step walkthrough once per machine
(`apps/vscode/src/extension.ts:396-403`) and keeps **Piwi: Get started**. **(read)** Fix: `Piwi.GetStarted` (Tools →
Piwi, the Piwi tool window's gear menu, Help) opening a Get Started tab in the Piwi tool window once per installation,
rendered from the walkthrough's step list with the same buttons and checks. ([M11](#m11), [LI12](#li12))

<a id="st2"></a>**ST2. VS Code's walkthrough is six steps of text that skip breakpoints, the Testing view and Piwi
Picker, and its description is cut off.** `apps/vscode/package.json:105-184` gives each step a Markdown page, though the
docs hold screenshots of the same fixture; breakpoints get one sentence (`apps/vscode/walkthrough/run.md:12-13`),
pairing Piwi Picker none, and `apps/vscode/walkthrough/settings.md` lists 6 of the 11 settings. In VS Code 1.143.1 the
description ends in 'run and record test…'. A new user never sees a run paused at a breakpoint, the loop Piwi is built
around. **(seen)** Fix: a one-line description, steps for a breakpoint stop and for pairing Piwi Picker, the docs'
images as `media.image`, an MCP step per editor through `when`, `settings.md` generated from the registry ([ST7](#st7)),
and the six-step cap of `apps/vscode/tests/walkthrough.test.ts:32` raised. ([M11](#m11), [LI12](#li12))

<a id="st3"></a>**ST3. The disconnected home offers only Connect in both editors and never says that recording works
without an instance.** The Failures view's welcome (`apps/vscode/package.json:74-78`) and the Piwi tool window's empty
text (`Glue.kt:1119`, from `packages/editor/src/failure-tree.ts:434`) say only that Piwi is not connected, as
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) §3.1 noted for VS Code. **(seen)** Fix: Record a new
test file… beside Connect…, under a second line, 'Recording works without one'. ([M11](#m11), [LI12](#li12))

<a id="st4"></a>**ST4. VS Code's first activation in an already-connected workspace can raise the walkthrough, the MCP
notice and the desktop offer together.** The walkthrough opens once per machine
(`apps/vscode/src/extension.ts:396-403`), then each full status read calls `offerDesktop` and `offerMcp`
(`extension.ts:815, 826`); on 1.101+ the MCP toast repeats the walkthrough's step (`extension.ts:1968-1974`). **(seen)**
Fix: one first-run queue in both editors (JetBrains offers MCP at its first connected status): the tour, the desktop
offer, then the MCP offer after the first failure shown, none on 1.101+. ([M11](#m11), [LI12](#li12), [LI14](#li14))

### 6.2 The settings pages

<a id="st7"></a>**ST7. The two settings pages show the same options in different groups and orders, and VS Code's is one
alphabetical list with code values.** `apps/vscode/package.json:1133-1246` is one configuration object with no `order`,
so VS Code sorts its 11 keys alphabetically with `piwi.serverUrl` ninth, shows `error` and `key` in its dropdowns and
titles one key 'Mcp Authorization'. `PiwiConfigurable.kt:47-206` binds 12 controls in five groups, words its choices and
checks the URL. Each side has options the other lacks, and the words are written three times,
`apps/vscode/walkthrough/settings.md` included. A team using both editors cannot describe one setup. **(seen, counted)**
Fix: [LI11](#li11)'s settings registry, VS Code's choices labeled with `enumItemLabels`, keys unchanged and grouped as
the last column below. ([M10](#m10), [LI11](#li11))

Place is the position on the page today. VS Code's window scope is per user and overridable by a workspace file
([ST12](#st12)); JetBrains keeps the URL and project in `piwi.xml`, the rest in `workspace.xml`.

| Option | VS Code key (place), scope | JetBrains group (place), file | Proposed group |
|---|---|---|---|
| The desktop app first, and its project | Connect's choice, `workspaceState` | Piwi Desktop App (3, 4), workspace | Connection |
| Instance URL | `piwi.serverUrl` (9), window | Instance (1), `piwi.xml` | Connection |
| Project | `piwi.project` (4), window | Instance (2), `piwi.xml` | Connection |
| API key | secret storage, no row | Instance, a label; password safe | Connection |
| Connection in use | the status tooltip only | In use (first), with Reconnect | Connection, first |
| Failure severity | `piwi.failureSeverity` (2), window | Runs (6), workspace | Editor |
| Lenses, gutter icons, locator warnings, tint | none ([ST8](#st8)) | none; Code Vision's Piwi entry, all or none | Editor |
| Coverage marks | a command, `workspaceState` | a toggle action, workspace | Editor |
| Run notifications | `piwi.runNotifications` (7), window | Runs (5), workspace | Runs |
| Breakpoints | `piwi.breakpoints` (1), window | Runs (7), workspace | Runs |
| Every run headed | `piwi.runHeaded` (5), window | Runs (8), workspace | Runs |
| Hold failures from each run's start | `piwi.runHoldFailures` (6), window | Runs (9), workspace | Runs |
| Piwi's tests in the Testing view | `piwi.testExplorer` (10), window | none | Runs |
| The IDE's Playwright runner | none | Runs (10), workspace | Runs |
| MCP sign-in | `piwi.mcpAuthorization` (3), application | AI Assistant (11), workspace | Agents |
| Serve the runs to agents | `piwi.serveRunsToAgents` (8), window | AI Assistant (12), workspace | Agents |
| The service's trace | `piwi.trace.server` (11), window | none ([developer-loop-audit.md](developer-loop-audit.md) P8) | Diagnostics |

<a id="st8"></a>**ST8. Neither client can turn off Piwi's gutter icons, locator warnings or failing-test tint on their
own, VS Code its lenses only with every other extension's, and a spec carries a lens over nearly every locator line.**
The service emits a lens for each locator line of test code, specs included (`packages/editor/src/server.ts:3083-3095`),
so a 29-line spec in VS Code shows a file lens, a '1 test · click' lens over most locator lines and two failure lenses,
and only `editor.codeLens`, which hides every extension's lenses, turns them off. Of the display options
`EditorCredentials` carries only `failureSeverity` (`packages/editor/src/protocol.ts:543-574`), and coverage marks are a
per-workspace command and a JetBrains toggle. **(seen)** Fix: before D25 freezes the keys, `piwi.codeLens` (all,
problems, off), `piwi.gutterIcons`, `piwi.coverageMarks`, `piwi.locatorWarnings` and `piwi.failingTestTint`, which the
service reads from the credentials to filter lenses and diagnostics once for both clients, dropping a spec's lens whose
only test is the one around it; JetBrains shows the five in its Editor group ([TL4](#tl4)). ([M10](#m10), [LI11](#li11))

<a id="st12"></a>**ST12. The scopes differ: every JetBrains choice is per project, VS Code's are per user, and a
committed `.vscode/settings.json` can override a personal choice.** JetBrains keeps all but the URL and project in
`workspace.xml` (`PiwiProjectService.kt:94-115`); VS Code gives every key the window scope but `piwi.mcpAuthorization`,
which is application (`apps/vscode/package.json:1205-1207`). A JetBrains developer with ten projects picks 'A warning'
ten times, and a repository that commits `piwi.breakpoints` set to false turns breakpoints off for every VS Code user
and for no JetBrains user. **(read)** Fix: each option's scope set once in the registry, team (URL, project, perhaps
`failureSeverity`), user or machine (the desktop app); VS Code's personal keys scoped `application` or `machine`; a
JetBrains Defaults page at the application level, each project showing 'Default (…)' or its override. ([M10](#m10),
[LI11](#li11))

<a id="st13"></a>**ST13. The settings page says 'Kept for you only, in .idea/workspace.xml' nine times and names paths
that do not exist in Rider.** The sentence closes nine comments
(`PiwiConfigurable.kt:107, 125, 135, 143, 151, 163, 173, 188, 197-198`), and in Rider both files sit under
`.idea/.idea.<Name>/.idea/` (`Glue.projectFolder`). **(read)** Fix: one comment per storage group, its path computed
from the project's store directory. ([M10](#m10), [LI11](#li11))

<a id="st15"></a>**ST15. Neither the JetBrains settings page nor its Connect dialogs link to the documentation, and the
Settings dialog's help button gives nothing for Piwi.** `PiwiConfigurable.kt:34` sets no help topic and no
`webHelpProvider` is registered; VS Code's descriptions link nowhere, and the docs have no editor settings table.
**(read)** Fix: a `WebHelpProvider`, a Documentation link per group, the same anchors in VS Code, and a settings section
generated from the registry. ([M10](#m10), [LI11](#li11))

### 6.3 Connecting

<a id="st16"></a>**ST16. Connecting in JetBrains is a chain of up to five modal dialogs, the settings page takes the
project as free text, and the sign-in code and link sit in an uncopyable progress dialog.** `PiwiConnectFlow.run` chains
the desktop-or-instance choice, the URL, sign in or paste, a modal sign-in and the project
(`PiwiConnect.kt:131, 241, 257, 296-316, 162`). On the settings page both projects are free text
(`PiwiConfigurable.kt:84-90`, `:110-116`), though the desktop app's list is at hand (`PiwiConnect.kt:206`), and the key
has no Change or Remove. The sign-in's code and link are progress text (`PiwiConnect.kt:297-298`); VS Code's
notification shows the code and no link (`apps/vscode/src/extension.ts:2207-2212`). A typo in the project reads as not
connected, and a browser opened in another profile leaves Cancel as the only way out, in both editors. **(read)** Fix:
[LI13](#li13)'s Connect panel, in the settings page and as one dialog, and a non-modal sign-in with Copy code, Copy link
and Open browser again, as VS Code's notification also gets. ([M12](#m12), [LI13](#li13))

### 6.4 Agents

<a id="st21"></a>**ST21. The JetBrains agent setup is named after one product: the 'AI Assistant' group and the copy
notices point at the AI Assistant's settings, also in a Rider without it.** The group is 'AI Assistant'
(`PiwiConfigurable.kt:180`), and the notice after a copy names first 'Settings → Tools → AI Assistant → Model Context
Protocol', a page Rider 2026.2.4.1 lacks without the AI Assistant, and 'your agent's MCP settings' only in parentheses
or after a comma (`PiwiActions.kt:461-462`, `:495`); VS Code and the docs say 'your agent'. **(seen)** Fix: 'Agents
(MCP)', with the copy and token actions on the page, the AI Assistant named only when `com.intellij.ml.llm` is enabled,
and the offer queued ([ST4](#st4)). ([M10](#m10), [M11](#m11), [LI18](#li18))

<a id="st22"></a>**ST22. JetBrains users paste a token-bearing MCP configuration into each agent, while VS Code
registers Piwi's two MCP servers itself and Rider bundles an MCP server plugin Piwi does not use.** Tools → Piwi holds
three copy actions and a token reset (`plugin.xml:174-188`), on the ground that no public API registers an MCP server
for the AI Assistant (`PiwiActions.kt:487-488`; [editor-extensions-audit.md](../adr/editor-extensions-audit.md) §6.2).
VS Code 1.101+ lists `piwi.mcp` and `piwi.runs` itself (`apps/vscode/src/extension.ts:1701-1724`). Rider 2026.2.4.1
bundles `com.intellij.mcpServer`, whose dynamic `mcpToolset` extension point takes an interface marked neither internal
nor experimental in the 262 jar. [developer-loop-audit.md](developer-loop-audit.md) P10 covers only the copied
configuration's shape. **(seen)** Fix: [LI18](#li18)'s optional `mcpToolset` module; the copy actions stay, in an Agents
submenu, for older IDEs and outside agents. ([M23](#m23), [LI18](#li18))

## 7. The Piwi home, the status bar and notifications

What works: both editors draw the same `piwi/status` and `piwi/failures` answers, and the JetBrains status item has the
icon, failing color and popup of [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7. **(read)** Around
that data the clients differ. The direction: one Piwi menu ([LI4](#li4)), one home per editor ([LI5](#li5)), the status
and the views computed by the editor service ([LI6](#li6)), one notification policy by kind ([LI14](#li14)).

### 7.1 The status item

<a id="hm2"></a>**HM2. VS Code paints the status item red all day for any failing test, CI failures the developer did
not cause included, where JetBrains colors only the text.** `apps/vscode/src/glue.ts:429-431` and
`apps/vscode/src/extension.ts:784` set `errorBackground` for any failing test: on the editor fixture, two CI failures on
main make a red block of 43 characters, 'Piwi: 2 failing · 1 fixed locally · 1 flaky'. JetBrains, by the same rule,
draws red text beside `TestError` (`Glue.kt:452-455`, `PiwiStatusBar.kt:144, 159, 293-298`). VS Code's guidelines keep
that background for a last resort. **(seen)** Fix: a severity in the status view, alert only for failures new against
the baseline that a run started here or local edits produced, until the next run; the error background or foreground for
alert alone; 'Piwi: 2 failing' as the text; a setting, `piwi.statusBarAlert` (`new`, `any`, `never`) and its JetBrains
twin. What counts as new is open (§13). ([M13](#m13), [LI6](#li6))

<a id="hm4"></a>**HM4. One status state wears different glyphs in the two editors, and both print a run's raw status.**
Recording, live sharing and Connect are the Piwi mark, an eye and a person in JetBrains
(`PiwiStatusBar.kt:136, 139, 156`), `$(record)`, `$(broadcast)` and `$(plug)` in VS Code
(`apps/vscode/src/glue.ts:337, 1244`, `apps/vscode/src/run-control.ts:1061`); both print 'Piwi: timedout'
(`glue.ts:433`, `Glue.kt:456`) where the dashboard says 'timed out' (`apps/application/app/utils/index.ts:349-354`).
**(read)** Fix: one glyph per state from the concept table, the Piwi mark for the neutral state only, the status in the
dashboard's words, from the service. ([M13](#m13), [LI6](#li6))

### 7.2 The homes

<a id="hm6"></a>**HM6. The Piwi tool window's Re-run failing stays enabled once every listed test is fixed locally.** It
is enabled while any failure is listed, fixed ones included (`PiwiActions.kt:343-347`, [NF9](#nf9)): with the last
failure fixed, the button looks ready and answers 'No failing test to re-run.' (`PiwiCommands.kt:127`). **(read)** Fix:
Re-run failing enabled only while a test fails. ([Q30](#q30), [LI5](#li5))

<a id="hm8"></a>**HM8. The Piwi tool window's header calls an instance that does not answer 'Not connected', above an
empty text that says it does not answer.** `Glue.connectionSummary` starts every unconnected state with 'Not connected.'
(`Glue.kt:989-997`), drawn above the service's sentence that ends 'Piwi tries again on its own.', with Retry
(`PiwiFailuresToolWindow.kt:180-191`, `packages/editor/src/failure-tree.ts:414-419`): with the VPN off, the header reads
as a lost connection. A desktop app that fails the proof gets Retry alone in JetBrains (`Glue.kt:1122`) and Refresh with
Open the log in VS Code (`apps/vscode/package.json:94-98`), and no check on the editor fixture covers any state.
**(read)** Fix: the header in the service's state and words; the same links per state in both clients; each state
checked on the editor fixture in both. ([Q27](#q27), [LI5](#li5))

### 7.4 Notifications

<a id="hm15"></a>**HM15. No message of VS Code's can be turned off, and JetBrains' run balloon leads to no setting.** None
of the extension's `show*Message` calls offers Don't Show Again, a `piwi/notice` carries no key one could be kept by
(`Notice` in `packages/editor/src/protocol.ts`), JetBrains' run balloon carries no gear (`PiwiCommands.kt`), and no test
checks the group each JetBrains balloon goes to, where some go astray ([NF5](#nf5)). **(read)** Fix: a key on each
notice and Don't Show Again on VS Code's repeated messages, a gear on the run balloon, and a platform test of every
balloon's group. ([Q13](#q13), [LI14](#li14))

<a id="hm16"></a>**HM16. The end-of-run verdict comes only for runs Piwi started, and each client words it on its own.**
`piwi/runEnded` goes to `context.ownRuns` alone (`packages/editor/src/run-watch.ts:740`), and a terminal run records the
origin `local` with no editor ref (`packages/reporter/src/internal/collect/metadata-collector.ts:135-147`): a terminal
run stopped at the editor's breakpoints, the IDE's gutter Run and a CI run of the branch all end with no verdict. The
verdict is built twice (`apps/vscode/src/glue.ts:766-806`, `Glue.kt:884-925`), which both editor guides rule out.
**(read)** Fix: `RunEnded` for every run the editor followed, with its origin, terminal and IDE-runner runs matched by
the run ref the reporter records from the live-run study's P5, once its P7 gives every local run a hub; a scope, mine or
mine and CI, on `piwi.runNotifications` and its JetBrains twin; the text and action ids from the service ('CI run #130
on feature-x · 2 new failures'). ([M21](#m21), [LI14](#li14))

<a id="hm17"></a>**HM17. A test held at a failure or at `page.pause()` in a background IDE gives no sign, where the
desktop app tells the system.** Neither `apps/jetbrains` nor `apps/vscode` calls `requestAttention` or reads
`window.state`; the desktop app signals a failure or a `page.pause()` from the background, never a step that was asked
for (`apps/docs/features/desktop-runs.md:41-42`). A headless test held at a failure waits unseen behind the browser.
**(read)** The rule is the live-run study's attention, built in its P6: interrupt once where the run was launched, a
badge elsewhere until answered. Fix: on a held failure or a `page.pause()`, never on Step, Pause or Run to, JetBrains
calls `AppIcon.requestAttention` (raising the IDE when 'Focus application on breakpoint' is on), VS Code notifies with
Resume and Go to the stopped line while unfocused, and the status item carries the badge. ([M21](#m21), [LI14](#li14))

<a id="hm19"></a>**HM19. JetBrains shows a stopped editor service as one not yet started.** `stopped()` clears the
status (`PiwiProjectService.kt:417-430`), so JetBrains' item reads 'Piwi' with 'Piwi starts when you open a file of this
project.' and its popup leads with Settings… (`Glue.kt:390, 462`): with files open, the developer is told Piwi will
start and looks for the cause in the settings. VS Code's item says 'Piwi: not running' with Restart the editor service
and Open the log (`apps/vscode/src/glue.ts:261-273`), which its integration suite holds by stopping the service and
starting it again. **(read)** Fix: JetBrains' item in VS Code's 'not running' state, Restart first ([NF5](#nf5)).
([Q27](#q27))

## 8. Live runs in the editors: where they sit

The split with the live-run study ([live-runs.md](../adr/live-runs.md)) is the Status paragraph's. A finding that
overlaps the study says where the result lands in each editor, and names the study's finding and phase where that phase
is not built; its fix adds only what the study does not. At `b0ff6772` the study has built P0 to P6 and P8 to P10, each
but for leftovers its Status names, and part of P7 and P11, its P4 without E2, E3 and E13 in the editors.

### 8.1 The glance

<a id="lr1"></a>**LR1. VS Code shows a run as up to nine status items beside the Piwi item, and a click on the Piwi item
refreshes rather than opening a menu.** `controlItems` (`apps/vscode/src/run-control.ts:1347-1444`), `liveItem`
(`:1053-1091`) and `progressItem` (`:988-1046`) add an item per control, the `Pausing…` item, End the test, Stop, Share
live and the count, placed by `ITEM_ORDER` (`apps/vscode/src/run-view.ts:204-216`): at a stop, Resume, Step, Finish, End
the test, Write code, Stop, Live and `#78 · 3 of 9`, most of them icon-only. The Piwi item's click refreshes, retries,
connects or restarts (`apps/vscode/src/extension.ts:777-783`). **(read)** Fix: one item named `Piwi`, its line
[LR2](#lr2)'s, its click opening the status menu (Go to the stopped line, the controls, Watch a worker's test, Share
live). ([M13](#m13))

<a id="lr2"></a>**LR2. Each client composes the run's status line itself, and neither line holds the whole run.**
JetBrains writes the stop or the share, then `run #78 · 3 of 9 · 1 failed` from the run's own process, no flaky count
(`PiwiStatusBar.kt:127-131`, `Glue.runProgressText` at `Glue.kt:2126-2136`). VS Code's count item writes the same count
with the flaky count in its tooltip alone (`apps/vscode/src/run-control.ts:1034-1045`), its stop and its share sit in
items of their own ([LR1](#lr1)), and its Piwi item counts the instance's `4/9` (`apps/vscode/src/glue.ts:161-165`).
**(read)** Fix: one line composed by the editor service for both clients from `RunSession.progress`, flaky included,
with the stop and the share (`Run #78 · 3 of 9 · 1 failed · paused at checkout.page.ts:12 · live 2 · Open`).
([M13](#m13))

<a id="lr18"></a>**LR18. The run's count and its pausing state are worded three ways, and VS Code shows two counts of
one run side by side.** VS Code's count item reads `$(beaker) #78 · 3 of 9 · $(error) 1`
(`apps/vscode/src/run-control.ts:1036`) beside the instance's `$(sync~spin) Piwi: run #78 · 4/9 · 1 failing · yours`
(`apps/vscode/src/glue.ts:161-165`); JetBrains reads `Piwi: run #78 · 3 of 9 · 1 failed` (`Glue.kt:2126-2136`), without
the flaky count VS Code's tooltip gives. `$(beaker)` is also VS Code's idle Piwi mark and its run node
(`glue.ts:293, 512`), and the spinner of VS Code's `Pausing…` item is JetBrains' sign of a running run, which shows a
pausing run with `Actions.Pause`, a stop's icon (`PiwiStatusBar.kt:138-140`). VS Code says `Pausing… 12 s` and names
the call in the tooltip alone (`run-control.ts:1358-1362`), JetBrains `Piwi: pausing… · waits in <call>` with no time
(`Glue.kt:2489`), and neither marks the waiting call in the code, though `RunWaiting` carries its place
(`packages/editor/src/protocol.ts:1850-1856`). A click on the count opens Watch a Worker's Test, else the run's page, in
VS Code (`run-control.ts:1044`) and the status popup in JetBrains. **(read)** Fix: [LR2](#lr2)'s one line from the
service, its pausing part with the call and the time; the waiting line marked in the code with End test; one glyph per
state from the outcome palette; the click opening the status menu in both. ([M13](#m13), [M22](#m22))

### 8.2 Steering in the debugger's places

<a id="lr3"></a>**LR3. A stop's controls are missing from VS Code's context menu and from JetBrains' editor menu, Run
menu and Run tab, and VS Code's editor title shows Resume alone.** VS Code's editor title has Resume as its one button
and Pause, Step, Run to the Cursor, Finish, End the test, the paused page, the code and Stop in its overflow menu
(`apps/vscode/package.json:809-875`); the context menu's Piwi submenu has no run group (`:1034-1080`). JetBrains lists
the stop actions in Tools → Piwi, the status popup and the stop's own popups (`plugin.xml:214-290`,
`PiwiStatusBar.kt:264-268`), none in its editor menu's Piwi submenu (`plugin.xml:300-312`) or the Run menu, and a
console run's tab (`RunContentExecutor`, `PiwiCommands.kt:380-388`) has Rerun, Stop and Close only; the Status paragraph
of [run-control.md](../adr/run-control.md) (lines 76-80) records why the toolbar of its §3.2 was not built. **(read)**
Fix: in VS Code Step, Finish and Stop beside Resume in the editor title while a run is live, in the debug toolbar's
order, and a first `editor/context` group while stopped; in JetBrains a registered `Piwi.RunControl` group in
`EditorPopupMenu`, `RunMenu` and the toolbar of a `RunContentDescriptor` the plugin builds. ([M14](#m14), [L3](#l3))

<a id="lr4"></a>**LR4. VS Code has no way back to a stopped line once the developer scrolls away or opens another
file.** VS Code reveals a stop as it opens (`apps/vscode/src/run-view.ts:471-488`) and has no command to return, where
the debugger has Show Execution Point and JetBrains has `Piwi.ShowStop`. **(read)** Fix: `piwi.showStop` in VS Code,
first in the run section of the status menu, asking which by Worker N when several are stopped. ([M14](#m14))

### 8.3 The stop line

<a id="lr6"></a>**LR6. JetBrains' stop line holds up to eleven entries, in the editor's font with no icon, and VS Code's
stop row shares its line with the line's own lens.** JetBrains' `StopInlay` draws the paused text, Resume, Step, Run to
Caret, Finish, End Test and each code action (`PiwiRunControl.kt:2896-2954`, `Glue.kt:2561-2590`) in
`EditorFontType.PLAIN` and with no icon. VS Code's row holds the paused text, Resume, Step, Finish and Write code…
(`apps/vscode/src/run-view.ts:1310-1334`, `run-control.ts:1133-1142`), and the line's own lenses join it
(`apps/vscode/src/extension.ts:1546-1563`). No check measures either row against its box. **(read)** Fix: JetBrains
takes VS Code's paused text and four controls, Code Vision's font and the gutter's icon, Run to Caret, End Test and the
code actions moving to the hover and the context menu ([LR3](#lr3)); the line's own lens hides while a stop shows; a
nightly check fails on a row wider than its box. ([M14](#m14), [L6](#l6))

### 8.4 The list

<a id="lr7"></a>**LR7. The developer's own live run has no home in either editor, and nothing lists its workers, tests
or stops in a view.** The run's 22 entries sit in Tools → Piwi while they apply (`plugin.xml:214-290`), and 20 of them
again in the status popup while a run is live (`PiwiStatusBar.kt:187-192, 264-268`); VS Code shows the run as status
items ([LR1](#lr1)). `RunSession` carries each worker's test and state
(`packages/editor/src/protocol.ts:1798-1842, 1865-1915`), which Piwi Picker's Runs window and the desktop tray list;
the editors list the workers only as lines of the status tooltips (`Glue.workersNowText` at `Glue.kt:2160`,
`workersNow` at `apps/vscode/src/run-control.ts:956`) and in Watch a Worker's Test's chooser
(`Worker 2 · running <test>`). **(read)** Fix: a Runs tab in the Piwi tool window and a Runs view in VS Code (a new
id: `piwi.runs` names the MCP provider), shown while a run is live, with the Runs window's rows (the run, then Worker N
with its test, its state, Watch and Pause and Watch, a stop with its place and controls), and run control as a Tools →
Piwi submenu; until then Watch and Pause and Watch sit in the status menu's run section. Whether VS Code's view sits
beside Failures or in the Run and Debug container is open (§13); workers as a debug session's threads are
[LI10](#li10)'s alternative. ([L1](#l1))

### 8.5 The page

<a id="lr8"></a>**LR8. A stopped test's controls are on neither the paused page nor the worker view, which open apart,
and VS Code's tabs have no icon.** VS Code's paused page (`apps/vscode/src/run-view.ts:636-641`) and worker panel
(`apps/vscode/src/worker-panel.ts:517-522`) are two panels, neither with an `iconPath`, and `pausedPageHtml` draws
both: a caption, the Watch toggles, the trace button and the image, with no Resume, Step, Finish or code action
(`apps/vscode/src/run-control.ts:1967-2010`). JetBrains' Paused Page and Worker tabs are two tabs as well
(`PiwiRunControl.kt:818-819, 1137-1138`), with no controls either; its Worker tab watches only ([NF6](#nf6)). Side by
side, the toggles say Watch live and Watch for one thing (`run-control.ts:1987-1988`,
`PiwiRunControl.kt:2141, 2230`). **(read)** This is live-runs E13, of the study's P4. Fix: one page per worker in both
editors, the paused page joining the worker view, with Resume, Step, Finish and the code actions (an `ActionToolbar` of
`Piwi.RunControl` in JetBrains), Watch and Interact as toggles with icons under one input rule in both clients, VS
Code's tab icons, and an accessible name on every control. ([M15](#m15))

### 8.6 What the study's model brings

<a id="lr9"></a>**LR9. The Testing view and the test lines take the developer's own run from the instance, so a run
that reports to none shows no test running, and no line shows where a running test is.** The service sets a test's
live state from the instance's run stream (`packages/editor/src/run-watch.ts:622-668`), which the test lines
(`packages/editor/src/server.ts:3060-3061`) and the Testing view (`apps/vscode/src/test-explorer.ts:383-410`) read; the
workers' own reports reach the Testing view only as output lines, once a test run follows the instance's run
(`test-explorer.ts:418-432`). No line marks the call a running test of the developer's own is at, where a CI run's
positions are marked (`apps/vscode/src/ci-view.ts:90-106`). **(read)** This is live-runs E3 (E2 for the running line),
of the study's P4. Fix: the Testing view and the test's line from the run's own events, a spinner while it runs and the
pause or failed glyph while it waits, and the running line marked. ([L1](#l1))

<a id="lr10"></a>**LR10. The test lines show a CI or teammate run's tests as running, and a teammate's run of the branch
reads as a plain run.** The editor service follows any run of the branch (`packages/editor/src/run-watch.ts:564-578`),
and a test line takes its live state from it (`packages/editor/src/server.ts:3060-3061`): VS Code's gutter and
JetBrains' result icon (`PiwiTestAnnotator.kt:104`) draw a CI run's tests as running, and the line says `running in run
#130` (`server.ts:666-669`). `LiveRun` tells only the developer's own run and a CI run
(`packages/editor/src/protocol.ts:774-794`), so a teammate's run reads `Piwi: run #131 · 4/9` in both status bars
(`apps/vscode/src/glue.ts:161-165`, `Glue.kt:305-309`). **(read)** Fix: a test line's live state from the developer's
own runs alone ([NF4](#nf4)); the run's origin in the status line and the tooltips (`CI run #130 on feature-x`), the
short form for the developer's own run; and CI runs as read-only rows of the Runs view and tab. ([Q28](#q28), [L1](#l1))

<a id="lr12"></a>**LR12. Stuck? never reaches the editors: a test held for minutes reads as plain "running".** The
instance publishes `test-stuck` (`apps/application/server/utils/stuck-tests.ts:71`), leaving a test's stopped time out
(`:30`); the editor service reads only test-begin, test-completed and the run's state
(`packages/editor/src/run-watch.ts:622-643`). **(read)** Fix: `Stuck? running 4 min, usually 40 s` with Open the run
page in the gutter tooltip and the Testing view, and `· 1 stuck?` on the status line, never for a stopped worker.
([L1](#l1))

<a id="lr13"></a>**LR13. Between the click and the run's first report, Piwi's own surfaces show nothing and offer no
Stop.** The run's own process opens its session at `run-begin` (`packages/editor/src/run-sessions.ts:786-823`), so
Stop and `0 of 9` show from Playwright's `onBegin`. A web server's start and a global setup run before it, often 10 to
60 s, while VS Code's controls wait for a session (`apps/vscode/src/run-control.ts:1309, 1348`), as JetBrains' Stop the
Run does (`Glue.kt:2453`), and only the terminal or the Run tab shows the run. **(seen)** at v0.66.0. Fix: a starting
session from the command (`Piwi: starting checkout › pays…`, the study's lane state `starting`) with Stop enabled.
([M14](#m14))

<a id="lr14"></a>**LR14. A run shared live has three glyphs across the tools, VS Code's Follow takes Watch's eye, and a
share's link is copied from its notification alone.** VS Code and JetBrains draw a broadcast (`$(broadcast)`,
`live.svg`, on JetBrains' status item too), the dashboard `radio`
(`apps/application/app/components/desktop/DesktopRunShare.vue:98`) and the Runs window `share`. In VS Code `$(eye)`
marks both Watch a worker's test (`apps/vscode/package.json:496-501`) and Stop following the active editor
(`package.json:359-364`). Copy the run page's link sits in the share's notification only, beside Open and Stop sharing
(`apps/vscode/src/run-view.ts:1045-1051`, `PiwiRunControl.kt:1589-1595`). **(read)** Fix: one Share live glyph in every
tool, Follow off `$(eye)`, and Copy, Open and Stop sharing wherever the run is listed. ([M4](#m4))

### 8.7 Words deferred to the study

<a id="lr16"></a>**LR16. One run has a different name in each place: the VS Code task, JetBrains' Run tab, the worker
views and the Stop and Share live choosers.** The task is its command line (`runTaskName`,
`apps/vscode/src/glue.ts:1332-1335`), the Run tab what it runs (`Glue.runTabName`, `Glue.kt:1503-1514`), the Stop
choosers the run's tests (`apps/vscode/src/run-view.ts:1211-1229`, `PiwiRunControl.kt:3076-3092`) and the Share live
choosers its folder (`run-view.ts:1013-1022`, `PiwiRunControl.kt:1552-1566`), where the status bars and the Hold
failures choosers say **Run #78** (`runLabel`, `apps/vscode/src/run-control.ts:677-681`, `Glue.kt:2366-2370`). The
worker views and Watch's choosers name a worker but not its run, and `RunCommand` carries no run name, only an agent's
label (`packages/editor/src/protocol.ts:366-396`). **(read)** Fix: the service sends the run's name with `RunCommand`,
and both clients use it wherever a run is named. ([M14](#m14))

## 9. Rider

Rider runs the same plugin as WebStorm, with other keymaps, another project model and a .NET backend beside the specs.
What differs is RD3, RD4, RD7 and RD8 below and three findings filed elsewhere:

| What differs in Rider | Where |
|---|---|
| Piwi's chords collide in the Visual Studio, VS 2022, ReSharper and Visual Assist keymaps | [AC12](#ac12), §4.5 |
| Nothing from Piwi in the Solution Explorer or the Tests menu | [AC3](#ac3), §4.1 |
| The settings page names `.idea` paths Rider does not use | [ST13](#st13), §6.2 |

<a id="rd3"></a>**RD3. Specs beside a Rider solution, a layout the plugin's config search supports, may get no
highlighting in Rider, and nothing offers to attach their folder.** `Glue.findPlaywright` searches the Git repository
when the solution's folders hold no config (`Glue.kt:218-231`), but Rider 2026.2.4.1's
`RiderHighlightingSettingProvider` returns `SKIP_HIGHLIGHTING` for a file neither indexed nor in the project model. No
Rider run has opened such a spec, and the plugin never names Rider's `AttachFolderAction`, so a spec opened from beside
the solution may show none of Piwi's marks, lenses or diagnostics, with no word on why. `examples/sample-app` has this
layout. **(read)** Fix: a balloon in Rider when a config folder lies outside the solution, whose action runs
`AttachFolderAction` by id, and the Rider scene opening such a spec. ([M17](#m17))

<a id="rd4"></a>**RD4. No check ever launches Rider, yet the coverage docs say C# files show Piwi's marks and lenses
there.** `apps/docs/features/editor-coverage.md:3, 11-14, 126-127` promise marks, lenses and the hover on `.cs`,
`.cshtml` and `.razor` files in "the JetBrains IDEs, Rider included"; Rider gets only the Plugin Verifier, when
`all-ides` is set (`.github/workflows/reusable-jetbrains.yml:70`), and `apps/jetbrains/scripts/take-screenshots.mjs:78`
finds WebStorm only. Code Vision and the diagnostics run in the frontend, where JetBrains' docs say C# elements are not
visible; only a run settles it. **(read)** Fix: `editor-coverage.md` claims for Rider only what a check has seen, until
a Rider scene on `examples/sample-app/backends/aspnetcore` checks [RD3](#rd3), a controller's marks, lens and
diagnostics, [AC3](#ac3) and [AC12](#ac12). ([M17](#m17))

<a id="rd7"></a>**RD7. A C# controller, like any application file, gets one "Reached by N tests" line above its usings
and nothing per action or endpoint.** `packages/editor/src/server.ts:3230-3239` puts the line at `line: 0`, and the
route manifest keeps only each handler's file
(`integrations/aspnetcore/PiwiTests.Instrumentation.AspNetCore/PiwiRouteManifest.cs:26`). **(read)** Fix: an optional
`line` per manifest route, read in the same PDB pass, and a lens per action
(`GET /api/orders/{id} · 4 tests · 1 failing`) in both editors. ([L4](#l4))

<a id="rd8"></a>**RD8. The dashboard prints .NET stack frames and route handlers as plain text, with no Open in IDE link
to Rider.** Server-log stacks are a `<pre>`
(`apps/application/app/components/test-case/TestCaseNetworkRequests.vue:568-571`). **(read)** Fix: `OpenInIdeLink` on
`in <path>:line N` frames and on Test Map handler nodes, at the handler's line once [RD7](#rd7) adds it. ([L4](#l4))

The Rider checks still open are §13's question on Rider's C# surfaces; each needs a Rider scene ([M17](#m17)), not new
tooling.

## 10. The larger items

Twenty items carry the principles of §2, each built over one or more steps of [§12](#12-the-plan). They are FSL work
(`packages/editor`, the clients, the dashboard, the desktop app) but for two pieces written anew on the MIT side: the
pause bar's glyphs in `packages/picker-dom` ([LI2](#li2)) and the .NET pieces in `integrations/` ([LI17](#li17)); no
code moves from FSL into MIT.

**Vocabulary (principles 1 and 7).**

<a id="li1"></a>

### LI1. One action catalog and one words table for both editors

`packages/editor/src/actions.ts` lists each action once: its ids, one wording in sentence case for both editors, a short
label, its concept ([LI2](#li2)), menus ([LI4](#li4)), when it applies, keys ([LI15](#li15)), synonyms and a docs
anchor; `src/words.ts` holds the words a client writes itself. The words of watching are the live-run study's
([live-runs.md](../adr/live-runs.md) D6: words in the FSL surfaces, enums in `@piwitests/core/live-lane`), and the
catalog keeps the editors' copy under the study's drift test. A vitest test holds both manifests to it first; later it
generates `package.nls.json`, a `PiwiBundle.properties` and `editors.md`'s commands table. **Lives in**
`packages/editor` (FSL); the pause bar (MIT) is read by the test, never fed. **Replaces** titles kept twice by hand and
four hand-built popups. **Depends on** nothing. **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) §3.6, whose sentence case both editors now take, and
makes [developer-loop-audit.md](developer-loop-audit.md) §9 a tested artifact. Built: the catalog's ids and one title per
action, held against both manifests (`packages/editor/src/actions.ts`). Its short labels and the words table are step
[M22](#m22); its concept, menus and keys come with [M4](#m4), [M3](#m3) and [M16](#m16).

<a id="li15"></a>

### LI15. Keys from one table, checked against every bundled keymap

Chords and run-control keys sit in the catalog per keymap family and generate VS Code's keybindings, `plugin.xml`'s
per-keymap entries and both docs tables; a unit test resolves the keymaps bundled with WebStorm, IDEA Ultimate and
Rider, and VS Code's defaults, and fails on a collision. The table records the rule both clients follow: Resume, Step,
Run to Cursor and Finish give way to a suspended debugger, Pause to a running one and Stop to any session, Pause on the
platform Pause action's key. **Lives in** `packages/editor` and both clients (FSL). **Replaces** chords Rider's Visual
Studio-family and ReSharper keymaps already bind, keys set per client with no collision check. **Depends on**
[LI1](#li1). **Revisits** no decision. Step [M16](#m16).

**Look (principles 2 and 3).**

<a id="li2"></a>

### LI2. One concept table and a Piwi icon set built with the brand assets

A concept table gives each concept its glyph in every tool's set (Appendix A).
`apps/application/scripts/generate-brand-assets.mjs`, which already writes both editors' Piwi mark, also writes what the
platforms lack, drawn once from Piwi Picker's outline set (`apps/extension/src/shared/icons.ts`): record, plug,
flaky, region, mock, broadcast and the rest Appendix A marks (new), with `_dark` and `expui/` variants, and their VS Code
glyphs in the icon font beside `$(piwi-mark)`. A test reads every manifest and icon map and fails on a missing or different glyph. **Lives in**
`packages/editor` or `apps/application/shared` (§13), FSL; the pause bar's glyphs are drawn anew in picker-dom (MIT).
**Replaces** the film strip for record, the person for Connect, four glyphs with two meanings. **Depends on** nothing.
**Revisits** [editor-local-runs.md](../adr/editor-local-runs.md) 6b and 6c (each editor chose its tree icons) and the
status item's icons, which [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 asked for without naming
any. Steps [M4](#m4).

<a id="li3"></a>

### LI3. One outcome palette and mark kit, held to STATUS_COLORS

`STATUS_COLORS` (`apps/application/shared/status-colors.ts`) and the dashboard's `getStatusIcon` shapes become every
tool's outcome marks, plus the states only the editors draw: unknown, paused, held failure, recording. Each tool
restates them, VS Code's `media/test-*.svg`, the JetBrains plugin's flaky and running marks and Piwi Picker's dots so
far, the desktop tray's dot, Piwi Picker's waiting count, both editors' failing and recording tints and the held
failure's arrow, and `status-mark-colors.test.ts` holds every copy. A script writing the copies was dropped: a test holds them as well, with
less machinery. **Lives in** `apps/application` and each tool's assets (FSL); the status palette never moves into core,
where `COVERAGE_MARK_COLORS` stays with its changed and uncovered-change colors. **Replaces** the tray's own palette, an
amber paused that means did not run elsewhere. **Depends on** nothing. **Revisits**
[desktop-run-progress.md](desktop-run-progress.md), whose tray dot took colors of its own. Step
[M5](#m5).

**Places (principles 4 and 5).**

<a id="li4"></a>

### LI4. One Piwi menu, the same shape in every place

Six sections in a fixed order: Run, Record, Run Control (only while a Piwi run is live), Dashboard, Agents, Connection,
each showing only what applies. The same shape fills Tools → Piwi as nested compact groups, a Piwi submenu in both
editors' context menus and file trees, the status popup, a new VS Code status menu (a quick pick with the state's action
preselected, so Enter still refreshes) and the tool window's gear; the click opens it (§13, question 6). **Lives
in** the catalog's menu fields and both manifests (FSL); ids stay. **Replaces** 51 flat rows, nothing in either file
tree, a VS Code status click that only refreshes. **Depends on** [LI1](#li1). **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 (a status popup in JetBrains only) and §3.6, which
called VS Code's status bar the control center. Steps [M3](#m3).

<a id="li5"></a>

### LI5. One Piwi home per editor

Both homes list the same places in one order: Failures, Runs ([LI9](#li9)), the page, the log, and in JetBrains Get
Started ([LI12](#li12)). The Piwi tool window makes each a tab (Log is new), and its Paused Page and v0.68.0's Worker N
tabs become one worker tab ([LI9](#li9)); VS Code's Piwi panel holds Failures and Runs, its overflow menu opening the
page (an editor tab) and the log. The gear holds Documentation in both ([HM6](#hm6)), JetBrains' Open in dashboard
acting on the selection; the service sends the view's state and words, node icon keys and tooltips, and a 'Flaky in this
run' group. **Lives in** `failure-tree.ts`, `protocol.ts` and both clients (FSL). **Replaces** the Paused Page and
Worker N tabs side by side, a log with no place in the home, a gear without Documentation. **Depends on** [LI1](#li1),
[LI6](#li6). **Revisits** no decision: [editor-local-runs.md](../adr/editor-local-runs.md) Part 6 built the two trees
apart. Step [Q27](#q27).

<a id="li7"></a>

### LI7. One test line: one action list, Debug with Piwi, and a test card

The service sends each test line one grouped action list (`piwi/testActions`): Run with Piwi, Debug with Piwi and Verify
×3; Trace, Screenshot and Open in dashboard; Copy context for agent; Record here; the desktop jobs. JetBrains draws it
on the result icon's either click and on the IDE run icon (`JSTestRunLineMarkersAdditionalActionGroup`); VS Code in its
Testing menus and the hover. The gutter acts, the hover explains, the lens informs, quick fixes only edit. Debug with
Piwi builds the dashboard's Debug in my editor run (`RunTestsArgs.debug`) for a failure; a later `piwi/testCard` adds
history, flaky rate, owner and quarantine. **Lives in** `packages/editor` and both clients (FSL). **Replaces** anonymous
gutter actions, a click that opens a browser, five names for run. **Depends on** [LI1](#li1). **Revisits**
[developer-loop-audit.md](developer-loop-audit.md) P1 (Run and Verify ×3 on the result icon built, the run line marker
left) and the line's command, `piwi.openInDashboard` (`packages/editor/src/server.ts:3143-3147`). Steps [M7](#m7) to
[M9](#m9), [L5](#l5).

<a id="li8"></a>

### LI8. Each IDE's own test UI as Piwi's home

VS Code: Run, Debug and Coverage profiles, the instance's coverage as `FileCoverage` (`loadDetailedCoverage`), and
durations, descriptions and TestTags from `SpecTest`. JetBrains: an SMTRunner console fed by the run channel in
[LI9](#li9)'s Run tab, so every Piwi run gets the IDE's test tree; the result icon a switchable Gutter Icons entry;
Piwi's coverage bar hidden while the IDE shows its own. Piwi's own marks stay for flaky, quarantine, history and
[live-view-next.md](live-view-next.md) Part 6's CI position. **Lives in** both clients and the service (FSL).
**Replaces** coverage VS Code's coverage view never sees, a Debug Test that reaches nothing, two disagreeing state icons
on one JetBrains line. **Depends on** [LI7](#li7), [LI3](#li3). **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) L1 (a results-only Testing view, built) and §6.4 (offer
the IDE's Playwright runner, not built). Steps [M8](#m8), [M9](#m9), [L2](#l2).

<a id="li9"></a>

### LI9. Where the editors host a live run

Glance: one status item and one menu per editor, the menu's run section the Run Control group; the line's run part (`Run
#78 · 3 of 9 · Open`, progress kept at a stop) is the study's P5; the count is built ([LR18](#lr18)). Steering, with no
debug session: VS Code's `editor/title` strip in the debug toolbar's order and a Run Control group in `editor/context`;
JetBrains' `RunMenu`, `EditorPopupMenu` and a Run tab per console run, named after its target with Pause and Step (the
study's P6), as a `RunContentDescriptor` Piwi builds. In the code: a stop line of the paused text and four controls, Go
to the stopped line, a starting state with Stop; the red execution point at a held failure is built. List: a Runs view
and tab, filled by P4 (progress), P5 (Run #N, origin), P6 (each worker's test, Hold failures), P9 (Share live) and P10
(CI runs, read-only). Page: one page per worker with its controls, the paused page joining the worker views P4 built
beside it ([LR8](#lr8)). **Lives in** both clients and `packages/editor` (FSL). **Replaces** up to nine icon-only status
items, a clipped stop line, run controls missing from the debugger's places. **Depends on** [LI1](#li1), [LI6](#li6),
the study's phases. **Revisits** [run-control.md](../adr/run-control.md) §3.2 and its Status, which gave up the Run
tab's toolbar because `RunContentExecutor` fixes it: Piwi builds the descriptor itself. Steps [M13](#m13) to
[M15](#m15), [L1](#l1).

<a id="li10"></a>

### LI10. Decide on a debug session before 1.0 freezes the run keys

A spike, then one decision for both IDEs. Option A, the default, is [LI9](#li9) with [LI15](#li15)'s keys. Option B is
an inline `DebugAdapter` and an `XDebugProcess`: workers as threads, stops as frames, Variables holding the call,
locator and URL, the Debug Console evaluating a locator (`piwi/locatorAtCaret`), the native toolbar and keys in place of
the `!inDebugMode` and `ActionPromoter` workarounds. B's costs: two sessions under one set of keys for a Rider user
debugging the backend; a session belongs to one window, where the study gives a run one hub (its D9) and lets any window
steer; a place beside the IDE's JavaScript debugger. **Lives in** a branch of both clients (FSL). **Replaces** nothing
until decided; it says whether LI9's places are interim, before the run-control ids are registered in D25 and freeze at
1.0. **Depends on** nothing. **Revisits** [run-control.md](../adr/run-control.md) §3.2: "no debug session exists". Step
[L3](#l3).

**The service (principle 6).**

<a id="li6"></a>

### LI6. The editor service computes what both editors show

View models on the service's answers: the status (state, text parts, glyph key, severity, ordered actions), the
connection (the source in use, instance, project, branch, key, the problem and its fix), a test line's summary in the
dashboard's words (`formatStatusLabel`), and the verdict; clients keep one icon-key map. A cheaper first step runs one
JSON of inputs and outputs through `glue.ts` and `Glue.kt`. Alert only for failures new against the baseline that a run
started here, or local edits, produced (§13). **Lives in** `packages/editor` (FSL). **Replaces** `statusBarView` and
`Glue.statusView`, `testResultHover` and `testResultTooltip`, `connectionSummary`, two verdict builders. **Depends on**
nothing. **Revisits** no decision: it applies `apps/vscode/AGENTS.md`'s rule that a client holds no logic the other
needs, which the status popup of [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 put in the client.
Steps [Q27](#q27), [M13](#m13), [M21](#m21), [M22](#m22).

**Settings and first steps (principles 7 and 8).**

<a id="li11"></a>

### LI11. One settings registry for both editors

`packages/editor/src/settings.ts` gives each option its key, type, default, scope (team, user, machine), group and
order, labels, description, synonyms and docs anchor, as `apps/application/shared/piwi-env-vars.ts` drives the
configuration reference. It generates VS Code's ordered categories, the JetBrains rows or a check of them, a docs table
and the walkthrough's settings step. New switches go through it: `piwi.codeLens`, `gutterIcons`, `coverageMarks`,
`locatorWarnings`, `failingTestTint`, `statusBarAlert` ([HM2](#hm2)), read by the service to filter once for both
clients. **Lives in** `packages/editor` (FSL). **Replaces** an alphabetical list of code values, scopes that differ per
editor, comments naming wrong paths in Rider. **Depends on** nothing. **Revisits** no decision; each new key joins the
list of [1.0-stabilization.md](1.0-stabilization.md) D25 in the pull request that adds it. Step [M10](#m10).

<a id="li12"></a>

### LI12. One onboarding script for every tool

The first steps, written once as Markdown with images and checks read from the service's state: connect, or record with
no instance; see the failures; run one; stop at a breakpoint and write code there; record; pair Piwi Picker; give your
agent the MCP server; the settings. VS Code plays them as its walkthrough (a `when` variant for 1.101 and later, which
lists the MCP server itself); JetBrains in a Get Started tab, from a new `Piwi.GetStarted`. First-run offers wait in one
queue. **Lives in** `packages/editor` (FSL); the dashboard's `GetStartedWizard` and Piwi Picker's welcome page
([extension-ux-audit.md](extension-ux-audit.md) item 23) can read it later. **Replaces** a balloon a `.env`-connected
workspace never sees, six text-only steps. **Depends on** [LI6](#li6). **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) M8 (a walkthrough in VS Code, a first-run notification
in JetBrains). Step [M11](#m11).

<a id="li13"></a>

### LI13. The connection first, and one Connect panel in JetBrains

The connection view model ([LI6](#li6)) comes first wherever settings are. In JetBrains, Connect becomes one panel, in
the settings page and as one dialog: the desktop app with its projects, the URL with Test connection, the key with Sign
in…, Paste key… and Remove, a project combo from the instance. The sign-in is a non-modal dialog with Copy code and Copy
link (VS Code's gains Copy link); errors come from one table, and waiting for trust and a Node.js start problem become
states with their fix. **Lives in** `PiwiConnect.kt`, `PiwiConfigurable.kt` and the service's words (FSL). **Replaces**
up to five modal dialogs, a project typed by hand on the settings page, a page that reads None while connected.
**Depends on** [LI6](#li6). **Revisits** no earlier decision. Steps [Q27](#q27), [M12](#m12).

**Messages (principle 8).**

<a id="li14"></a>

### LI14. One notification policy by kind

Each message has one kind and one surface per tool: a result, a request (Debug in my editor, a share link: sticky), an
offer (one at a time), a problem, a confirmation (in the status bar). JetBrains' groups per kind and `PiwiNotifier`
title a run's balloon with its run, and both clients' run notices gain a gear to their setting. `RunEnded` carries the
verdict's words for every run the editor followed, a terminal run's once the study's P7 gives every local run a hub.
Attention on a live run ([HM17](#hm17)) is the study's P6; in a background editor its interrupt is
`AppIcon.requestAttention` or a VS Code notification. **Lives in** both clients and `RunEnded` (FSL). **Replaces** one
'Piwi' title on every balloon, run notices that do not lead to their setting, two hand-worded verdicts. **Depends on**
[LI6](#li6). **Revisits** no decision of its own. Steps [Q13](#q13), [M21](#m21).

**Rider and .NET (principles 5 and 9).**

<a id="li16"></a>

### LI16. A Rider layer: one optional descriptor and one Rider scene

An optional `piwi-rider.xml`, on `com.intellij.modules.rider`, holds what only Rider has: a Piwi group in
`SolutionExplorerPopupMenu` after Run Unit Tests (Run Tests That Reach This File on `.cs`, `.cshtml`, `.razor`), a
submenu in the Tests menu, the attach-folder prompt for specs outside the solution (`AttachFolderAction` by id) and a
balloon for a solution that references `Microsoft.Playwright`. A Rider scene in
`apps/jetbrains/scripts/take-screenshots.mjs`, on `examples/sample-app/backends/aspnetcore`, checks each Rider-only
surface once per release. **Lives in** `apps/jetbrains` (FSL). **Replaces** a docs claim that the plugin is checked on
Rider when only the Plugin Verifier reads its jars. **Depends on** [LI4](#li4). **Revisits**
[real-editor-checks.md](real-editor-checks.md) D1 to D3 (JetBrains checks deferred for want of a license) and its Not in
this plan, which leaves Rider out of capture. Step [M17](#m17).

<a id="li17"></a>

### LI17. The .NET side: endpoint reach, cross-stack debugging, and Playwright for .NET

Each manifest route gains its handler's line, read in the PDB pass `PiwiSourceFiles` already makes, for a lens per
action that runs its tests in both editors ([RD7](#rd7)) and Open in IDE on .NET frames ([RD8](#rd8)). Later, beyond
this plan's steps, Rider's Debug in my editor could offer to attach the .NET debugger at the failing request's handler.
Last, the maintainer decides: Playwright for .NET, Java and Python a stated non-goal, or a NuGet adapter writing Piwi's
report from NUnit, MSTest and xUnit. **Lives in** `integrations/aspnetcore` for the field and any adapter (MIT, written
there), the editors and the dashboard for the rest (FSL). **Replaces** one 'Reached by N tests' line above a
controller's usings. **Depends on** [LI16](#li16). **Revisits** [ROADMAP.md](../ROADMAP.md)'s non-goals, which name
other frameworks, not Playwright in other languages. Steps [L4](#l4), [L7](#l7).

**Agents (principle 5).**

<a id="li18"></a>

### LI18. Agents through the JetBrains IDE's own MCP server

An optional `piwi-mcp.xml`, on `com.intellij.mcpServer`, contributes an `mcpToolset` that forwards to the editor
service's runs server (`piwi/agents`), so an agent attached to the IDE reaches Piwi with no token to copy, as VS Code
registers `piwi.mcp` and `piwi.runs` itself. The base plugin keeps its 2024.1 floor; `verifyPlugin` runs on 2024.1 and
the latest IDEs. The copy actions stay for older IDEs; an agent outside the IDE takes the study's P8 router, `npx
@piwitests/reporter mcp`. **Lives in** `apps/jetbrains` (FSL). **Replaces** a token-bearing configuration pasted into
each agent after every reset. **Depends on** [LI4](#li4). **Revisits** the premise that the platform has no public way
to register an MCP server (`PiwiActions.kt:487-488`). Steps [M10](#m10), [M11](#m11), [M23](#m23).

**Checks (principle 9).**

<a id="li19"></a>

### LI19. Both editors checked on the shared fixture, without a JetBrains license

Four layers: the catalog and concept-table tests ([LI1](#li1), [LI2](#li2)); golden fixtures through `glue.ts` and
`Glue.kt`; JetBrains platform tests on the 2024.1 test platform, which needs no license, drawing the editor fixture's
spec (`CodeVisionTestCase`, `findAllGutters`) and comparing it with a snapshot VS Code's nightly suite takes of the same
fixture; the keymap test ([LI15](#li15)). The nightly suite adds layout checks (no lens row wider than its box, a flaky
mark on a flaky test). **Lives in** `apps/vscode/tests`, `apps/jetbrains/src/test` and `.github` (FSL). **Replaces**
JetBrains checks that never look at what the IDE draws. **Depends on** [LI1](#li1), [LI2](#li2). **Revisits**
[real-editor-checks.md](real-editor-checks.md) D1 to D3, which wait for a CI license before any JetBrains check of what
is drawn. Step [L6](#l6).

**Hand-offs (principles 1 and 2).**

<a id="li20"></a>

### LI20. A hand-off contract with a way back

Each hand-off between the tools (Open in editor, Debug in my editor, Send to editor, Open in dashboard, Reproduce or
bisect, Share live, Pair with Piwi Picker, and since v0.68.0 Run on my machine, from the dashboard to the desktop app or
Piwi Runner) is one row: verb, glyph, label at both ends, how the landing confirms it, the way back. The dashboard says
Open in editor and names the entry that reaches Piwi's plugin; the desktop app says Pair and calls itself Piwi Desktop;
an editor whose source is the desktop app opens pages through `piwi://open/<page>`
(`apps/desktop/src-tauri/src/lib.rs:256-271`); a debug run from the dashboard reads 'Following run #81 in VS Code ·
Open' there (the study's P5) and offers Back to the failure in the editor. A test holds every label to the table, and
the docs' hand-offs table is generated from it. **Lives in** a table beside the concept table (FSL). **Replaces** one
destination under two names, 'Connect' meaning two things. **Depends on** [LI2](#li2). **Revisits**
[bug-report-to-failing-test.md](../adr/bug-report-to-failing-test.md)'s 'Connect Piwi Picker' card. Step [M24](#m24).

## 11. Defects filed

The defects still open on `PiwiTests/piwi`, grouped by area as the repository's issues are. The leftovers of the closed
ones are planned: the JetBrains header of #1120 in [Q27](#q27), its MCP copy's connection gate in [Q30](#q30), the
line-number menu of #1116 in [M7](#m7), and the stale Run This Spec wording of #1121 in [Q30](#q30).

| Issue | What still holds | Findings |
|---|---|---|
| #1117 | Piwi's Ctrl+Alt+Shift chords collide with Rider's Visual Studio, ReSharper and Visual Assist keymaps, and Cmd+Alt+Shift+R with `ForceRefresh` on macOS | [AC12](#ac12) |
| #1118 | Rider's highlighting of a spec folder beside the solution is unchecked, and nothing offers to attach that folder | [RD3](#rd3) |
| #1255 | JetBrains reads a stopped editor service as one not started yet | [NF5](#nf5) |
| #1315 | A CI or teammate run's tests drawn as running on the test lines, Re-run Failing with nothing failing, JetBrains messages without a way out, the Worker tab's accessible name | [NF4](#nf4), [NF9](#nf9), [NF5](#nf5), [NF6](#nf6) |

## 12. The plan

Ranked by what each change buys a developer per day, then by size; each step is one pull request under the commit scope
in its row unless the row names more, and each quick win lands with the test that holds it. Every step that adds a
command id, action id, group id, view id or setting key registers it in D25 in the same pull request.

### Quick wins

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="q13"></a>Q13 | **The rest of the notification policy**: Don't Show Again on VS Code's own repeated messages, a gear on JetBrains' run balloon, and a platform test of every balloon's group | `ide` | [HM15](#hm15) |
| <a id="q27"></a>Q27 | **Every JetBrains message with its way out and its group**: a stopped service said as VS Code says it, with Restart first (#1255); the tool window's header saying an unreachable instance as its empty text does; one did-not-answer sentence, as a warning; copies confirmed, notes offered, Connect… on the connect-first answer; the trust state naming how to trust | `ide` | [NF5](#nf5), [NF8](#nf8), [HM8](#hm8), [HM19](#hm19) |
| <a id="q28"></a>Q28 | **A CI, teammate or agent run never reads as the developer's own**: a test line's live state from the developer's own runs alone, 'CI run #130' in the tooltip otherwise; a label and launcher on `RunSession`, shown in the Run tab, the progress text and the choosers | `ide` | [NF4](#nf4), [LR10](#lr10) |
| <a id="q30"></a>Q30 | **Small drifts**: Re-run Failing only with failures; Copy the MCP configuration only while connected; Run This Spec's description and docs row; Interact and an accessible name per lane in JetBrains' Worker tab; group and view ids in D25, `editor-ids-register.test.ts` reading them | `ide` | [NF9](#nf9), [NF6](#nf6), [NF10](#nf10) |

### Medium

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="m3"></a>M3 | **The rest of one Piwi menu** ([LI4](#li4)): Piwi Picker's popup and the tray take its order and words in their own pull requests | `ide` | [AC3](#ac3), [X3](#x3) |
| <a id="m4"></a>M4 | **The rest of the Piwi icon set generated with the brand assets** ([LI2](#li2)): the glyphs Appendix A still marks (new), as plugin SVGs and in VS Code's icon font | `ide` | [X2](#x2), [LR14](#lr14) |
| <a id="m5"></a>M5 | **The running ring animated in JetBrains** ([LI3](#li3)), if its gutter allows it (§13, question 3) | `ide` | [TL5](#tl5) |
| <a id="m7"></a>M7 | **One action list per test line, from the service** (`piwi/testActions`), in JetBrains' result icon, VS Code's Testing menus and, with the Testing view off, `editor/lineNumber/context`; on failure nodes too, with Verify ×3 and Jump to Source | `ide` | [TL2](#tl2), [TL7](#tl7), [TL9](#tl9), [TL6](#tl6) |
| <a id="m8"></a>M8 | **Debug with Piwi in both editors** | `ide` | [TL17](#tl17) |
| <a id="m9"></a>M9 | **Piwi on the IDE run icon in JetBrains, and its result icon switchable**; the editor fixture gets a real `@playwright/test` | `ide` | [TL3](#tl3), [TL4](#tl4) |
| <a id="m10"></a>M10 | **One settings registry and grouped settings pages** ([LI11](#li11)), a switch for the CI positions and the run options scoped per person; the new keys in D25 before 1.0 | `ide` | [ST7](#st7), [ST8](#st8), [ST12](#st12), [ST15](#st15), [ST13](#st13), [ST21](#st21), [NF8](#nf8), [NF3](#nf3) |
| <a id="m11"></a>M11 | **One onboarding script** ([LI12](#li12)): JetBrains' Get Started tab, a walkthrough with images, one first-run queue | `ide` | [ST1](#st1), [ST2](#st2), [ST3](#st3), [ST21](#st21), [ST4](#st4) |
| <a id="m12"></a>M12 | **One Connect panel and a non-modal sign-in in JetBrains** ([LI13](#li13)) | `ide` | [ST16](#st16) |
| <a id="m13"></a>M13 | **The status item as one view model** from the service: one item and its status menu in VS Code, its run items and count item folded in, one count worded once (`3 of 9`), the alarm for new failures only, the status in the dashboard's words with one glyph per state | `ide` | [HM2](#hm2), [HM4](#hm4), [LR2](#lr2), [LR1](#lr1), [LR18](#lr18) |
| <a id="m14"></a>M14 | **Run controls where the debugger keeps its own**, as [LI9](#li9) places them: a run group in VS Code's `editor/context`, JetBrains' Run menu, editor menu and a Run tab with the controls, Go to the stopped line, the starting state, run names in the choosers, and JetBrains' inlay down to VS Code's paused text and four controls | `ide` | [LR3](#lr3), [LR6](#lr6), [LR4](#lr4), [LR13](#lr13), [LR16](#lr16) |
| <a id="m15"></a>M15 | **One page per worker, with the controls as `Piwi.RunControl`'s toolbar**: the paused page joins the worker views; Watch and Interact as toggles with icons under one input rule, VS Code's tab icons, an accessible name on every control | `ide` | [LR8](#lr8), [NF6](#nf6) |
| <a id="m16"></a>M16 | **Per-keymap chords checked against every bundled keymap**, Mac OS X 10.5+'s `ForceRefresh` on Cmd+Alt+Shift+R included, and a Failures chord in both editors (#1117) | `ide` | [AC12](#ac12) |
| <a id="m17"></a>M17 | **A Rider descriptor and a Rider scene** ([LI16](#li16)): Rider's highlighting of a folder beside the solution and the Attach Folder balloon (#1118), C# files' marks and lenses checked before the listings and `editor-coverage.md` claim them, `jetbrains.md`'s Rider table from the scene | `ide` | [RD3](#rd3), [RD4](#rd4), [AC3](#ac3) |
| <a id="m21"></a>M21 | **Verdicts worded by the service** for every run the editor followed, those of terminal runs after the study's P7, and the editors' native call for the study's attention | `ide` | [HM16](#hm16), [HM17](#hm17) |
| <a id="m22"></a>M22 | **The words both clients show, sent by the service**, held by a golden test across `glue.ts` and `Glue.kt`; the pausing line names its call and its time in both | `ide` | [AC11](#ac11), [LR18](#lr18), [AC9](#ac9), [NF3](#nf3) |
| <a id="m23"></a>M23 | **Agents through the JetBrains IDE's MCP server** ([LI18](#li18)); first check that the toolset reaches the AI Assistant and Junie | `ide` | [ST22](#st22) |
| <a id="m24"></a>M24 | **Editors open the desktop app's pages through `piwi://open`**; each hand-off one glyph at both ends | `ide` | none ([LI20](#li20)) |

### Large

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="l1"></a>L1 | **A Runs home for the developer's own runs in both editors**, placed as [LI9](#li9) says, with the catalog's actions, keys and names, Hold failures on each run's row, and the place of the CI list settled | `ide` | [LR7](#lr7), [LR9](#lr9), [LR10](#lr10), [LR12](#lr12), [NF10](#nf10) |
| <a id="l2"></a>L2 | **VS Code's coverage view and a JetBrains test tree for Piwi runs** ([LI8](#li8)) | `ide` | [TL18](#tl18), [TL19](#tl19), [TL1](#tl1) |
| <a id="l3"></a>L3 | **A debug session spike, decided for both IDEs** ([LI10](#li10)), tried in Rider with the backend under the debugger | `ide` | [LR3](#lr3) |
| <a id="l4"></a>L4 | **Endpoint-level reach**: the manifest's handler line in `integrations/aspnetcore` first (MIT; no scope fits, so that commit has none), then the lens (`ide`) and Open in IDE on .NET frames (`ui`) | `ide` | [RD7](#rd7), [RD8](#rd8) |
| <a id="l5"></a>L5 | **A test card in both editors** (`piwi/testCard`), laid out like the dashboard's test row | `ide` | [TL21](#tl21) |
| <a id="l6"></a>L6 | **Both editors checked on the shared fixture, without a license** ([LI19](#li19)): a `CodeVisionTestCase` expecting VS Code's row, `findAllGutters`, golden fixtures through `glue.ts` and `Glue.kt`, and the nightly layout checks; the workflow change as its own `ci` commit | `ide` | [LR6](#lr6) |
| <a id="l7"></a>L7 | **Decide what Piwi is for Playwright on .NET**: a non-goal in `ROADMAP.md`, or a proposal for an MIT NuGet adapter | `docs` | none ([LI17](#li17)) |

### Sequence

The quick wins that stand alone (Q13, Q27, Q28, Q30), each on its own. Then, on the action catalog, one Piwi menu
(M3) and the run-control places (M14); M4 draws the glyphs
Appendix A still marks, and M5 animates the running ring. M13 and M15 finish the glance and the
page; M16 and M17 close #1117 and #1118; L1's Runs home settles where the CI list goes (NF10); L3 decides before 1.0
whether M14's places are interim.

## 13. Open questions

1. **A debug session or not** ([LI10](#li10)): keep [run-control.md](../adr/run-control.md) §3.2's choice and give
   Piwi's controls the debugger's places ([LI9](#li9)), or an inline `DebugAdapter` and an `XDebugProcess`? To decide
   before 1.0 freezes the run-control ids D25 lists.
2. **Caret or cursor**, decided: each platform's word, as the action catalog says it (`{cursor}` in
   `packages/editor/src/actions.ts`: Run to the cursor in VS Code, Run to the caret in JetBrains).
3. **Two marks**: flaky takes the dashboard's fuchsia shuffle (§2 principle 3). Can VS Code's margin show
   the flaky mark beside the Testing view's glyph, and can JetBrains' gutter animate the running ring ([TL5](#tl5))?
   Record's action icon is decided: gray, with red kept for the recording state, as JetBrains' icon style asks.
4. **Where the concept table lives** (the catalog and the settings registry are in `packages/editor`, [LI1](#li1),
   [LI11](#li11)): `packages/editor`, bundled by both clients, or `apps/application/shared` beside `piwi-features.ts`
   and `piwi-ecosystem.ts`? Both are FSL; `packages/core` is MIT and cannot take Piwi Picker's drawings. Are
   `package.json` and `plugin.xml` generated from them, or kept by hand under a test?
5. **The codicons' floor**: the codicons Appendix A proposes exist in VS Code 1.143.1 and are unchecked against the
   1.91 engines floor.
6. **VS Code's status click**, decided: the status menu, with the state's action preselected so Enter keeps today's
   refresh.
7. **What turns the status item to its alarm** ([HM2](#hm2)): failures new against the baseline, only those a run
   started here or local edits produced, or both?
8. **Where VS Code's Runs view lives**: in the Piwi panel beside Failures, matching JetBrains' Runs tab (this document's
   lean), or in Run and Debug, where developers looked at a stop? Whether JetBrains draws its run views in Swing or JCEF
   is the live-run study's open question 9.
9. **Plain Run and breakpoints**: does plain Run keep stopping at breakpoints, or leave stops to Debug with Piwi?
   `piwi.breakpoints` is a boolean, on by default (`apps/vscode/package.json:1146-1150`), and frozen in D25: a value
   that limits stops to Debug runs needs a default for existing installs. Headedness is the live-run study's question
   10; its P6 holds failures for an editor's debug run.
10. **A CI run on the status line**: the study puts the developer's own run first (P5) and lists CI runs of the branch
    read-only (P10). Does a CI run ever take the line while none of the developer's own is live?
11. **Team or personal settings**: which does a team share (`failureSeverity` in particular)? The new switches go into
    D25 before 1.0, and the service filters by them ([ST8](#st8), [LI11](#li11)).
12. **JetBrains' Get Started tab**: opened once per installation, as SonarQube for IDE's welcome is ([ST1](#st1)'s
    lean), or only from Tools → Piwi and the first-run balloon, keeping
    [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M8's lighter touch?
13. **Rider's menus and keys**: whether Run Control goes in the Tests menu as well as the Run menu ([LR3](#lr3)); which
    Solution Explorer popup group works on Rider 2026.2; which letters are free in its Visual Studio 2022, Visual Studio
    and ReSharper keymaps; and which action runs when a keymap gives a Piwi chord to another action too?
14. **The IDE run icon's group**: is `JSTestRunLineMarkersAdditionalActionGroup` present and read in Rider 2026.2 and in
    every IDE of `verifyIdes` ([M9](#m9))?
15. **Rider's C# surfaces**: do Code Vision, LSP diagnostics and the hover appear on `.cs`, `.cshtml` and `.razor`
    files; does `SKIP_HIGHLIGHTING` apply to a folder beside the solution in the same Git root; does dotCover share the
    strip Piwi's coverage bar paints? Can CI run Rider, or is the Rider scene a check the maintainer runs before a
    release?
16. **The IDE's MCP server** ([LI18](#li18)): does `com.intellij.mcpServer`'s `mcpToolset` reach the AI Assistant and
    Junie or only external agents, which IDE versions bundle it, and does a module compiled against it pass
    `verifyPlugin` on 2024.1 and the latest Rider?
17. **Code Vision entries per line**: the plugin draws eight and drops a ninth without a word. Does the service cap a
    line at eight, folding the rest into one entry?
18. **The in-editor debug action's name**: 'Debug with Piwi', pairing with Run with Piwi, the dashboard's 'Debug in my
    editor', or 'Debug this failure' on a failure node? The choice goes in the catalog and in
    [developer-loop-audit.md](developer-loop-audit.md) §9.
19. **Playwright for .NET, Java and Python** ([LI17](#li17)): a non-goal stated everywhere a .NET user looks, or a NuGet
    adapter in `integrations/`? The maintainer's scope decision.

## 14. Found since: what building the plan added

The reviews at `b0ff6772` read the code that built the plan and the live-run study's phases against §2's principles.
Each finding below is new, read in the code at that commit; Kotlin files are cited by name as above. The defects among
them, NF4, NF5, NF6 and NF9, are filed as #1315, with NF5's stopped-service status in #1255.

<a id="nf3"></a>**NF3. The start options take two shapes, and the words of a worker and of a welcome differ.** VS Code titles its
worker panel "Piwi: worker 2" and both clients' CI lanes say "worker 2" against "Worker 2" elsewhere
(`apps/vscode/src/worker-panel.ts:614`, `apps/vscode/src/run-control.ts:2117`, `Glue.kt:3336`), and `piwi.refresh` is
Retry in one welcome and Refresh in the next (`package.json:91, 96`). VS Code offers one Run options… quick pick
(`apps/vscode/src/extension.ts:1461-1490`) where JetBrains has a Run headed toggle and Hold failures from each run's
start… (`plugin.xml:149-154`), the hold choices worded three ways (`apps/vscode/src/glue.ts:1772-1776`,
`package.json:1165-1169`, `Glue.kt:67-71`). **(read)** Fix: one shape for the start options, the worker's and the
hold choices' words from the words table, and each welcome's links from `failuresView`. ([M10](#m10), [M22](#m22))

<a id="nf4"></a>**NF4. A CI or teammate run reads as the developer's own on the test lines, and an agent's run in the
status bars.** A test line takes its state from any live run (`packages/editor/src/server.ts:3060-3061`) and says
"running in run #130", 'your' only for the developer's own and 'CI' never (`server.ts:666-669`), so JetBrains' result
icon and VS Code's gutter draw a CI run's tests as running. `RunSession` carries no label or launcher
(`packages/editor/src/protocol.ts:1865-1915`): an agent's run counts as the person's in both status bars, and JetBrains'
Run tab leaves the agent's label out (`PiwiCommands.kt:381`) where VS Code's task carries it. **(read)** Fix: a test
line's live state from the developer's own runs alone, else 'CI run #130' in the tooltip; the label and launcher on
`RunSession`, shown in the tab, the progress text and the choosers. ([Q28](#q28))

<a id="nf5"></a>**NF5. JetBrains misreports a stopped service, and several of its messages give no way out or sit in the
wrong group.** `stopped()` clears the status (`PiwiProjectService.kt:417-430`), so the status item reads 'Piwi starts
when you open a file' and the tool window's header says the same above 'The Piwi editor service stopped.' (`Glue.kt:390,
985`), where VS Code says 'Piwi: not running' with Restart. Only the messages built from `Glue.SERVICE_NOT_RUNNING` or
`SERVICE_NO_ANSWER` offer Restart and the log (`Glue.kt:1040-1041`); the others, worded their own way, offer neither,
and three go to the results group as information (`PiwiRunControl.kt:1538, 1588, 1617, 1670, 1789, 1798`,
`PiwiRecordingActions.kt:391, 401`). The MCP copies confirm through `notify` into results (`PiwiActions.kt:459-462,
520-525`), the .NET note is a result (`PiwiProjectService.kt:330`), and 'Connect to an instance first.'
(`PiwiActions.kt:455`) has no Connect… and shows while the service is down. **(read)** Fix: a not-running view with
Restart first, one did-not-answer sentence as a warning everywhere, copies through `PiwiNotifier.confirm`, the note as
an offer, and Connect… on the connect-first answer. ([Q27](#q27))

<a id="nf6"></a>**NF6. JetBrains' Worker tab watches only, and names every lane a paused page.** It calls
`configureLive(true, false, false)` (`PiwiRunControl.kt:1016`), so it never offers Interact, which VS Code's worker
panel does (`apps/vscode/src/run-control.ts:1987`), and its accessible name is 'Paused test page' for a running or a CI
lane (`PiwiRunControl.kt:2482`). **(read)** Fix: Interact at a stop, as the Paused Page offers it, and a name per kind
of lane, until [M15](#m15) makes one page per worker. ([Q30](#q30))

<a id="nf8"></a>**NF8. New marks and options have no switch or no way out.** The CI positions both editors draw beside
the lines while a CI run of the branch runs cannot be turned off (`apps/vscode/src/ci-view.ts:49-56, 91-113`,
`PiwiCiRuns.kt:196-209`). VS Code's Run options… writes a choice into `.vscode/settings.json` whenever that file already
sets the key, since its value would win (`apps/vscode/src/glue.ts:1836-1838`), so one person's choice becomes the
team's, where JetBrains keeps both per person. Waiting for a project's trust offers no action and does not say how to
trust it (`Glue.kt:385, 473`, `PiwiProjectService.kt:261-264`). **(read)** Fix: a CI-positions switch in [ST8](#st8)'s
set, the run options scoped per person ([ST12](#st12)), and the IDE's trust action named. ([M10](#m10), [Q27](#q27))

<a id="nf9"></a>**NF9. Two drifts: Re-run Failing and Run This Spec's wording.** `failuresView(states,
answer.items.length > 0)` (`packages/editor/src/server.ts:1317`) keeps Re-run Failing enabled in both editors when only
locally fixed items remain; Run This Spec's description and the docs' lens row still say it runs the tests Piwi knows
(`plugin.xml:144`, `apps/docs/features/editors.md:51`), though it runs every test of the file. **(read)** Fix: count the
failing items; reword both. ([Q30](#q30))

<a id="nf10"></a>**NF10. The register misses the new groups and views, and the CI list sits outside §8.4's places.** D25
holds the action and command ids but not the group ids `Piwi.Actions` and `Piwi.EditorPopup` nor the view ids,
`piwi.ciRuns` among them, and `apps/application/tests/unit/editor-ids-register.test.ts` reads only `<action id=`. CI
runs got a view and a tab of their own (`apps/vscode/src/ci-view.ts:88`, `PiwiCiRuns.kt:156`), while §8.4 puts them as
read-only rows of a Runs view and tab, which the developer's own runs still lack. **(read)** Fix: register the groups
and views, the test reading them; settle in [L1](#l1) whether the CI list joins the Runs home. ([Q30](#q30), [L1](#l1))

## Appendix A. The concept table, first draft

One row per concept, one glyph per tool, as §2 and [LI2](#li2) propose it. A JetBrains `*.svg` is Piwi's, in the
plugin's `icons/` with a `_dark` copy. **(new)** marks a glyph Piwi is still to draw: a JetBrains SVG, a VS Code glyph
in the product-icon font, a Piwi Picker key added to `apps/extension/src/shared/icons.ts`. A dash means the tool has no
such action.

| Concept | Dashboard and desktop (lucide) | Piwi Picker (ICONS key) | VS Code (codicon or `$(piwi-*)`) | JetBrains (AllIcons or plugin SVG) |
|---|---|---|---|---|
| Connect | `plug` | `plug` | `$(plug)` | `connect.svg` |
| Disconnect | `unplug` | `unlink` | `$(debug-disconnect)` | `disconnect.svg` |
| Record | `circle`, filled | `record` | `$(record)` | `record.svg`, gray; `recording.svg`, red, while recording |
| Recording paused | – | `record`, gray | `$(circle-large-outline)` | `recordPaused.svg` |
| Stop recording | – | `stop-circle` | `$(stop-circle)` | `stopRecording.svg` |
| Resume | `play` | `play` | `$(debug-continue)` | `Actions.Resume` |
| Pause | `pause` | `pause` | `$(debug-pause)` | `Actions.Pause` |
| Step | `redo-dot` | `skip` | `$(debug-step-over)` | `Actions.TraceOver` |
| Finish | `arrow-up-from-dot` | `step-out` | `$(debug-step-out)` | `Actions.StepOut` |
| End the test | `ban` | `blocked` | `$(circle-slash)` | `RunConfigurations.TestIgnored` |
| Stop the run | `square` | `stop` | `$(debug-stop)` | `Actions.Suspend` |
| Pick | `crosshair` | `pick` | `$(target)` | `General.Locate` |
| Assert | `check-circle` | `check-circle` | `$(pass)` | `General.InspectionsOK` |
| Assert a region | `scan` | `viewport` | `$(screen-full)` or `$(piwi-region)` (new) | `region.svg` |
| Mock a request | `network` | `network` | `$(arrow-swap)` or `$(piwi-mock)` (new) | `mock.svg` |
| Share live ([LR14](#lr14)) | `radio` | `broadcast` | `$(broadcast)` | `live.svg` |
| Stop sharing live | – | – | `$(piwi-stop-live)` (new) | `stopLive.svg` |
| Watch | `eye` | `eye` | `$(eye)`, built for Watch a worker's test | `Actions.Show`, built for `Piwi.WatchWorker` |
| Pause and watch | `pause`, `eye` once stopped | `pause` | `$(piwi-pause-watch)` (new) | `pauseWatch.svg` |
| Run on my machine | `monitor-play` | – | – | – |
| Run headed, Hold failures (start options) | – | – | `$(settings)` on Run options… | `Debugger.Db_exception_breakpoint` for Hold failures, none for Run headed ([NF3](#nf3)) |
| Show the stopped test's browser | – | – | `$(browser)` | `browser.svg` |
| Share with Playwright tools | – | – | `$(tools)` | `tools.svg` |
| Reset the runs' MCP token | – | – | `$(key)` | `key.svg` |
| Run the tests that reach this file | – | – | `$(references)` | `testsForFile.svg` |
| A CI run of the branch | – | – | `$(cloud)` | `ciRun.svg` |
| Pair | `link` | `link` | `$(link)` | `pair.svg` |
| Open in dashboard | `external-link` | `external` | `$(link-external)` | `Ide.External_link_arrow` |
| Latest run, run node | the Piwi mark | – | `$(piwi-mark)` (new) | `piwi.svg`, 16 px outline (new) |
| Cluster | `layers` | – | `$(layers)` | `layers.svg` |
| Owner | `user` | – | `$(person)` | `General.User` |
| Trace | `file-archive` | – | `$(file-zip)` | `FileTypes.Archive` |
| Screenshot | `camera` | `camera` | `$(device-camera)` | `FileTypes.Image` |
| Reproduce in the desktop app | `monitor` | `monitor` | `$(device-desktop)` | `Nodes.Desktop` |
| Find the breaking commit | `git-branch` | – | `$(git-branch)` | `Vcs.Branch` |
| Verify ×3 | – | – | `$(sync)` | `Actions.Rerun` |
| Run this spec | – | – | `$(run-all)` | `Actions.RunAll` |
| Re-run the failing tests | – | – | `$(run-errors)` | `RunConfigurations.RerunFailedTests` |
| Coverage | `scan-line` | – | `$(run-coverage)` | `General.RunWithCoverage` |
| Passed: `emerald-500` `#10b981` | `check-circle-2` | a dot in the fill | `test-passed.svg` | `RunConfigurations.TestPassed` |
| Failed: `rose-500` `#f43f5e` | `x-circle` | a dot in the fill | `test-failed.svg` | `RunConfigurations.TestError` |
| Flaky: `fuchsia-500` `#d946ef` | `shuffle` | a dot in the fill | `test-flaky.svg`, and `$(piwi-flaky)` (new) for a codicon | `testFlaky.svg` |
| Running: `blue-500` `#3b82f6` | `loader-circle`, spinning | – | a ring in `test-running.svg`, spinning | `testRunning.svg`, a ring |
| Skipped: `zinc-400` `#a1a1aa`; fixme `zinc-600` | `minus-circle` | a dot in the fill | `test-skipped.svg` | `RunConfigurations.TestIgnored` |
| Did not run: `amber-500` `#f59e0b` | `circle-slash` | – | – | `RunConfigurations.TestNotRan` |
| Interrupted: `slate-500` `#64748b` | `circle-pause`; the tray's dot | – | – | – |

The last seven rows are `STATUS_COLORS` (`apps/application/shared/status-colors.ts:36-45`) with the dashboard's
`getStatusIcon` glyphs (`apps/application/app/utils/index.ts:311-331`). The outcome palette adds four states with no key
there: unknown (JetBrains draws `TestNotRan`, VS Code nothing), paused, a held failure and recording.

Every platform constant is to be checked on 241 and 262, and every codicon against the 1.91 engines floor, before use. A
first pass found each AllIcons constant above mapped to a New UI icon in both platforms' `PlatformIconMappings.json`,
and each codicon in the `codicon.css` VS Code 1.143.1 bundles; every lucide name is in the dashboard's icon set, though
`redo-dot` and `arrow-up-from-dot` are not used by the dashboard yet.

The draft leaves its collisions to settle, which `menus.test.ts` and `PiwiPluginTest` list as the glyphs two concepts
still share: `$(eye)` is also VS Code's Stop following the active editor (`apps/vscode/package.json:359-364`); Verify ×3's `$(sync)` spins in the
running status item (`apps/vscode/src/glue.ts:164`); `RunConfigurations.TestIgnored` is both End the test and Skipped;
lucide `scan` sits close to `scan-line`, and `ban` to `circle-slash`. The desktop app's Pick on the image draws
`mouse-pointer-click` (`apps/application/app/components/desktop/DesktopRunStopPage.vue:356`) where the dashboard's Pick
draws `crosshair`, and Piwi Picker's recording bar stops with `stop`, the square
(`apps/extension/src/content/record-panel.ts:673`). VS Code's `$(beaker)` stays the Piwi mark on the status item and the
run node until `$(piwi-mark)` is drawn.

## Appendix B. Checked and found sound

What the slices and the two hands-on runs checked and found right, kept here so that no step of §12 reworks it.

- **The protocol and the runs.** The parity of [developer-loop-audit.md](developer-loop-audit.md) §8 still holds, and
  both clients build the same run arguments from the service's answers: the gaps above are in what each client draws,
  places and words **(read)**.
- **The platform's icons.** Of the 36 `AllIcons` constants the plugin used at `e82b429f`, all but the macro film
  strip have a New UI icon in 262's `PlatformIconMappings.json`; in 241's, `Actions.GroupByFile` and
  `Debugger.NextStatement` have none either. `TestState.Run` and `Debugger.NextStatement` are 12 px gutter glyphs, 14 px
  in 262's New UI. Appendix A's constants exist on both with a New UI icon **(read)**.
- **The codicons.** The 37 codicons the extension used at `e82b429f` are in VS Code 1.143.1's registry, and so are the
  menu points the plan uses (`testing/item/gutter`, `testing/item/context`, `testing/message/context`,
  `editor/title/run`, `file/newFile`, `editor/lineNumber/context`); neither set was checked against the 1.91 engines
  floor **(read)**.
- **The Piwi mark** is one drawing, written into `pluginIcon.svg`, `icons/piwi.svg` and `media/piwi.svg` by
  `apps/application/scripts/generate-brand-assets.mjs:221-229`; the plugin's `piwi_dark.svg` exists **(read)**.
- **Coverage colors**, one palette across the tools (§3), stay apart from dotCover's green and red in Rider, and each
  tooltip starts with "Piwi:" (`PiwiDefault.xml:20-38`, `Glue.kt:789-810`); every Rider scheme derives from Default or
  Darcula, so the `PIWI_*` keys reach it **(read)**.
- **The recording mark's menu** is built from the registered `Piwi.StopRecording`, `Piwi.PauseRecording` and
  `Piwi.ResumeRecording` (`PiwiRecording.kt:258-260`), so it shows Ctrl+Alt+Shift+R: the pattern every Piwi popup
  follows **(read)**.
- **JetBrains' status item** draws `TestError` and the error color for failing tests in Rider 2026.2.4.1 **(seen)**.
- **Rider.** The plugin starts in Rider 2026.2.4.1 and its editor service answers the editor fixture's stub **(seen)**;
  it finds a config beside a solution through Git (`Glue.kt:218-231`, `GlueTest.kt:2391-2398`) **(read)**. The editor
  menu shows Piwi's entries, and the Add menu offers Record a New Test File… **(seen)**. `use-shortcut-of` gives the run
  controls Rider's Visual Studio keys (F5, F10, Shift+F11, Ctrl+F10) **(read)**.
- **VS Code's Testing view** follows a live run test by test (`apps/vscode/src/test-explorer.ts:379-411`), the view
  JetBrains lacks ([TL19](#tl19)) **(read)**.
