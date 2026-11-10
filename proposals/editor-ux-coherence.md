# One Piwi in the editor: a UX audit of the JetBrains plugin and the VS Code extension

An audit of what a developer meets of Piwi in the editor: the JetBrains plugin (`apps/jetbrains/`) as the maintainer
uses it in Rider, and the VS Code extension (`apps/vscode/`), both thin clients of the editor service
(`packages/editor/`). Their menus, icons, settings, gutter marks, panels and run controls are read side by side, with
their seams to the dashboard, the desktop app and Piwi Picker, against one aim: a developer who moves between Piwi's
tools meets one Piwi.

**Status.** Proposed 2026-11-05, against `main` at v0.66.0 (`e82b429f`). Built: [Q1](#q1) (each Code Vision entry of a
line drawn by a provider of its own, in a group named Piwi, #1115; its `CodeVisionTestCase` on the editor fixture is not
written yet), [Q2](#q2) in VS Code (a flaky test said so while the Testing view owns the gutter, and a test with no
recent result marked, #1116; Q2's JetBrains flaky icon waits for [M5](#m5)'s palette), [Q3](#q3) (Tools → Piwi compact,
and one Piwi submenu in both editors' context menus, in one order), [Q19](#q19) (a spec beside a Rider solution opened
and debugged from one list of the project's folders, #1118; Rider's highlighting of such a folder and the Attach Folder
balloon of [RD3](#rd3) are unchecked, and the case is a `GlueTest`, a light fixture having no Rider base path),
[Q18](#q18) (the run keys give way only to a paused debugger, Pause to a running one and Stop to any, superseding
run-control.md's rule; Pause on the debugger's Pause key, and Resume's key held two seconds after an answer in the
JetBrains IDEs too, #1117; the chords of [AC12](#ac12) are not moved yet), [Q4](#q4) (Settings search finds Piwi's page
and actions: the release builds the searchable options index, and a contributor adds the words the labels lack, #1119),
[Q6](#q6) (a project in safe mode says Piwi waits for its trust, and trusting it starts Piwi, #1119), [Q5](#q5) in part
(Connect on the settings page applies nothing, Disconnect only when something is saved, worded certificate and 404
errors and labels on top, #1119; the page opening on the connection in use, [ST9](#st9), and one word per refresh with
Node.js Settings…, [ST18](#st18), remain), [Q7](#q7) (both failures views say the state the service reads, an
unreachable instance, no run, a desktop app to restart or no connection, and the commands that read the instance wait
for a connection, #1120; and [HM7](#hm7)'s '…' menu, Follow worded by its state, as two commands rather than one
toggled, beside Connect, Open settings and Open the log, #1120), [Q16](#q16) in part (Piwi: Restart the editor service,
and no toast for a failed request, #1120; [HM19](#hm19)'s status item saying 'Piwi: not running', with Restart and the
log; Restart in the unreachable tooltip and JetBrains' restart link in its empty text remain), [Q8](#q8) in part (Open
in Dashboard on the tool window's selection, [HM5](#hm5), #1120; the tool window's tab named Failures, its icon dotted
red while tests fail, [HM13](#hm13); each node's hover the service's, [HM9](#hm9); one Group By drop-down and a gear
menu holding Connect…, Pair, the MCP copies, Refresh and Settings…, [HM6](#hm6); a registered `Piwi.RefreshRun`, Refresh
the Latest Run, first in the toolbar and the titled status popup, which offers Connect… only while a config is not
connected, [HM3](#hm3), [AC10](#ac10); remaining: the one-line header of [HM12](#hm12), the headline in one place of
HM9, Documentation and the log in the gear, one Open in Dashboard in the popup, Reload Piwi and a glyph of its own for
each refresh, and the popup's run section waiting for [M2](#m2)), the Paused Page and Worker tabs closing ([LR8](#lr8),
#1120), [Q11](#q11) (a test's result said once on its line, its pass rate in words, every lens's tooltip saying what its
click runs, and a local run's failure leading with 'Local failure:', #1121; the gutter mark's tooltip written by the
service in the dashboard's words, under a drift test, naming the run its result is from when the latest run or the run
in progress gives it, [TL10](#tl10); JetBrains shows it on the result icon alone, and the pass rate reads 'passed 44 of
48 runs'), [Q12](#q12)'s [TL14](#tl14) (JetBrains tints a failing test's lines to the editor's edge, #1121), [Q20](#q20)
(Run This Spec and the spec's lens run every test of the file by its path, #1121), [Q17](#q17) (VS Code's run items each
named, read without their icon, naming no key, Resume alone at a held failure, which is marked in red, #1122),
[LR6](#lr6) in VS Code (the lens row above a stop holds Resume, Step, Finish and Write code…, #1122; the line's own lens
hiding meanwhile, JetBrains' inlay and the nightly width check of [M14](#m14) remain), [LR2](#lr2)'s icons (no spinner
at a held stop, the error's icon at a held failure, #1122; the line the service composes for both clients, [M13](#m13),
remains), [ST23](#st23) in part (the JetBrains plugin logs a failed request to idea.log, and every action says the one
not-running sentence; its Log tab and Piwi.OpenLog of [M19](#m19) remain), [Q24](#q24) (one name per worker, #1213),
with an unproven desktop app told apart from an unreachable one in both status items (#1213), [Q15](#q15) (the editor
fixture answers each spec's own cases and the nightly suite holds the spec's count, [ST6](#st6); the JetBrains script
writes no image whose status item lacks its failing icon and color, [HM20](#hm20); both sets of images and the recording
video captured again, #1123; WebStorm 2026.3 drew the item with both, so why an earlier capture drew it gray stays
unexplained), and every command, setting and action id of both editors registered in D25 and held to the manifests
(#1124). Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. The defects the audit confirmed are filed as #1115 to
#1123 (§11). Rechecked on 2026-11-10 against `main` at v0.68.0 (`0e27d76f`), every line reference moved to that commit:
no finding was fixed then; the live-run study's work built part of LR4, LR9, LR13, LR15 and LR17; v0.68.0's worker
views, Watch a Worker's Test and local progress add [LR18](#lr18) and new cases of IC1, IC5, LR8, LR14 and HM8; #1122's
four items are built. It cites and does not restate [editor-extensions-audit.md](../adr/editor-extensions-audit.md),
[developer-loop-audit.md](developer-loop-audit.md) §8 (P1 to P15) and §9 (the vocabulary),
[record-from-the-ide.md](record-from-the-ide.md), [real-editor-checks.md](real-editor-checks.md),
[live-view-next.md](live-view-next.md) Part 6 and [extension-ux-audit.md](extension-ux-audit.md). The live-run study,
[live-runs.md](live-runs.md), is proposed alongside this one: this document owns where each editor hosts a run (the
status item, the menus, the Run tab, the Runs view and tab, the stop line, the gutter marks, the keys, the paused page)
and the debug-session question ([LI10](#li10)); the study owns the live model, the words of watching and its phases P0
to P11, and builds in those phases what the two documents share. A pull request that builds part of §12 updates this
paragraph; the one that ships its last step moves the document to `adr/`.

**Summary.**

- **The data is shared and mostly right; everything around it differs.** One action has up to four names and two places,
  one outcome up to five marks and four colors, one click means one thing in Rider and another in VS Code, and no test
  holds one client to the other.
- **Ten findings lead (§0)**, from a failing line that says only Trace in JetBrains and a flaky test drawn as a pass in
  VS Code to Rider's keys colliding with Piwi's and a JetBrains settings page that reads None while connected.
- **Nine principles (§2):** one name, one glyph and one outcome palette per concept, held by tests; one menu shape and
  one home per editor; the IDE's own places first; the service words and decides, the clients draw; every entry
  registered and discoverable; quiet and switchable; checked where it is used, Rider included.
- **Twenty larger items (§10) and a ranked plan (§12):** 24 quick wins first, then 24 medium and 7 large steps, each the
  size of a pull request.

Every finding carries a file reference; the plugin's Kotlin files, all in
`apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/`, and its manifest,
`apps/jetbrains/src/main/resources/META-INF/plugin.xml`, are cited by file name. **(seen)**: observed in Rider
2026.2.4.1 or VS Code 1.143.1 on the editor fixture at v0.66.0, as §1 describes; the line references are at v0.68.0.
**(read)**: from the code, or from the 241 and 262 platform jars. **(counted)**: counted from the manifests
(`apps/vscode/package.json`, `plugin.xml`). A finding a verifier amended states the verifier's correction.

One name per concept, used throughout: the **Piwi tool window** (JetBrains) and the **Failures view** (VS Code),
together the **home**; the **status item**, the **status popup** (JetBrains' menu on its click) and the **status menu**
(the quick pick proposed for VS Code); **Tools → Piwi** (the `Piwi.Actions` group); the **result icon** (Piwi's gutter
icon on a JetBrains test line) and the **IDE run icon** beside it; the **Testing view** (VS Code's, with Piwi's test
controller); the **stop line** (VS Code's lens row and JetBrains' inlay above a stopped line); the **paused page** (VS
Code's webview, JetBrains' Paused Page tab); the **editor service**; the **editor fixture**
(`apps/vscode/scripts/lib/editor-fixture.mjs`, the stub instance both screenshot scripts use); the **action catalog**,
the **concept table** and the **outcome palette** (proposed in §2); the **live-run study**
([live-runs.md](live-runs.md)).

---

## 0. The findings that matter most

1. **JetBrains Code Vision keeps one entry per line, so the line a test failed at says only Trace** ([TL16](#tl16)). The
   service sends four entries under one provider id, which the platform collapses to the last; Flake Lab lines and a
   locator line's failure reason are lost the same way. **(seen)** in Rider and in the docs' own JetBrains screenshot.

2. **Flaky, which only Piwi knows, is lost or misdrawn on the test line** ([TL13](#tl13), [IC4](#ic4), [IC3](#ic3)).
   With `piwi.testExplorer` on, the default, VS Code draws a flaky test as a green pass; JetBrains draws it as the
   inspection warning in the amber of its failed X. Across the tools flaky has five marks and four colors. **(seen)**

3. **Tools → Piwi is one popup of 42 actions, about half grayed out at rest, and both context menus show Piwi's entries
   loose, VS Code's unbranded** ([AC1](#ac1), [AC2](#ac2)). Rider draws 20 disabled rows and scrolls Settings… out of
   view; VS Code lists six entries that do not say Piwi just above its own Run Test at Cursor, and Rider puts five rows
   at the bottom of a 50-row menu. **(seen)**

4. **A stopped Piwi run has its controls everywhere except where the debugger keeps them** ([LR3](#lr3), [LR1](#lr1),
   [LR6](#lr6), [LR7](#lr7)). VS Code shows up to nine status items, most icon-only, and a twelve-entry stop line
   clipped at a laptop's width, while its editor title, context menu and Run and Debug view stay empty; JetBrains opens
   every console run in a Run tab titled 'Piwi' with Rerun, Stop and Close only. **(seen)**

5. **From a test's own line, neither editor offers more than Run and Verify ×3, and nothing debugs it** ([TL2](#tl2),
   [TL3](#tl3), [TL17](#tl17)). A click on JetBrains' result icon opens the dashboard in a browser, its right-click menu
   holds two anonymous actions, and the IDE run icon beside it has no Piwi entry. VS Code's Testing menus have no Piwi
   entry and no Debug profile, so the stop-at-the-failing-line run the service already builds (`RunTestsArgs.debug`)
   starts only from the dashboard's link. **(seen)**; the IDE run icon **(read)**.

6. **One concept has several names and glyphs, and one glyph several meanings** ([IC1](#ic1), [AC7](#ac7),
   [AC11](#ac11), [IC2](#ic2), [IC5](#ic5), [IC7](#ic7)). Fourteen shared actions are worded differently and End the
   test has four spellings; 20 of 43 JetBrains actions and 38 of 58 VS Code commands have no icon; the square stops the
   run in the editors but ends the test in the Runs window. **(seen, counted)**

7. **The status item and the home behave differently in the two editors** ([HM1](#hm1), [HM2](#hm2), [HM5](#hm5),
   [HM6](#hm6)). A click on the status item opens the status popup in Rider but only re-reads the run in VS Code, which
   also paints the item red all day for CI failures the developer did not cause; the Piwi tool window's toolbar has 15
   buttons, two of them identical globes that open the same run page. **(seen)**

8. **In Rider's Visual Studio and ReSharper keymaps, Piwi's keys fight the keymap and the debugger** ([AC12](#ac12),
   [RD1](#rd1), [RD2](#rd2)). The three Ctrl+Alt+Shift chords are bound in `$default` only, where those keymaps give R
   to Run…, K to Commit and Push… and, in ReSharper, F to Silent Code Cleanup. Any debug session, one on the ASP.NET
   backend included, turns every run-control key off in both editors, and Pause takes Resume's key, so F5 pauses the
   Playwright run instead of starting the debugger. **(read)** from Rider 2026.2.4.1's keymaps.

9. **Specs beside a Rider solution, a layout the plugin supports, cannot be debugged from the dashboard, and no check
   launches Rider** ([RD3](#rd3), [RD4](#rd4)). The plugin finds `e2e/playwright.config.ts` beside `backend/Shop.sln`
   through Git, but Debug in my editor checks the file against `basePath`, which Rider sets to `.idea/.idea.<Name>`, and
   refuses it while Open in IDE opens it. CI runs only the Plugin Verifier on Rider's jars, yet the docs say the plugin
   is checked on Rider. **(read)**

10. **The JetBrains settings and first steps hide what they hold** ([ST9](#st9), [ST10](#st10), [ST11](#st11),
    [ST1](#st1)). Connected through the environment, `.env` or the desktop app, Settings → Tools → Piwi opens on empty
    fields and 'None: no instance saved', the connection in use at the bottom. Settings search finds none of its
    options, because the index is never built, and the Code Vision settings list Piwi's lines under no name. Onboarding
    is one balloon, once per installation, never shown to those workspaces, where VS Code opens a walkthrough.
    **(seen)**; the onboarding **(read)**.

---

## 1. Method

Eight finder slices, one per area, read the code and the manifests. An adversarial verifier read each slice: of 195
findings, 194 were kept (122 confirmed, 47 amended with the verifier's correction, 25 added by the verifiers) and 1
refuted. Clustered by theme, they gave 134 clusters, 15 of them merged across themes: the 119 findings of §2 (X1 to X3)
and §3 to §9.

Two hands-on runs drove Rider 2026.2.4.1 and VS Code 1.143.1 under Xvfb against the editor fixture, with the plugin and
the extension built at this commit; a scratch platform test listed the actions of `Piwi.Actions`, `EditorPopupMenu`,
`GenerateGroup` and `NewGroup` in WebStorm 2024.1. Platform facts were read from the 241 and 262 jars
(`PlatformIconMappings.json`, the bundled keymaps resolved with their parents, `javap`) and from the platforms' UI
guidelines.

Not covered: macOS and Windows; a fixture with a real `@playwright/test`, so the IDE run icon was never drawn; C# files
in Rider; a screen reader in JetBrains; Firefox for Piwi Picker. The screenshots stay outside the repository, cited only
as **(seen)**.

---

## 2. One Piwi across tools: the principles

Piwi reaches a developer in six tools: the dashboard, Piwi Picker, the desktop app, VS Code, the JetBrains IDEs and,
since v0.68.0, Piwi Runner (`apps/runner`), the small app that runs a team instance's requests on the person's machine.
These rules hold them together; each larger item of §10 carries one or more.

1. **One name per concept, from the action catalog and a words table that both manifests and both clients are tested
   against; only each platform's casing differs.** ([AC7](#ac7), [AC11](#ac11), [X1](#x1))
2. **One glyph per concept and one meaning per glyph, from the concept table; a glyph no platform has, Piwi draws
   once.** ([IC2](#ic2), [IC5](#ic5), [IC7](#ic7), [IC9](#ic9))
3. **One outcome palette: `STATUS_COLORS` and the dashboard's status glyphs, generated into each tool and tested like
   `coverage-mark-colors.test.ts`; flaky, quarantine and history always drawn.** ([IC3](#ic3), [IC4](#ic4),
   [TL13](#tl13))
4. **One menu shape (Run, Record, Run Control, Dashboard, Agents, Connection, each showing what applies now) and one
   home per editor, with the same tabs, toolbar order and empty states.** ([AC1](#ac1), [AC2](#ac2), [HM1](#hm1),
   [HM6](#hm6))
5. **The IDE's own places first, with Run, Debug and Coverage meaning what the IDE means; Piwi's own marks only for what
   the IDE cannot show.** ([TL2](#tl2), [TL3](#tl3), [LR3](#lr3), [AC3](#ac3))
6. **The service words and decides, the clients draw, and a contract test fails when the service sends an icon key a
   client lacks.** ([AC11](#ac11), [TL10](#tl10), [HM8](#hm8), [HM16](#hm16))
7. **Registered and discoverable: every Piwi entry in a JetBrains popup is a registered action, every VS Code command
   has an icon and a when clause.** ([AC6](#ac6), [ST10](#st10), [AC4](#ac4))
8. **Quiet, and switchable where the IDE keeps its switches: an alarm only for what the developer's own work caused, one
   interruption, and an off switch for every mark.** ([HM2](#hm2), [HM15](#hm15), [ST8](#st8), [TL4](#tl4))
9. **Checked where it is used: both editors compared on the editor fixture without a JetBrains license, a Rider scene on
   `examples/sample-app`'s ASP.NET Core backend, and docs that claim only what a check holds.** ([TL16](#tl16),
   [TL13](#tl13), [LR6](#lr6), [RD4](#rd4))

<a id="x1"></a>**X1. Every editor action is named, iconed and placed by hand twice, so the two editors drift and no
check catches it.** `apps/vscode/package.json:165-476` declares 58 commands, 38 without an icon; `plugin.xml:89-260`
declares 43 actions, 20 without one. End the test reads 'End the test here, skipping the rest of it'
(`package.json:409`), 'End the Test' (`plugin.xml:211`), 'End Test' (`Glue.kt:1948`) and 'End test'
(`apps/vscode/src/run-control.ts:801`). Four JetBrains popups build unregistered actions ([AC6](#ac6)), and a stop's
controls are chosen twice ([AC11](#ac11)). No test compares the manifests. **(seen, counted)** Fix: the action catalog
of [LI1](#li1), tested against both manifests. ([M1](#m1), [LI1](#li1))

<a id="x2"></a>**X2. The same concept is drawn differently in each Piwi tool, and no table or test ties the glyphs
together.** Record is a gray film strip in JetBrains, `$(record)` in VS Code and a dot in Piwi Picker ([IC2](#ic2));
flaky is a warning, an amber '!' and a fuchsia shuffle ([IC4](#ic4)); failed is amber in the JetBrains gutter and red in
its tree ([IC3](#ic3)); Connect is a person there and a plug elsewhere ([IC7](#ic7)). Only the coverage colors are
tested (`apps/application/tests/unit/coverage-mark-colors.test.ts`). **(seen)** Fix: the concept table of
[Appendix A](#appendix-a-the-concept-table-first-draft), the missing glyphs drawn once and generated into each tool
under the concept-table test and a `status-mark-colors.test.ts` beside `coverage-mark-colors.test.ts`. ([M4](#m4),
[LI2](#li2))

<a id="x3"></a>**X3. The everyday actions sit in different places and orders in each tool.** A click on the status item
opens the status popup in JetBrains (`PiwiStatusBar.kt:167-203`) but refreshes in VS Code
(`apps/vscode/src/extension.ts:673-678`), whose tooltip offers nothing to run, record or re-run ([HM1](#hm1)); the two
editor menus hold Piwi's entries in different orders ([AC2](#ac2)); Piwi Picker's popup and the desktop app's tray keep
lists of their own. **(seen)** Fix: [LI4](#li4)'s one Piwi menu, opened by the status item in both editors and as a Piwi
submenu in each context menu; Piwi Picker and the tray take the same order and words. ([M3](#m3), [LI4](#li4))

**What 1.0 allows.** [1.0-stabilization.md](1.0-stabilization.md) D25 freezes the ids it lists, those keymaps and
settings name: eight VS Code command ids beside the service's, the settings `piwi.serverUrl` and `piwi.project`, seven
JetBrains action ids, the tool window and status bar widget ids, and the plugin's 2024.1 floor. Titles, icons, menus and
their order are not in it, so they may change before 1.0 and after. Every command id, action id and setting key this
plan adds is registered in D25 before 1.0; D25 and the editor guides already disagree on what else it freezes (#1124).

## 3. Icons and the visual language

What works: all 36 AllIcons constants the plugin references exist on 241 and 262 and none is deprecated, and the
coverage marks are one palette across the dashboard and both editors, held by
`apps/application/tests/unit/coverage-mark-colors.test.ts`. **(read)** The rest is one concept drawn several ways, one
glyph with several meanings, and actions with none. [Appendix A](#appendix-a-the-concept-table-first-draft) drafts the
concept table.

### 3.1 Actions without a glyph

<a id="ic1"></a>**IC1. Half the actions in both editors have no icon: 20 of 43 JetBrains actions and 38 of 58 VS Code
commands, the stop's code actions in both among them.** The bare ones include Disconnect, Verify ×3, Run This Spec,
Pair, the Copy MCP actions, v0.68.0's Pause and Watch in both editors, and the five code actions at a stop in
`plugin.xml:91-256`, and Record, the recording controls and the same five in `apps/vscode/package.json`. In Rider, Tools
→ Piwi alternates iconed and bare rows, and at a stop Pick, Record, Assert, Assert a region and Mock are plain words in
both editors' popups (`PiwiRunControl.kt:1173-1180`, `apps/vscode/src/run-view.ts:869-872`), though the Runs window
draws all five (`apps/extension/src/runs/main.ts:1764-1768`). **(counted, seen)** Fix: each action takes its glyph from
the concept table, a platform icon where one fits and a Piwi glyph otherwise, the stop's code actions and VS Code's
quick-pick labels included. VS Code's context menus draw no icons, so its gain is in quick picks, title bars and inline
rows ([AC5](#ac5)). ([Q9](#q9), [LI2](#li2))

### 3.2 Recording

<a id="ic2"></a>**IC2. Recording has no glyph of its own in JetBrains: the IDE's gray macro film strip, with no New UI
variant, marks every recording entry point, and recording's Pause, Resume and Stop reuse the run's debugger glyphs.**
`AllIcons.Ide.Macro.Recording_1`, a `#6E6E6E` film strip with no entry in the 241 or 262 `PlatformIconMappings.json`,
marks Record Here, Record a New Test File and the Generate entry (`plugin.xml:156, 163, 255`), the recorded block's
gutter mark (`PiwiRecording.kt:720`) and its banner (`PiwiRecordingViews.kt:33`), paused or not. Pause, Resume and Stop
Recording draw `Actions.Pause`, `Resume` and `Suspend` (`plugin.xml:176, 182, 168`), as the run's three do (`:196, 199,
247`), in the same Tools → Piwi menu. The other tools mark a recording their own way: VS Code tints the block in the
running blue with no gutter mark and shows a paused recording with `$(debug-pause)`, a held run's glyph
(`apps/vscode/package.json:1008-1014`, `apps/vscode/src/glue.ts:1077-1102`); Piwi Picker shows a red dot, gray when
paused (`apps/extension/src/content/record-panel.ts:627-630`). **(seen)** Fix: one record family drawn from Picker's
dot, red while recording and gray when paused: Appendix A's three record rows on every recording surface and control in
both editors, and the run's glyphs for the run alone. [record-from-the-ide.md](record-from-the-ide.md) Part 2 puts "●
Recording" in the status bar and names no icon. ([M4](#m4), [LI2](#li2))

### 3.3 Outcomes

<a id="ic3"></a>**IC3. JetBrains draws a failing test as an amber X in the gutter and the status item but a red '!' in
the tool window and at a held stop, while failing is red in every other Piwi tool.** The result icon and the status item
draw `RunConfigurations.TestFailed` (`PiwiTestAnnotator.kt:103`, `PiwiStatusBar.kt:155`), an amber X in both UIs on 241
and 262, the amber of the warning icon that marks flaky (`PiwiTestAnnotator.kt:104`); the tree draws `General.Error`
(`PiwiFailuresToolWindow.kt:392`) and a held failure `TestError` (`PiwiRunControl.kt:1847`), both a red '!'. **(seen)**
Fix: one red failed mark on every JetBrains surface, from one map in `Glue.kt`: the platform's `TestError` or a red X
from the outcome palette (an open question), with `General.Error` kept for diagnostics and flaky given its own mark
([IC4](#ic4); VS Code's held failure: [LR5](#lr5)). ([Q9](#q9), [M5](#m5), [LI3](#li3))

<a id="ic4"></a>**IC4. Flaky has five marks and four colors across Piwi's tools, and amber, its color in both editors,
means "did not run" on the dashboard and "paused" in the desktop tray.** Flaky is an amber '!' in VS Code
(`apps/vscode/media/test-flaky.svg`), the inspection warning in JetBrains (`PiwiTestAnnotator.kt:104`), a fuchsia
shuffle on the dashboard (`apps/application/app/utils/index.ts:314-315`), a '~' in the editor service's hover
(`packages/editor/src/server.ts:628-637`) and a purple dot in Piwi Picker
(`apps/extension/src/content/results-panel.ts:170`). `apps/application/shared/status-colors.ts:42` makes amber
`didnotrun`, and the tray's dot is amber for paused or interrupted (`apps/desktop/src-tauri/src/lib.rs:521-530`). VS
Code's marks use GitHub hues, and no test holds any of these copies to STATUS_COLORS. **(seen)** Fix: [LI3](#li3)'s
outcome palette in every tool, and the word "flaky" in the hover. Codicons have no shuffle, so VS Code needs
`$(piwi-flaky)` ([IC8](#ic8)); VS Code also hides the flaky mark while the Testing view is on ([TL13](#tl13)).
([Q2](#q2), [M5](#m5), [LI3](#li3))

### 3.4 Run controls

<a id="ic5"></a>**IC5. Run-control glyphs collide across tools: the square stops the run in the editors and the tray but
ends the test in the Runs window and the desktop worker, and Step and Finish trade shapes.** The square is Stop the run
in VS Code, JetBrains and the tray (`apps/vscode/src/run-control.ts:988`, `plugin.xml:247`,
`apps/application/app/components/desktop/DesktopLocalRunsTray.vue:279`) but End the test in the Runs window
(`apps/extension/src/runs/main.ts:1762`) and the desktop worker
(`apps/application/app/components/desktop/DesktopRunWorker.vue:85`), shown in the same tray card as the run's Stop, and
v0.68.0's End the test while a Pause waits is a square there too (`runs/main.ts:1763`, `DesktopRunWorker.vue:89`); the
editors end a test with a circle and a slash (`apps/vscode/src/run-control.ts:1001`). The desktop app's Step and Finish
(`step-forward`, `skip-forward`, `DesktopRunWorker.vue:79, 83`) are both a triangle and a bar, as is the Runs window's
Finish. **(seen)** Fix: one debugger glyph per control in the four tables: Step step-over, Finish step-out, End the test
circle-slash (Appendix A), the square for stopping the run alone, and broadcast for Share live ([LR14](#lr14)).
[developer-loop-audit.md](developer-loop-audit.md) §9 gives each control one word, not one glyph. ([M6](#m6),
[LI2](#li2))

<a id="ic6"></a>**IC6. The pause bar every headed stop shows orders its buttons differently from the editors, the Runs
window and the desktop app, and draws no glyphs.** `packages/picker-dom/src/overlay-pause.ts:105-147` puts Pick a
locator and Record here between Step and Finish, as text buttons; every other surface puts Resume, Step, Finish and End
first, then the code actions (`apps/extension/src/runs/main.ts:1758-1797`,
`apps/application/app/components/desktop/DesktopRunWorker.vue:77-108`, `apps/vscode/src/run-control.ts:793-802`).
**(read)** Fix: the same order, a divider before the code actions, and [IC5](#ic5)'s glyphs drawn anew in `picker-dom`
(MIT) for Piwi Picker to import, since its `apps/extension/src/shared/icons.ts` is FSL. ([M6](#m6), [LI2](#li2))

### 3.5 Connect, the Piwi mark, the tree and the globes

<a id="ic7"></a>**IC7. Connect is a plug in VS Code, Piwi Picker and the dashboard but the IDE's person glyph in
JetBrains, which the same toolbar also uses for Group by Owner.** `AllIcons.General.User` marks Connect
(`plugin.xml:92`) and Group by Owner, both in the tool window's toolbar (`PiwiFailuresToolWindow.kt:186, 200`), and the
status item's "Piwi: connect" beside a person (`PiwiStatusBar.kt:152`) reads as signing in. **(seen)** Fix: plugin
`connect.svg` and `disconnect.svg` drawn from Picker's `plug` and `unlink`
(`apps/extension/src/shared/icons.ts:128-129`, FSL to FSL), `General.User` kept for the sign-in dialog and Group by
Owner, and `$(plug)` and `$(debug-disconnect)` on VS Code's two commands. ([M4](#m4), [LI2](#li2))

<a id="ic8"></a>**IC8. Piwi's own mark is off-style or missing in both editors: one 13 px filled JetBrains glyph with no
New UI sizes, and no Piwi glyph in VS Code's status item or Failures view.**
`apps/application/scripts/generate-brand-assets.mjs:210-211` writes the plugin's 13 × 13 filled marks, the only heavy
filled shapes among Rider's New UI stripe and status icons, with no `expui` set or `iconMapper`. VS Code's
`piwi.failures` view has no icon (`apps/vscode/package.json:60-66`), there is no `contributes.icons`, and the idle
status item borrows the Testing view's `$(beaker)` (`apps/vscode/src/glue.ts:197, 266`). **(seen)** Fix: the generator
also writes an outline mark at 16 and 20 px, a `PiwiIconMappings.json` for every plugin SVG of this section, and a VS
Code product-icon font with `$(piwi)` and the glyphs codicons lack.
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 gave the status item an icon, not these sizes.
([M4](#m4), [LI2](#li2))

<a id="ic9"></a>**IC9. Failure-tree icons disagree: JetBrains draws spec, cluster and owner as folders and a past run as
the green Run arrow, VS Code uses other glyphs, and the dashboard's cluster glyph means "Assert a region" in the desktop
app.** `PiwiFailuresToolWindow.kt:388-396` maps the three groupings to `Nodes.Folder` and lets a run fall to `else`, the
gutter's play (12 px, 14 px in the New UI), though a double-click on "Run #124" opens a page; VS Code draws a run as
`beaker` and a cluster as `symbol-namespace` (`apps/vscode/src/glue.ts:377-389`). Lucide `layers` marks the Failures tab
and its cluster groups on the dashboard (`apps/application/app/layouts/default.vue:380`) and Assert a region in the
desktop worker and the Runs window (`apps/application/app/components/desktop/DesktopRunWorker.vue:101`,
`apps/extension/src/runs/main.ts:1767`). **(seen)** Fix: one node table for both editors, its run node the 16 px Piwi
mark ([IC8](#ic8)) and its cluster `layers` (a plugin SVG: `Nodes.Related` has no New UI mapping on 241), with no Kotlin
`else`; Assert a region takes Picker's `viewport` corners. ([M4](#m4), [LI2](#li2))

<a id="ic10"></a>**IC10. One globe stands for two actions in both editors, Open in Dashboard and Open the Latest Run,
side by side in the JetBrains toolbar.** Both are `$(globe)` in VS Code (`apps/vscode/package.json:228-238`) and
`General.Web` in JetBrains (`plugin.xml:134-139`). **(read)** Fix: Open in Dashboard takes the external-link glyph the
dashboard uses for leaving a tool (`Ide.External_link_arrow` / `$(link-external)`), and the latest run the run node's
([IC9](#ic9)). ([Q9](#q9), [LI2](#li2))

### 3.6 Hand-offs

<a id="ic11"></a>**IC11. Hand-offs carry a glyph at the dashboard end but none at the editor end: Reproduce, Find the
breaking commit, Open the trace and Open the screenshot are bare text in JetBrains.** The dashboard draws play,
git-branch and a camera (`apps/application/app/components/shared/ReproduceSection.vue:189, 226`,
`apps/application/app/components/test-case/EvidenceTabs.vue:214`); JetBrains passes a null icon for all four
(`PiwiFailuresToolWindow.kt:346-347, 358-359`), and VS Code draws the trace and the screenshot but not reproduce or
bisect. **(read)** Fix: one glyph per hand-off at both ends: `FileTypes.Archive` / `$(file-zip)`, a camera
(`FileTypes.Image` / `$(device-camera)`), a monitor (`Nodes.Desktop` / `$(device-desktop)`) and `Vcs.Branch` /
`$(git-branch)`. ([Q9](#q9), [M24](#m24), [LI2](#li2), [LI20](#li20))

## 4. Menus, actions, keys and names

### 4.1 Menus

<a id="ac1"></a>**AC1. Tools → Piwi is one popup of 42 actions with three separators, and about half of it is grayed out
whenever no run or recording is live.** `plugin.xml:89-253` separates `Piwi.Actions` only at `:154`, `:187` and `:249`,
and the group is not compact, so the 18 run controls, whose `update` sets only `isEnabled`, are drawn disabled. In Rider
2026.2.4.1, 20 rows were gray at rest at v0.66.0 (22 by the code at v0.68.0, with Watch and Pause and Watch), Settings…
sits below a scroll arrow, and the daily actions sit among four MCP rows. **(seen)** Fix: `compact="true"` first (the
debugger keys still reach the actions), then nested groups in [LI4](#li4)'s six sections, which the status popup
([HM3](#hm3)) and VS Code's status menu ([HM1](#hm1)) take too. ([Q3](#q3), [M3](#m3), [LI4](#li4))

<a id="ac2"></a>**AC2. Right-clicking a spec shows Piwi's entries loose in both editors, unbranded in VS Code, in
different orders, and in VS Code just above VS Code's own entries that start the same run.**
`apps/vscode/package.json:636-682` puts nine commands in one unlabeled group, six of them at rest, four sorted by title,
and gates Run the tests that reach this file on `piwi.active` alone (`:655`), so it shows in Markdown. They sit right
above VS Code's Run Test at Cursor, which runs the default Testing profile, Run with Piwi
(`apps/vscode/src/test-explorer.ts:117`), while `piwi.testExplorer` is on (read, not run). JetBrains adds eight actions,
five of them at rest, at the bottom of a menu of about 50 rows (`plugin.xml:99-185`), all but Run the Tests That Reach
This File prefixed `Piwi: `. **(seen)** Fix: one Piwi submenu in both, same order: Run | Record | the recording's
controls | Run Control while stopped ([LR3](#lr3)), Run Tests That Reach This File only on files the service reads; VS
Code's Run Test at Cursor stays the root entry while the Testing view runs Piwi. ([Q3](#q3), [LI4](#li4))

<a id="ac3"></a>**AC3. Neither editor offers Piwi in the file tree, Rider's Solution Explorer or its Tests menu, and New
offers Record a New Test File… in JetBrains only.** `plugin.xml` adds to `ToolsMenu`, `EditorPopupMenu`, `NewGroup` and
`GenerateGroup` only, and `apps/vscode/package.json:477-802` has no `explorer/context` or `file/newFile`, though Run
This Spec and Run the Tests That Reach This File take a file in both clients. In Rider 2026.2.4.1 a folder's menu offers
the IDE's Run Tests in tests/ and Solution Explorer's offers Run Unit Tests, with nothing from Piwi in either, and Add
lists Record a New Test File… among the file kinds, on C# project folders too, since it needs only a Playwright config
in the project (`PiwiRecordingActions.kt:101-104`). **(seen)** Fix: one Piwi submenu on files and folders in both, the
same group in Solution Explorer and the Tests menu through an optional Rider descriptor, and New → Playwright Test
(Recorded)…, which [record-from-the-ide.md](record-from-the-ide.md) Part 2 plans, on config folders only. ([M3](#m3),
[M17](#m17), [LI4](#li4), [LI16](#li16))

<a id="ac4"></a>**AC4. VS Code's palette lists 21 Piwi commands to a user who is not connected, and Open the latest run,
Open in dashboard and Refresh the latest run then do nothing visible.** `apps/vscode/package.json:478-635` gives 19
commands no `when`, and `openRun` and `openInDashboard` return silently without a status URL
(`apps/vscode/src/extension.ts:1214-1217`, `:1262-1264`). In JetBrains, Open in Dashboard, Re-run the Failing Tests and
Run Selection… have no `update` (`PiwiActions.kt:141-168`, `:249-296`) and look enabled with nothing to act on.
**(seen)** Fix: the run-reading commands gated on the connection in both clients; a command reached anyway answers
"Piwi: connect to an instance first" with Connect…, from one helper ([HM7](#hm7) is the view's half). ([Q7](#q7),
[LI4](#li4))

### 4.2 The editor title

<a id="ac5"></a>**AC5. A spec's editor title bar in VS Code has no Piwi button, and the 13 commands that would go there
have no icon while ten of their JetBrains twins have one.** `apps/vscode/package.json:477-802` contributes no
`editor/title` or `editor/title/run`, so a spec shows Split Editor and More Actions only, during a stop too. Both Record
commands, the recording's three controls, the four runs from the editor, Run to the cursor, the paused page, Connect and
Open settings carry no `icon`; `plugin.xml:91-252` draws all but Verify ×3, Run This Spec and the file's tests
([IC1](#ic1)). **(seen)** Fix: a codicon per command from the concept table; Run Spec with Piwi, Run Test with Piwi and
Verify ×3 in `editor/title/run` on a spec, and one state icon in the title (Stop Recording, or Resume at a stop) with
the other controls in its overflow ([LR3](#lr3)). ([Q9](#q9), [Q10](#q10))

### 4.3 Registered and discoverable

<a id="ac6"></a>**AC6. Piwi's JetBrains popups are built from unregistered actions, so their keys never show, Find
Action cannot reach them and they cannot be bound.** The stop line's popup builds Resume, Step, Finish and the code
actions anew (`PiwiRunControl.kt:1155-1192`) beside the registered `Piwi.ResumeRun` to `Piwi.FinishRun`, which carry the
debugger's keys (`plugin.xml:198-209`). The result icon's menu (`PiwiTestAnnotator.kt:128-137`), four status-popup rows
and, since v0.68.0, one Go to row per stop (`PiwiStatusBar.kt:224-292`, [LR4](#lr4)) and the failures tree
([HM11](#hm11)) are built the same way. At a stop the popup never shows F9, F8 or Shift+F8, and with no `<synonym>` in
`plugin.xml`, Find Action finds nothing for codegen or trace. **(seen)** Fix: one registered `Piwi.RunControl` group
wherever a stop's controls appear ([LR3](#lr3)), reading the clicked stop from a `DataKey`; the result icon's menu built
from `Piwi.RunTestAtCursor` and `Piwi.VerifyTestAtCursor`, new ids for the rest, and synonyms such as Playwright
Codegen. ([M2](#m2), [LI1](#li1))

### 4.4 Names

<a id="ac7"></a>**AC7. The two clients name at least fourteen shared actions differently, End the test alone has four
spellings, and each lacks commands the other has.** Eleven pairs between `apps/vscode/package.json:165-476`,
`plugin.xml:91-252` and the JetBrains status popup and failures tree (`PiwiStatusBar.kt:241`,
`PiwiFailuresToolWindow.kt:347`) are new beside [developer-loop-audit.md](developer-loop-audit.md) §9, whose Pick, Run
to a line and Finish rows make fourteen (here: Pick at Stop, Run to Cursor as the IDE's debugger says it, Finish Test).
Only VS Code has Write code at the stop…, Get started, Open the log and Follow the active editor, only JetBrains Open
the Failures and Node.js Settings…, and `apps/docs/features/editors.md:105-130` lists VS Code's names alone. **(seen)**
Fix: one wording per action, only the casing per platform, from the action catalog both manifests are tested against.
([M1](#m1), [LI1](#li1))

| Action | VS Code title | JetBrains text | Proposed wording |
|---|---|---|---|
| Coverage marks | Toggle the coverage marks | Show Coverage Marks | Show Coverage Marks |
| The run shown | Open the latest run | Open the Latest Run in the Dashboard | Open Latest Run |
| Read it again | Refresh the latest run | Read the Latest Run Again | Refresh Latest Run |
| Screenshot | Open the failure screenshot | Open the Screenshot | Open Screenshot |
| End | End the test here, skipping the rest of it; End test | End the Test; End Test | End Test |
| Record at a stop | Record in the stopped test's page | Record Here at the Stop | Record at Stop |
| Assert | Assert in the stopped test's page | Assert at the Stop | Assert at Stop |
| Region | Assert a region of the stopped test's page | Assert a Region at the Stop | Assert Region at Stop |
| Mock | Mock a request of the stopped test | Mock a Request at the Stop | Mock at Stop… |
| Connect | Connect | Connect… | Connect… |
| Settings | Open settings | Settings… | Settings… |

<a id="ac8"></a>**AC8. VS Code's command titles are in sentence case in a palette where VS Code's own commands, Piwi's
generated view commands and the JetBrains plugin use Title Case.** All 58 titles in `apps/vscode/package.json:165-476`
are sentence case, so the palette shows Piwi: Focus on Failures View, generated by VS Code, beside Piwi: Open the latest
run; VS Code's guidance asks for Title Case, and [editor-extensions-audit.md](../adr/editor-extensions-audit.md) §3.6
judged the split good. **(seen)** Fix: Title Case without leading articles for command and action labels in both IDEs,
sentence case for messages and tooltips in every tool; reversing §3.6 is the maintainer's call. ([M1](#m1), [LI1](#li1))

<a id="ac9"></a>**AC9. Record here names two different actions on a paused line, and inside JetBrains each stop control
carries up to three labels.** VS Code's stop hover says Record here for a recording in the stopped test's browser
(`apps/vscode/src/run-control.ts:842-843`), and the context menu on the same line Record here for a new browser at the
caret (`apps/vscode/package.json:349`). JetBrains says Finish the Test in Tools → Piwi but Finish on the stop line
(`Glue.kt:1947`), calls one code action Record Here at the Stop in Tools → Piwi, Record Here in the stop's popup and
Record on the inlay (`Glue.kt:1976`), and lists Record Here at the Stop beside Record Here in the status popup during a
stop (`PiwiStatusBar.kt:199`, `:269-274`). **(seen)** Fix: a full name and a short label per control in the action
catalog (Finish Test and Finish), with Record Here for the caret only. ([M1](#m1), [LI1](#li1))

<a id="ac10"></a>**AC10. Labels that mislead: look-alike refreshes in both clients, a Run selection… that runs a saved
selection rather than the selected text, and uneven ellipses.** VS Code lists Refresh beside Refresh the latest run
(`apps/vscode/package.json:193`, `:198`; Run selection… at `:224`), JetBrains' status popup Read the Latest Run Again
beside Refresh with one icon, and Record Here opens a dialog with no ellipsis (`plugin.xml:155`). **(seen)** Fix:
Refresh Latest Run (a new `Piwi.RefreshRun`), Reload Piwi (`piwi.refresh`, `Piwi.Refresh`) and Reconnect on the settings
page ([ST18](#st18)), each with its own icon; Run Saved Selection…; an ellipsis wherever input follows. ([Q8](#q8),
[M1](#m1), [LI1](#li1))

<a id="ac11"></a>**AC11. The status, stop and recording words exist twice, in `glue.ts` and `Glue.kt`, with no test
between them, and have already drifted.** `apps/vscode/src/run-control.ts:795-802` says Run to cursor and End test where
`Glue.kt:1942-1948` says Run to Caret and End Test, and a paused recording reads "paused · N"
(`apps/vscode/src/glue.ts:1066-1102`) or "recording paused · N" (`Glue.kt:2599-2604`). **(read)** Fix: the editor
service sends the words and the clients map only icons and casing; the rest comes from the words table of [LI1](#li1),
held by a test over both clients ([LR15](#lr15), [LR17](#lr17)). ([M22](#m22), [LI1](#li1), [LI6](#li6))

### 4.5 Keys

<a id="ac12"></a>**AC12. Piwi's three Ctrl+Alt+Shift chords are already taken in the Visual Studio, Visual Studio 2022,
ReSharper and Visual Assist keymaps that Rider ships, one by Silent Code Cleanup, and no key opens the Failures in
either editor.** `plugin.xml:108`, `:126`, `:160`, `:173` bind K, F and R in `$default` only; the table lists what Rider
2026.2.4.1's keymaps, resolved with their parents, bind to them (which action wins was not checked), and
`apps/vscode/ARCHITECTURE.md:738-740` names the Rider keymaps' letters but not their actions, and plans no remedy.
Nothing binds the Piwi tool window or the Failures view, though
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

### 4.6 Names across tools

<a id="ac13"></a>**AC13. The desktop app runs as Piwi Dashboard in the OS, its window and its tray, while the editors
and Piwi Picker call it the desktop app.** `apps/desktop/src-tauri/tauri.conf.json:3`, `:14` name the product and the
window Piwi Dashboard, and the tray says Open Piwi Dashboard (`apps/desktop/src-tauri/src/lib.rs:3352-3381`), while VS
Code says The Piwi desktop app (`apps/vscode/src/glue.ts:725`) and, since v0.68.0, the dashboard's Run on my machine
says Piwi Desktop (`apps/application/app/components/run-requests/RunOnMyMachineButton.vue:195`). A user told to open the
desktop app finds no such name in the Start menu, the Dock or the tray. **(read)** Fix: Piwi Desktop in the window, tray
and notifications now, the product name once the installers' upgrade path is checked (the identifier stays), held by a
test against `ECOSYSTEM_PIECES`. ([Q23](#q23), [LI20](#li20))

<a id="ac14"></a>**AC14. The dashboard says Open in IDE and Debug in my editor side by side for one destination, and its
IDE menu does not say which entry reaches Piwi's plugin.** Both sit on one stack-frame row
(`apps/application/app/components/test-case/TestSourceStack.vue:53-61`), and JetBrains (URL) and JetBrains (local
server) (`apps/application/app/components/shared/OpenInIdeLink.vue:180`, `:191`) hide that every JetBrains method asks
the Piwi plugin first. **(read)** Fix: Open in editor wherever the dashboard says Open in IDE, and entries named VS Code
(Piwi extension) and JetBrains (Piwi plugin). ([Q22](#q22), [LI20](#li20))

<a id="ac15"></a>**AC15. Pairing Piwi Picker is Pair in the editors and in Piwi Picker but Connect Piwi Picker in the
desktop app, where Connect is the editors' word for choosing an instance.**
`apps/application/app/components/desktop/DesktopPickerCard.vue:20` titles the Setup card Connect Piwi Picker, and two of
Picker's hints send people there. **(read)** Fix: Pair with Piwi Picker, with Picker's link glyph, the hints changed in
every catalog. ([Q23](#q23), [LI20](#li20))

### 4.7 Run This Spec

<a id="ac16"></a>**AC16. Run This Spec runs only the tests the instance already knows: a new spec is refused and a test
just written is left out without a word.** Both clients run `spec.testIds` (`apps/vscode/src/extension.ts:1013-1023`,
`PiwiCommands.kt:196-205`), "the spec's tests Piwi knows" (`packages/editor/src/protocol.ts:135-136`), while the test at
the cursor runs by location with no instance; VS Code hides the command without one. **(read)** Fix: `piwi/testAt`
answers each `test(` call's location as the file stands and the spec runs by location, in one pull request across the
protocol, both clients and `apps/docs/features/editors.md:117`. ([Q20](#q20))

## 5. The test line

What works: both editors draw the same answer per line from the editor service (`piwi/fileSummary`), so the pass rate,
the failing line and the evidence are the same data in Rider and in VS Code. **(read)** What differs is what a click
does, what the line says and which marks it carries.

<a id="tl1"></a>**TL1. VS Code's Testing view carries Piwi's results and none of its actions, and in both editors the
IDE's own test UI is mostly unused.** `apps/vscode/src/test-explorer.ts:117-125` creates two Run-kind profiles and no
Debug or Coverage profile, `apps/vscode/package.json` contributes no `testing/*` menu, and coverage is drawn as Piwi's
own decorations, outside the Test Coverage view; in JetBrains the IDE run icon has no Piwi entry. **(seen)** Fix: each
IDE's test UI as Piwi's home, Run, Debug and Coverage meaning what the IDE means, and Piwi's own marks kept for flaky,
quarantine and history, which no IDE shows ([editor-extensions-audit.md](../adr/editor-extensions-audit.md) L1 built the
view results-only). ([L2](#l2), [LI8](#li8))

### 5.1 The gutter and its menus

<a id="tl2"></a>**TL2. From a test's own gutter icon, neither editor offers more than Run and Verify ×3: JetBrains' left
click opens a browser, and VS Code's Testing menus have no Piwi entry.** A left click on the result icon runs
`piwi.openInDashboard` (`PiwiTestAnnotator.kt:113-121`), and its right-click menu holds two anonymous actions
(`:127-138`) duplicating `Piwi.RunTestAtCursor` and `Piwi.VerifyTestAtCursor`, so no key shows ([AC6](#ac6)). VS Code's
Testing gutter offers Run Test and Execute Using Profile…, since `apps/vscode/package.json:477` declares no
`testing/item/*` or `testing/message/*` menu, and the hover links Run and Open in dashboard
(`apps/vscode/src/glue.ts:528-541`). From the gutter, nobody can open its trace, hand it to an agent, debug it or record
into it, and in Rider the click that runs a test on the IDE run icon opens a browser on Piwi's. **(seen)** Fix: one
ordered action list per test line from the service, in five groups ([LI7](#li7)), opened by either click in JetBrains
from registered actions, and placed in VS Code's `testing/item/gutter`, `testing/item/context` and
`testing/message/context`. ([M7](#m7), [LI7](#li7))

<a id="tl3"></a>**TL3. The IDE run icon on a JS test carries no Piwi action, so a test with no Piwi result yet cannot be
run with Piwi from its line.** Without an instance, or for a test the catalog lacks, the service sends no result
(`packages/editor/src/server.ts:2846, 2878`), so a new test has no result icon. In WebStorm 2024.1,
`JSTestRunLineMarkersProvider` fills the IDE run icon's menu from the empty `JSTestRunLineMarkersAdditionalActionGroup`
(`js-testing.xml:17, 75`), and the icon starts the IDE's own run, which Piwi follows with no Stop. The fixture's
`@playwright/test` is a stub, so neither hands-on run drew the icon. **(read)** Fix: Piwi's test actions added to that
group, hidden outside a config's folder, checked in Rider 2026.2 and every IDE of `verifyIdes` against a real
`@playwright/test`: the remaining half of [developer-loop-audit.md](developer-loop-audit.md) P1. ([M9](#m9),
[LI7](#li7))

<a id="tl4"></a>**TL4. In JetBrains a test line can carry two state icons that disagree, the IDE's last local run and
Piwi's latest, and Piwi's cannot be switched off.** The IDE run icon draws its last run from `TestStateStorage`, and
`PiwiTestAnnotator.kt:63-66` adds Piwi's, whose tooltip does not say whose run; the Gutter Icons settings page lists
`LineMarkerProviderDescriptor`s, not an annotator's icon ([ST8](#st8)). A green check from the developer's run can sit
beside an amber X from CI. **(read)** Fix: a "Piwi test results" entry on the Gutter Icons page, a descriptor whose
switch the annotator reads, and a tooltip naming the run ("failing in CI run #124"). ([M9](#m9), [LI8](#li8))

<a id="tl5"></a>**TL5. A running test is drawn with each IDE's "run this test" glyph, and in JetBrains a click on it
opens a browser.** `PiwiTestAnnotator.kt:107` draws `TestState.Run`, the IDE run icon's own glyph, with the dashboard on
its click (`:113-121`), so a running line can show two green triangles; VS Code's `apps/vscode/media/test-running.svg`,
shown with the Testing view off, is a play triangle on a blue disc, while the dashboard spins a loader ring
(`apps/application/app/utils/index.ts:318-321`). **(read)** Fix: the outcome palette's running ring, animated where the
gutter allows it (an open question for JetBrains), its click opening [TL2](#tl2)'s popup. When the mark appears, from
local events, is the live-run study's P4 ([LR9](#lr9), live-runs E3). ([M5](#m5), [LI3](#li3))

<a id="tl6"></a>**TL6. With the Testing view off, VS Code's gutter mark cannot be clicked, and a test with no recent
result gets no mark or hover.** The mark is a decoration with no menu (`apps/vscode/src/extension.ts:439-447`), and
`gutterIcons` has no `unknown`, the status of did-not-run, never-run and interrupted
(`packages/editor/src/server.ts:600-602`). **(seen)** Fix: an `unknown` mark in the did-not-run glyph, and Piwi's test
actions in `editor/lineNumber/context` behind a `piwi.testLines` context key. ([Q2](#q2), [M7](#m7), [LI7](#li7))

### 5.2 One role per surface

<a id="tl7"></a>**TL7. Nine surfaces act on a failing test, each with its own subset of actions and words, and the quick
fixes mix navigation with edits under no Piwi name.** In VS Code: the Testing gutter, the hover, the lens row
(`packages/editor/src/server.ts:2927-2957`), five quick fixes (`server.ts:2481-2568`), the editor menu, the Failures
view and the profiles; in JetBrains, the result icon and the Piwi tool window. Run has five names (Run with Piwi, Run
this test, Run This Test, Run, Run the test at the cursor), Verify ×3 is missing from the hover and the lens, and the
quick fixes, all `CodeActionKind.QuickFix` with no Piwi prefix, sit in the light bulb between Heal and TypeScript's Move
to file. **(seen)** Fix: one role per surface in both editors: the gutter acts ([TL2](#tl2)), the hover says why, the
lens shows evidence, a quick fix only edits ("Piwi: use getByRole(…)"), and the service owns every title, the words
added to [developer-loop-audit.md](developer-loop-audit.md) §9's table ([X1](#x1)). ([M7](#m7), [LI7](#li7))

<a id="tl8"></a>**TL8. A failure's message is said up to four times on its own line.** The lens, the diagnostic and the
hover (`packages/editor/src/server.ts:2927-2935, 1217-1227, 2708-2713`) and the Testing view's inline message
(`apps/vscode/src/test-explorer.ts:356-361`) carry the headline; JetBrains adds a tooltip
(`PiwiTestAnnotator.kt:82-87`). **(seen)** Fix: the message on the diagnostic, the lens a marker and the evidence, the
hover without the headline, JetBrains' tooltip only while `failureSeverity` is `off`. ([Q12](#q12), [LI7](#li7))

<a id="tl9"></a>**TL9. Record here is in JetBrains' Alt+Enter list on any line of a script, imports included, and
missing from VS Code's Ctrl+.** `RecordHereIntention.kt:22-25` offers it anywhere under a config folder; VS Code
registers only the recorded-locator fixes (`apps/vscode/src/recording.ts:833-836`). **(read)** Fix:
[record-from-the-ide.md](record-from-the-ide.md) Part 2's two places, between tests and inside a test body, in both
editors, as a refactor-kind action from the service ([TL7](#tl7)). ([M7](#m7), [LI7](#li7))

### 5.3 The words

<a id="tl10"></a>**TL10. A test's summary reads "failing · passed 44/48 · failed" in both editors, and in JetBrains only
the small result icon shows it.** The client's word, "failing" (`apps/vscode/src/glue.ts:569-578`, `Glue.kt:688-697`),
precedes the service's title, which adds the catalog status for anything but passed
(`packages/editor/src/server.ts:2884-2888`): "flaky · passed 39/41 · flaky · flaky score 12", or raw ids such as
never-run. Rider shows it in the result icon's tooltip alone, and VS Code builds its hover on the client. It is the only
place either editor shows the pass rate and the flaky score. **(seen)** Fix: the service's hover on a test's line, for
both editors, in the dashboard's words (`formatStatusLabel`, copied into the service under a drift test, never into MIT
`packages/core`) and naming the run: "Piwi · failing in CI run #124 · passed 44 of the last 48 · flaky score 12".
([Q11](#q11), [LI6](#li6))

<a id="tl11"></a>**TL11. No lens or Code Vision entry says what a click does, and the docs give the wrong click for the
spec's lens, which runs every test in the file.** `apps/vscode/src/extension.ts:1321-1327` drops the command's title and
`PiwiCodeVisionProvider.kt:40-42` passes no tooltip. The spec's lens, "7 tests in Piwi · 2 failing · 1 flaky" (7 is the
fixture's miscount, [ST6](#st6)), runs those tests, headed when a breakpoint applies
(`packages/editor/src/server.ts:2960-2970`), and `apps/docs/features/editors.md:52` says the click opens the test in the
dashboard. **(seen)** Fix: titles from the service that say what happens ("Run the 7 tests of this spec with Piwi"),
shown as the tooltip in both clients, a plain entry for a line with no command, and the docs row fixed. ([Q11](#q11),
[LI7](#li7))

<a id="tl12"></a>**TL12. The Problems panel labels a failure from the developer's own run `ci-failure`, while its hover
says Local failure.** `packages/editor/src/server.ts:1225` sets that code on every failure, the hover tells the two
apart (`server.ts:2710`), and [1.0-stabilization.md](1.0-stabilization.md) D25 freezes the code. **(read)** Fix, before
1.0: a `local-failure` code registered in D25, or the frozen code kept and the origin said in the message ("Local
failure: …"). ([Q11](#q11))

### 5.4 The marks

<a id="tl13"></a>**TL13. Flaky disappears from the test line: VS Code's default Testing gutter draws a flaky test as a
plain pass, and JetBrains draws it as the inspection warning in a failure's amber.** On the editor fixture in VS Code
1.143.1, with `piwi.testExplorer` on, its default (`apps/vscode/package.json:923-926`), the flaky test at line 14 of
`catalog.spec.ts` draws the same green check as the passing test at line 4, and only the lenses say "1 flaky". Two
causes: `testOutcome` maps flaky to passed (`apps/vscode/src/glue.ts:1489-1496`), and
`apps/vscode/src/extension.ts:477-480` empties Piwi's gutter icons while the view is on. JetBrains draws flaky with
`AllIcons.General.Warning` (`PiwiTestAnnotator.kt:104`), `#FFAF0F` in the new UI, the color of `TestFailed`. **(seen)**
Fix: the Testing view takes passed, failed, skipped and running, never flaky. VS Code draws Piwi's flaky mark beside the
view's glyph if the margin shows both (an open question), else after the line, with a `flaky` tag ([TL20](#tl20));
JetBrains ships `icons/testFlaky.svg` in the outcome palette's flaky glyph ([IC4](#ic4)); the fixture checks fail when a
flaky test carries no flaky mark. ([Q2](#q2), [L6](#l6), [LI3](#li3), [LI8](#li8), [LI19](#li19))

<a id="tl14"></a>**TL14. In JetBrains the failing-test tint stops at the end of the text, on the failing line and on the
test's last line.** Both ranges end at `getLineEndOffset` (`PiwiTestAnnotator.kt:68, 71`); VS Code tints whole lines
(`apps/vscode/src/extension.ts:448-461`). **(seen)** Fix: `LINES_IN_RANGE` highlighters, the kind the plugin's execution
point uses. ([Q12](#q12), [L6](#l6), [LI19](#li19))

<a id="tl15"></a>**TL15. The coverage marks differ between the editors: the "changed since the coverage run" amber, and
JetBrains marking every line the tests ran in the scroll bar.** VS Code's changed border is `#9a6700`
(`apps/vscode/package.json:988-994`), JetBrains' `c7922a`
(`apps/jetbrains/src/main/resources/colorSchemes/PiwiDefault.xml:30-34`): `COVERAGE_MARK_COLORS`
(`packages/core/src/coverage.ts:58-61`) and its test hold two of the four colors. `PIWI_COVERAGE_RUN`'s error stripe
(`PiwiDefault.xml:20-24`) turns a covered file's scroll bar teal. **(seen)** Fix: all four colors in that table and its
test, and the gutter bar's color from its own key so the run marks leave the scroll bar, with
`apps/docs/features/editor-coverage.md` updated. ([Q12](#q12), [LI3](#li3))

### 5.5 Code Vision

<a id="tl16"></a>**TL16. JetBrains Code Vision keeps one entry per line, so the line a test failed at shows only
"Trace": no reason, no Run this test, no Screenshot.** The service sends that line four entries, the reason, Run this
test, Screenshot and Trace (`packages/editor/src/server.ts:2927-2959`), and `PiwiCodeVisionProvider.kt:37-44` returns
each as a `ClickableTextCodeVisionEntry` under its one provider id, `piwi.summary` (`:19`). In the 241 platform's
`app-client.jar`, `EditorCodeVisionContext` groups a line's entries by provider id and keeps the last of each group, so
three of the four never draw. The same collapse keeps only the last Flake Lab line of a flaky test (`server.ts:680-719`)
and drops a failure's reason on a locator line, whose summary sorts after it (`server.ts:2972`). In Rider 2026.2.4.1,
"Trace" stands alone above lines 10 and 19 of `checkout.spec.ts`, as in the docs' JetBrains screenshot, where VS Code
draws the whole row ([docs-illustrations-review.md](docs-illustrations-review.md) §6 left it to check). **(seen)** Fix:
never two entries of one line under one provider. Numbered providers in one group (`piwi.summary`, `piwi.summary.2` …
`piwi.summary.N`), provider n drawing each line's nth entry, N the most entries a line carries (an open question), the
service capping a line at N or folding the rest into `extraActions`; a `CodeVisionGroupSettingProvider` names the group
([ST11](#st11)), and a `CodeVisionTestCase` in `PiwiPluginTest` expects VS Code's row for the editor fixture.
([Q1](#q1), [L6](#l6), [LI19](#li19))

### 5.6 Debug

<a id="tl17"></a>**TL17. Neither editor can debug a test from its line or its failure: VS Code has no Debug profile, the
dashboard's stop-at-the-failing-line run is reachable only through its link, and every plain Run stops at breakpoints.**
`apps/vscode/src/test-explorer.ts:117-125` creates Run-kind profiles only, so Debug Test reaches nothing.
`RunTestsArgs.debug` (`packages/editor/src/protocol.ts:305-330`) runs one test headed and stops once at the failing
line, but only the dashboard's Debug in my editor starts it; the failure nodes and the failure's quick fix offer Run but
no Debug (`packages/editor/src/server.ts:2480-2492`). Every run but Verify ×3 passes the breakpoints while
`piwi.breakpoints` is on, its default, and `withBreakpoints` makes it headed (`server.ts:3191-3213`). To stop a CI
failure at its line, a developer goes through the dashboard and a consent prompt, while yesterday's breakpoint pauses
Run with Piwi. **(seen)** Fix: Debug with Piwi, the dashboard's run for a failure and a headed run otherwise, as VS
Code's Debug profile and in [TL2](#tl2)'s list, on [TL3](#tl3)'s icon and on failure nodes (Debug This Failure there,
[HM11](#hm11); §13), with no consent prompt; whether plain Run still stops is open (`piwi.breakpoints` keeps its key,
and a new value could keep stops for Debug). It is Piwi's run control, not an IDE debug session ([LI10](#li10)).
([M8](#m8), [LI7](#li7))

### 5.7 The IDE's own test UI

<a id="tl18"></a>**TL18. Piwi's coverage sits beside each IDE's coverage rather than inside it: VS Code gets no Test
Coverage view, and JetBrains paints in the IDE coverage's strip.** VS Code draws its own borders
(`apps/vscode/src/extension.ts:562-591`) and never calls `TestRun.addCoverage`, which VS Code's engines floor, 1.91,
already offers, so no per-file percentage shows Piwi's data. JetBrains' coverage mark paints at `Position.LEFT`
(`PiwiCoverageMarks.kt:246`), the IDE coverage's strip, so after Run with Coverage the two bars overlap, and its click
shows only a hint (`:252-255`). **(read)** Fix: a Coverage profile and `FileCoverage` on the results run in VS Code; in
JetBrains, a click menu (Run the Tests That Ran These Lines, Next Uncovered Line, Hide, Edit Colors…) and Piwi's marks
skipped while the IDE shows its own. ([L2](#l2), [LI8](#li8))

<a id="tl19"></a>**TL19. JetBrains has no per-test view of a Piwi run in progress, while VS Code shows one in its
Testing view.** VS Code publishes a run in progress test by test (`apps/vscode/src/test-explorer.ts:149-178`); JetBrains
shows counts in the status item and "running x/y" on the Piwi tool window's run node
(`PiwiFailuresToolWindow.kt:104-106`), and the IDE's test tree comes only with its Playwright runner, off by default and
never offered. **(read)** Fix: offer the runner once ([editor-extensions-audit.md](../adr/editor-extensions-audit.md)
§6.4), and give other runs an SMTRunner console fed by the run channel's test events. Local progress is [LR9](#lr9).
([L2](#l2), [LI8](#li8))

<a id="tl20"></a>**TL20. VS Code's Testing view shows none of Piwi's per-test data: no durations, no descriptions, no
tags.** Results are published with no duration (`apps/vscode/src/test-explorer.ts:335-357`), so a CI run's header reads
"5/7 1.0ms", and `SpecTest` has no duration or tags (`packages/editor/src/protocol.ts:161-178`). **(seen)** Fix:
durations, `TestItem.description` and `TestTag`s (Playwright's tags, flaky, quarantined, owner) from `SpecTest`; output
and a stop message are the live-run study's P6 (live-runs E23). ([M20](#m20), [LI8](#li8))

### 5.8 A test card

<a id="tl21"></a>**TL21. A test's tooltip and hover are one line, though the service holds its history, last failure,
owner, trace and screenshot.** `Glue.kt:688-698` and `apps/vscode/src/glue.ts:569-579` build that line from a duplicated
table of status words, while the dashboard's test page draws the history, flaky rate, owner and quarantine. To answer
"my bug or a flake?", the developer leaves the editor. **(seen)** Fix: a `piwi/testCard` request (the last N results as
a strip, the flaky rate, the last failure, owner, quarantine, the evidence and [TL2](#tl2)'s action list), a popup on
the result icon in JetBrains and the hover in VS Code, laid out like the dashboard's test row: the test counterpart of
the element card of [extension-ux-audit.md](extension-ux-audit.md) §4.1. ([L5](#l5), [LI7](#li7))

## 6. Settings, connection, onboarding and agents

What works: the API key never sits in a setting (VS Code's secret storage and the IDE's password safe, each per
instance), both clients take the connection order from the service (`packages/editor/src/context.ts:263`), and
`apps/vscode/tests/walkthrough.test.ts` fails when a walkthrough step names a command that is gone. **(read)** The
direction is one settings registry ([LI11](#li11)), one onboarding script ([LI12](#li12)), and the connection computed
once and shown first ([LI13](#li13)).

### 6.1 The first minutes

<a id="st1"></a>**ST1. A JetBrains IDE has no Get Started: onboarding is one balloon, shown once per installation and
only while nothing names an instance.** `PiwiProjectService.kt:276-290` shows it in a trusted project with a Playwright
config while nothing connects it or names an instance (`Glue.showsFirstRun`), with Connect…, Open the Failures and Learn
More but no Record. A Rider or WebStorm workspace connected through the environment, `.env` or the desktop app never
sees it, and nothing reopens a missed one. VS Code opens a six-step walkthrough once per machine
(`apps/vscode/src/extension.ts:364-371`) and keeps **Piwi: Get started**. **(read)** Fix: `Piwi.GetStarted` (Tools →
Piwi, the Piwi tool window's gear menu, Help) opening a Get Started tab in the Piwi tool window once per installation,
rendered from the walkthrough's step list with the same buttons and checks. ([M11](#m11), [LI12](#li12))

<a id="st2"></a>**ST2. VS Code's walkthrough is six steps of text that skip breakpoints, the Testing view and Piwi
Picker, and its description is cut off.** `apps/vscode/package.json:85-164` gives each step a Markdown page, though the
docs hold screenshots of the same fixture; breakpoints get one sentence (`apps/vscode/walkthrough/run.md:12-13`),
pairing Piwi Picker none, and `apps/vscode/walkthrough/settings.md` lists 6 of the 9 settings. In VS Code 1.143.1 the
description ends in 'run and record test…'. A new user never sees a run paused at a breakpoint, the loop Piwi is built
around. **(seen)** Fix: a one-line description, steps for a breakpoint stop and for pairing Piwi Picker, the docs'
images as `media.image`, an MCP step per editor through `when`, `settings.md` generated from the registry ([ST7](#st7)),
and the six-step cap of `apps/vscode/tests/walkthrough.test.ts:32` raised. ([M11](#m11), [LI12](#li12))

<a id="st3"></a>**ST3. The disconnected home offers only Connect in both editors and never says that recording works
without an instance.** The Failures view's welcome (`apps/vscode/package.json:68-72`) and the Piwi tool window's empty
text (`PiwiFailuresToolWindow.kt:169-173`) say only that Piwi is not connected, as
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) §3.1 noted for VS Code. **(seen)** Fix: Record a New
Test File… beside Connect…, under a second line, 'Recording works without one'. ([M11](#m11), [LI12](#li12))

<a id="st4"></a>**ST4. VS Code's first activation in an already-connected workspace can raise the walkthrough, the MCP
notice and the desktop offer together.** The walkthrough opens once per machine
(`apps/vscode/src/extension.ts:364-371`), then each full status read calls `offerDesktop` and `offerMcp`
(`extension.ts:710-721`); on 1.101+ the MCP toast repeats the walkthrough's step. **(seen)** Fix: one first-run queue in
both editors (JetBrains offers MCP at its first connected status): the tour, the desktop offer, then the MCP offer after
the first failure shown, none on 1.101+. ([M11](#m11), [LI12](#li12), [LI14](#li14))

<a id="st5"></a>**ST5. The Marketplace listings do not say how to get an instance, and the JetBrains one omits the
privacy line and claims one-click actions its tool window lacks.** Neither listing says where an instance comes from
(the desktop app, `npx @piwitests/server`, Docker); `plugin.xml:9-49` lacks 'Self-hosted, zero telemetry' and VS Code's
'Nothing from your workspace is sent to the instance' (`apps/vscode/README.md:52`), and its 'in one click'
(`plugin.xml:22`) is a right-click in the tree. **(read)** Fix: the canonical line, a 'You need' line, and a drift test
over `plugin.xml`, both READMEs and `apps/docs/features/editors.md`. ([Q21](#q21))

<a id="st6"></a>**ST6. The editor fixture counts all seven tests over every spec, so the docs' and both listings' images
show wrong lens counts.** `apps/vscode/scripts/lib/editor-fixture.mjs:572` ignores the `file` the service sends
(`packages/editor/src/piwi-client.ts:537-541`): a three-test spec's lens reads '7 tests in Piwi · 2 failing · 1 flaky' in
both editors' images. **(seen)** Fix: filter by `file`, recapture both sets, and assert the count in the nightly check
of [real-editor-checks.md](real-editor-checks.md). ([Q15](#q15), [LI19](#li19))

### 6.2 The settings pages

<a id="st7"></a>**ST7. The two settings pages show the same options in different groups and orders, and VS Code's is one
alphabetical list with code values.** `apps/vscode/package.json:854-945` is one configuration object with no `order`, so
VS Code sorts its 9 keys alphabetically with `piwi.serverUrl` seventh, shows `error` and `key` in its dropdowns and
titles one key 'Mcp Authorization'. `PiwiConfigurable.kt:45-153` binds 10 controls in five groups, words its choices and
checks the URL. Each side has options the other lacks, and the words are written three times,
`apps/vscode/walkthrough/settings.md` included. A team using both editors cannot describe one setup. **(seen, counted)**
Fix: [LI11](#li11)'s settings registry, VS Code's choices labeled with `enumItemLabels`, keys unchanged and grouped as
the last column below. ([M10](#m10), [LI11](#li11))

Place is the position on the page today. VS Code's window scope is per user and overridable by a workspace file
([ST12](#st12)); JetBrains keeps the URL and project in `piwi.xml`, the rest in `workspace.xml`.

| Option | VS Code key (place), scope | JetBrains group (place), file | Proposed group |
|---|---|---|---|
| The desktop app first, and its project | Connect's choice, `workspaceState` | Piwi Desktop App (1, 2), workspace | Connection |
| Instance URL | `piwi.serverUrl` (7), window | Instance (3), `piwi.xml` | Connection |
| Project | `piwi.project` (4), window | Instance (4), `piwi.xml` | Connection |
| API key | secret storage, no row | Instance, a label; password safe | Connection |
| Connection in use | the status tooltip only | In use (last), with Refresh | Connection, first ([ST9](#st9)) |
| Failure severity | `piwi.failureSeverity` (2), window | Runs (6), workspace | Editor |
| Lenses, gutter icons, locator warnings, tint | none ([ST8](#st8)) | none; Code Vision unnamed ([ST11](#st11)) | Editor |
| Coverage marks | a command, `workspaceState` | a toggle action, workspace | Editor |
| Run notifications | `piwi.runNotifications` (5), window | Runs (5), workspace | Runs |
| Breakpoints | `piwi.breakpoints` (1), window | Runs (7), workspace | Runs |
| Piwi's tests in the Testing view | `piwi.testExplorer` (8), window | none | Runs |
| The IDE's Playwright runner | none | Runs (8), workspace | Runs |
| MCP sign-in | `piwi.mcpAuthorization` (3), application | AI Assistant (9), workspace | Agents |
| Serve the runs to agents | `piwi.serveRunsToAgents` (6), window | AI Assistant (10), workspace | Agents |
| The service's trace | `piwi.trace.server` (9), window | none ([developer-loop-audit.md](developer-loop-audit.md) P8) | Diagnostics |

<a id="st8"></a>**ST8. Neither client can turn off Piwi's lenses, gutter icons, locator warnings or failing-test tint on
their own, and a spec carries a lens over nearly every locator line.** The service emits a lens for each locator line of
test code, specs included (`packages/editor/src/server.ts:2858-2867`), so a 29-line spec in VS Code shows a file lens, a
'1 test · click' lens over most locator lines and two failure lenses, and only `editor.codeLens`, which hides every
extension's lenses, turns them off. Of the display options `EditorCredentials` carries only `failureSeverity`
(`packages/editor/src/protocol.ts:452-482`), and coverage marks are a per-workspace command and a JetBrains toggle.
**(seen)** Fix: before D25 freezes the keys, `piwi.codeLens` (all, problems, off), `piwi.gutterIcons`,
`piwi.coverageMarks`, `piwi.locatorWarnings` and `piwi.failingTestTint`, which the service reads from the credentials to
filter lenses and diagnostics once for both clients, dropping a spec's lens whose only test is the one around it;
JetBrains shows the five in its Editor group ([TL4](#tl4); its grayed-out runner checkbox is [RD5](#rd5)). ([M10](#m10),
[LI11](#li11))

<a id="st9"></a>**ST9. When the environment, `.env` or the desktop app connects, Settings → Tools → Piwi opens on empty
fields and 'None: no instance saved'; the connection in use is at the bottom.** The fields bind only to the saved
settings (`PiwiConfigurable.kt:61-80, 191`), Disconnect stays enabled (`:84`), the connection used is the last group, In
use (`:144-153`), and the first group is the desktop app's, whose 'Project:' label repeats the instance's (`:54, 72`).
In Rider 2026.2.4.1 the page opens on empty fields and None, and its bottom reads 'Connected to Acme Mugs on main …,
from the environment (PIWI_DASHBOARD_URL)'. A developer reads None and runs Connect again, or types a URL the
environment overrides. **(seen)** Fix: open on the connection in use, with Reconnect and Test Connection; an overriding
source's values as the fields' empty text, 'Overridden by …'; the instance before the desktop app, whose field reads
'Desktop app project:'; Disconnect only when something is saved ([ST20](#st20)). ([Q5](#q5), [LI6](#li6), [LI13](#li13))

<a id="st10"></a>**ST10. Settings search and Find Action cannot find Piwi's options: the searchable-options index is
never built.** `apps/jetbrains/build.gradle.kts:95` sets `buildSearchableOptions = false`, and the configurable declares
no keywords. In Rider 2026.2.4.1, searching 'agents of this machine', a Piwi checkbox's text, finds only Keymap and
Plugins; VS Code's search finds every `piwi.*` setting. **(seen)** Fix: build the index at least in the publish job, and
add a `SearchableOptionContributor` (public in 2024.1) for the words the labels lack (Playwright, MCP, agent, API key,
breakpoints, Picker, coverage), from the registry that gives VS Code's settings their `tags`. ([Q4](#q4), [LI11](#li11))

<a id="st11"></a>**ST11. Piwi's Code Vision group has no name in the IDE's Code Vision settings, so its lines cannot be
found there to hide or move.** `PiwiCodeVisionProvider.kt:19-21` sets the group `piwi.summary` and the plugin registers
no `codeVisionGroupSettingProvider`, so the platform takes the name from a bundle key Piwi does not ship (empty on
WebStorm 2024.1's jars). Rider 2026.2.4.1's Editor → Code Vision lists Usages, Code author and Covering tests but no
Piwi while Piwi's lines are drawn: hiding or moving them means turning all Code Vision off. **(seen)** Fix: a
`CodeVisionGroupSettingProvider` named 'Piwi', with a description and a preview, linked from the settings page
([TL16](#tl16)). ([Q1](#q1), [LI11](#li11))

<a id="st12"></a>**ST12. The scopes differ: every JetBrains choice is per project, VS Code's are per user, and a
committed `.vscode/settings.json` can override a personal choice.** JetBrains keeps all but the URL and project in
`workspace.xml` (`PiwiProjectService.kt:92-111`); VS Code gives every key the window scope but `piwi.mcpAuthorization`,
which is application (`apps/vscode/package.json:904-906`). A JetBrains developer with ten projects picks 'A warning' ten
times, and a repository that commits `piwi.breakpoints` set to false turns breakpoints off for every VS Code user and
for no JetBrains user. **(read)** Fix: each option's scope set once in the registry, team (URL, project, perhaps
`failureSeverity`), user or machine (the desktop app); VS Code's personal keys scoped `application` or `machine`; a
JetBrains Defaults page at the application level, each project showing 'Default (…)' or its override. ([M10](#m10),
[LI11](#li11))

<a id="st13"></a>**ST13. The settings page says 'Kept for you only, in .idea/workspace.xml' seven times and names paths
that do not exist in Rider.** The sentence closes seven comments
(`PiwiConfigurable.kt:52, 93, 102, 110, 119, 130, 139-140`), and in Rider both files sit under
`.idea/.idea.<Name>/.idea/` (`Glue.projectFolder`). **(read)** Fix: one comment per storage group, its path computed
from the project's store directory. ([M10](#m10), [LI11](#li11))

<a id="st14"></a>**ST14. Settings → Tools → Piwi clips its comments at the right edge and scrolls sideways.**
`PiwiConfigurable.kt:88-103, 124-131` put a long label before a combo box whose comment, 70 characters wide by the UI
DSL's default, starts after the label; in a 1440×900 Rider window the Runs and AI Assistant comments end in 'Kept for
y…' above a horizontal scrollbar. **(seen)** Fix: labels on top (`LabelPosition.TOP`), and a clipped-text check in the
screenshot script like the one in [extension-localization.md](../adr/extension-localization.md). ([Q5](#q5),
[LI11](#li11))

<a id="st15"></a>**ST15. Neither the JetBrains settings page nor its Connect dialogs link to the documentation, and the
Settings dialog's help button gives nothing for Piwi.** `PiwiConfigurable.kt:27` sets no help topic and no
`webHelpProvider` is registered; VS Code's descriptions link nowhere, and the docs have no editor settings table.
**(read)** Fix: a `WebHelpProvider`, a Documentation link per group, the same anchors in VS Code, and a settings section
generated from the registry. ([M10](#m10), [LI11](#li11))

### 6.3 Connecting

<a id="st16"></a>**ST16. Connecting in JetBrains is a chain of up to five modal dialogs, the settings page takes the
project as free text, and the sign-in code and link sit in an uncopyable progress dialog.** `PiwiConnectFlow.run` chains
the desktop-or-instance choice, the URL, sign in or paste, a modal sign-in and the project
(`PiwiConnect.kt:131, 238, 254, 293-313, 162`). On the settings page both projects are free text
(`PiwiConfigurable.kt:54-58`, `:72-77`), though the desktop app's list is at hand (`PiwiConnect.kt:206`), and the key
has no Change or Remove. The sign-in's code and link are progress text (`PiwiConnect.kt:294-295`); VS Code's
notification shows the code and no link (`apps/vscode/src/extension.ts:1916-1921`). A typo in the project reads as not
connected, and a browser opened in another profile leaves Cancel as the only way out, in both editors. **(read)** Fix:
[LI13](#li13)'s Connect panel, in the settings page and as one dialog, and a non-modal sign-in with Copy Code, Copy Link
and Open Browser Again, as VS Code's notification also gets. ([M12](#m12), [LI13](#li13))

<a id="st17"></a>**ST17. In safe mode the status item, the tool window and the settings page say Piwi starts when a file
opens, which is false; after trusting, nothing starts until another file opens.** An untrusted project gets one balloon
with no action (`PiwiProjectService.kt:215-220`), while the three persistent surfaces show 'Piwi starts when you open a
file of this project' (`Glue.kt:277, 795`). Nothing listens for trust, and `apps/jetbrains/ARCHITECTURE.md:105-106` says
the next file opened starts the service. A developer who opens a fresh clone in safe mode, then a spec, still reads that
line. **(read)** Fix: 'Piwi: waiting for trust' with a warning icon and its reason in all three places, and the service
started for the open files when trust arrives (`TrustedProjectsListener.onceWhenProjectTrusted`, public and marked
experimental in 2024.1). VS Code disables the extension in Restricted Mode and needs no counterpart. ([Q6](#q6),
[LI13](#li13))

<a id="st18"></a>**ST18. The settings page's In use group has a third kind of Refresh, and a Node.js start problem shows
there and in the tool window with no way to fix it.** Its Refresh re-sends the connection
(`PiwiConfigurable.kt:148-152`), unlike Tools → Piwi's Refresh and the status popup's Read the Latest Run Again; only
the balloon and the status popup open the Node.js settings, though the Language Services widget's gear opens this page.
**(read)** Fix: Reconnect, a Node.js Settings… button on the page and in the Piwi tool window, and one word per refresh
scope ([AC10](#ac10); [developer-loop-audit.md](developer-loop-audit.md) §9). ([Q5](#q5), [LI13](#li13))

<a id="st19"></a>**ST19. Connect… on the settings page applies every pending edit first, so Cancel no longer reverts
them, and Disconnect drops the page's other edits.** `connect()` calls `apply()` (`PiwiConfigurable.kt:209-214`), which
tells the live runs of a breakpoints change (`:171`) and skips the URL's `validationOnApply`; `disconnect()` calls
`reset()` (`:216-218`). Untick breakpoints, click Connect…, cancel it, then Cancel: breakpoints stay off. **(read)**
Fix: the typed URL, validated, handed to the Connect flow without `apply()`, and only the Connection rows reset.
([Q5](#q5), [LI13](#li13))

<a id="st20"></a>**ST20. Connect shows raw Java exception text for certificate and other errors, and Disconnect silently
does nothing when nothing is saved.** `failed()` maps four causes and shows any other exception's message
(`PiwiConnect.kt:345-353`), so a company certificate reads 'PKIX path building failed…'; `disconnect()` returns silently
with nothing to forget (`PiwiConnect.kt:228-235`), where VS Code says 'Piwi: nothing is saved in the settings.' VS
Code's certificate error was not read. **(read)** Fix: a certificate error naming the host and where to trust it, as
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) §4.2 asked of the status tooltip; 'not a Piwi instance'
for a 404; Disconnect only when something is saved. ([Q5](#q5), [LI13](#li13))

### 6.4 Agents

<a id="st21"></a>**ST21. The JetBrains agent setup is named after one product: the 'AI Assistant' group and the copy
notices point at the AI Assistant's settings, also in a Rider without it.** The group is 'AI Assistant'
(`PiwiConfigurable.kt:123`), and the notice after a copy names first 'Settings → Tools → AI Assistant → Model Context
Protocol', a page Rider 2026.2.4.1 lacks without the AI Assistant, and 'your agent's MCP settings' only in parentheses
(`PiwiActions.kt:317-318`); VS Code and the docs say 'your agent'. **(seen)** Fix: 'Agents (MCP)', with the copy and
token actions on the page, the AI Assistant named only when `com.intellij.ml.llm` is enabled, and the offer queued
([ST4](#st4)). ([M11](#m11), [LI18](#li18))

<a id="st22"></a>**ST22. JetBrains users paste a token-bearing MCP configuration into each agent, while VS Code
registers Piwi's two MCP servers itself and Rider bundles an MCP server plugin Piwi does not use.** Tools → Piwi holds
three copy actions and a token reset (`plugin.xml:142-153`), on the ground that no public API registers an MCP server
for the AI Assistant (`PiwiActions.kt:341-345`; [editor-extensions-audit.md](../adr/editor-extensions-audit.md) §6.2).
VS Code 1.101+ lists `piwi.mcp` and `piwi.runs` itself (`apps/vscode/src/extension.ts:1444-1458`). Rider 2026.2.4.1
bundles `com.intellij.mcpServer`, whose dynamic `mcpToolset` extension point takes an interface marked neither internal
nor experimental in the 262 jar. [developer-loop-audit.md](developer-loop-audit.md) P10 covers only the copied
configuration's shape. **(seen)** Fix: [LI18](#li18)'s optional `mcpToolset` module; the copy actions stay, in an Agents
submenu, for older IDEs and outside agents. ([M23](#m23), [LI18](#li18))

### 6.5 Diagnostics

<a id="st23"></a>**ST23. The JetBrains plugin writes nothing to `idea.log`, swallows failed requests, and says that the
service is not running in five ways.** None of the 24 Kotlin files under `apps/jetbrains/src/main/kotlin/` uses a
`Logger`, and `awaitCancellably` returns null on any exception (`PiwiProjectService.kt:918-929`), so a failed
`piwi/fileSummary` leaves the gutter and Code Vision empty and a Rider user's report with nothing in the log to read.
The wordings run from 'The editor service is not running.' (`PiwiCommands.kt:47`) and 'No command to run these tests
(not connected?).' (`PiwiCommands.kt:177`) to three more in the agents, recording and pick paths; only the agents' one
names a next step, 'open a test file first' (`PiwiActions.kt:373`), and it offers no action.
[developer-loop-audit.md](developer-loop-audit.md) P8 records the service's missing log; the plugin's own silence is
new. **(read)** Fix: `Logger.getInstance` with the cause in `PiwiProjectService` and `PiwiConnect`, one not-running text
with Restart the Editor Service and Open Log, and a Log tab in the Piwi tool window behind `Piwi.OpenLog`
([HM14](#hm14)). ([M19](#m19), [LI5](#li5))

## 7. The Piwi home, the status bar and notifications

What works: both editors draw the same `piwi/status` and `piwi/failures` answers, and the JetBrains status item has the
icon, failing color and popup of [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7. **(read)** Around
that data the clients differ. The direction: one Piwi menu ([LI4](#li4)), one home per editor ([LI5](#li5)), the status
and the views computed by the editor service ([LI6](#li6)), one notification policy by kind ([LI14](#li14)).

### 7.1 The status item

<a id="hm1"></a>**HM1. A click on the status item opens the status popup in JetBrains but only reads the run again in VS
Code, whose actions hide in a tooltip that offers Connect while connected.** `apps/vscode/src/extension.ts:673-678`
makes the click a refresh, a retry or Connect: in VS Code 1.143.1 it draws a spinner. The actions are tooltip links
(`apps/vscode/src/glue.ts:72-78, 287`), with no Re-run failing, Failures view, run control or log, out of the keyboard's
reach, and the tooltip's '3 failed' faces the item's '2 failing'. In Rider 2026.2.4.1 the click opens that popup
(`PiwiStatusBar.kt:167-203`). **(seen)** Fix: the click opens the status menu (a new `piwi.statusMenu` quick pick) in
the popup's sections and order, the state's action preselected so Enter still refreshes, its run section replacing VS
Code's control items while a run is live ([LR1](#lr1)); Connect only when not connected, in both clients; one count in
the tooltip ('3 failed in run #124 · 2 still failing'). Click or chord is open (§13). ([M3](#m3), [LI4](#li4))

<a id="hm2"></a>**HM2. VS Code paints the status item red all day for any failing test, CI failures the developer did
not cause included, where JetBrains colors only the text.** `apps/vscode/src/glue.ts:296-298` and
`apps/vscode/src/extension.ts:679` set `errorBackground` for any failing test: on the editor fixture, two CI failures on
main make a red block of 43 characters, 'Piwi: 2 failing · 1 fixed locally · 1 flaky'. JetBrains, by the same rule,
draws red text beside `TestFailed` (`PiwiStatusBar.kt:132-140, 298-303`). VS Code's guidelines keep that background for
a last resort. **(seen)** Fix: a severity in the status view, alert only for failures new against the baseline that a
run started here or local edits produced, until the next run; the error background or foreground for alert alone; 'Piwi:
2 failing' as the text; a setting, `piwi.statusBarAlert` (`new`, `any`, `never`) and its JetBrains twin. What counts as
new is open (§13). ([M13](#m13), [LI6](#li6))

<a id="hm3"></a>**HM3. JetBrains' status popup has no title, two refreshes, two globes, Connect… while connected and 18
run actions in one block, and its run-only refresh has no action id.** The popup is untitled (`PiwiStatusBar.kt:209`)
and lists Open the Latest Run beside Open in Dashboard. Its Read the Latest Run Again, an unregistered inner class
(`:241-248`), shares its icon with `Piwi.Refresh`, which also reads the indexes or restarts the service
(`PiwiActions.kt:69-84`), while the same arrow reads the run alone in VS Code. `ConnectAction` has no `update()`
(`PiwiActions.kt:31-38`). While a run is live, a Go to row per stop ([LR4](#lr4)) and 18 `RUN_ACTIONS`
(`PiwiStatusBar.kt:269-274`) lead in one block, Stop after Mock, Pause, the two watch rows and the sharing rows.
**(seen)** Fix: a registered `Piwi.RefreshRun`, Refresh Latest Run, first in the popup and on the toolbar,
`Piwi.Refresh` kept as Reload Piwi ([AC10](#ac10)); a title; Connect… only when not connected; one Open in Dashboard
([HM5](#hm5)); the registered Run Control group, as controls | page | code actions | sharing | Stop. ([Q8](#q8),
[LI4](#li4))

<a id="hm4"></a>**HM4. One status state wears different glyphs in the two editors, and both print a run's raw status.**
Recording, live sharing and Connect are the Piwi mark, an eye and a person in JetBrains
(`PiwiStatusBar.kt:132-139, 150-158`), `$(record)`, `$(broadcast)` and `$(plug)` in VS Code; both print 'Piwi: timedout'
(`apps/vscode/src/glue.ts:300`) where the dashboard says 'timed out' (`apps/application/app/utils/index.ts:343-348`).
**(read)** Fix: one glyph per state from the concept table, the Piwi mark for the neutral state only, the status in the
dashboard's words, from the service. ([Q11](#q11), [LI6](#li6))

### 7.2 The homes

<a id="hm5"></a>**HM5. The Piwi tool window's two identical globes open the same run page: Open in Dashboard ignores the
selected failure.** Both are `General.Web` (`plugin.xml:134-139`). `OpenInDashboardAction` reads
`CommonDataKeys.VIRTUAL_FILE` and has no `update()` (`PiwiActions.kt:141-166`); the toolbar's target provides no data
(`PiwiFailuresToolWindow.kt:206-207`), so the action opens the run page (`PiwiActions.kt:160`), as Open the Latest Run
does. A failure's own page is in the right-click menu alone (`PiwiFailuresToolWindow.kt:350-352`); VS Code has it inline
on every row. **(seen)** Fix: the panel provides the selected node through a `DataKey` (with `DataProvider`: 2024.1 has
no `UiDataProvider`); one globe opens a failure's test, a run's page or the latest run, disabled with no URL and held by
a platform test; Open Latest Run stays in Tools → Piwi. The glyph is [IC10](#ic10)'s. ([Q8](#q8), [LI5](#li5))

<a id="hm6"></a>**HM6. The Piwi tool window's toolbar has 15 buttons, among them four loose grouping toggles, an eye and
two identical person icons, and no gear menu; VS Code's view title has seven.** `PiwiFailuresToolWindow.kt:184-205`
builds 6 + 4 + 4 + 1 buttons. The 241 and 262 jars map Group by Cluster's `actions/groupBy.svg` to
`expui/general/show.svg`, an eye, the status item's glyph for a live share; Connect and Group by Owner are both
`General.User`; nothing calls `setAdditionalGearActions`; Re-run Failing looks enabled with nothing failing. Docked at
the side, the row overflows behind a chevron; VS Code has one Group by quick pick. **(seen)** Fix: one Group By
drop-down of radio toggles; Connect…, Pair, the MCP copies, Settings…, Documentation and the log in the gear; on the
toolbar, in VS Code's order ([HM7](#hm7)), Refresh Latest Run, Re-run Failing (disabled with none failing), Open in
Dashboard, Compare With…, Group By, then navigation. Connect's glyph is [IC7](#ic7)'s. ([Q8](#q8), [LI5](#li5))

<a id="hm7"></a>**HM7. VS Code's Failures view keeps seven title buttons while disconnected, draws Follow as a reversed
eye, and offers no Connect, Settings or log.** `apps/vscode/package.json:683-719` gates each `view/title` entry on
`view == piwi.failures` alone, so they show under 'Piwi is not connected to an instance', and Follow's icon shows the
current state, eye-closed for 'not following' (`package.json:289-299`). JetBrains' run actions stay enabled while
disconnected too. **(seen)** Fix: Refresh Latest Run, Re-run Failing, Open Latest Run, Compare With… and Group By only
while `piwi.active`; Follow a `toggled` command in the '…' overflow with Connect…, Settings… and Open Log; JetBrains
gated by `update()`, in the same order ([HM6](#hm6)). The palette's half is [AC4](#ac4). ([Q7](#q7), [LI5](#li5))

<a id="hm8"></a>**HM8. Both failures views misreport two states: an unreachable instance as 'not connected', with
Connect, and a project with no run as 'No failure in the latest run'.** Unreachable: JetBrains shows 'Not connected to a
Piwi instance' and Connect… (`PiwiFailuresToolWindow.kt:169-173`), and VS Code's view says not connected whenever no
context is (`apps/vscode/src/failures-view.ts:126-127`) beside a status item reading 'Piwi: unreachable'. JetBrains'
Connect then ends in a 'Could not connect' dialog (`PiwiConnect.kt:345-354`). No run: the answer holds no run
(`packages/editor/src/failure-tree.ts:369`), and both views say no failure (`apps/vscode/package.json:74-78`,
`PiwiFailuresToolWindow.kt:177`) while VS Code's item says 'Piwi: no run'. With the VPN off the view asks to connect; a
new project reads as all green. Since v0.68.0 a desktop app that does not prove it holds the token, an older one or
another process on its port, is filed as unreachable too (`packages/editor/src/context.ts:637`, its error at
`packages/editor/src/http.ts:63-70`), so both editors offer Retry where the fix is to update or restart the app.
**(read)** Fix: the service sends the view's state (failures, clear, norun, unreachable, disconnected, unavailable) and
its words: '<url> does not answer (<problem>). Piwi tries again on its own.' with Retry and Open Settings; 'No run of
<branch> yet.' with Compare With… and Get Started; a desktop app that fails the proof as its own state, with Restart or
update the desktop app; each state tested on the editor fixture in both clients. ([Q7](#q7), [LI5](#li5))

<a id="hm9"></a>**HM9. The JetBrains failures tree drops the hover text the service sends for each node: a failure's
cluster, owner and timeout, a run's counts.** `FailureTreeNode.tooltip` (`packages/editor/src/protocol.ts:931-932`,
filled at `packages/editor/src/failure-tree.ts:99-106, 258`) is VS Code's hover; `Glue.FailureNode` has no such field
(`Glue.kt:412-424`) and the renderer sets none. Grouped by file in Rider, a failure's cluster or owner shows only after
regrouping; JetBrains prints the headline inline, VS Code in the hover. **(read)** Fix: the tooltip carried and drawn
with `Glue.htmlTooltip`, a `GlueTest` case mirroring VS Code's, and the headline in one place, the same in both clients.
([Q8](#q8), [LI5](#li5))

<a id="hm10"></a>**HM10. The status item counts '1 flaky', but neither editor lists which test is flaky.** Both items
append '· N flaky' (`Glue.kt:325`, `apps/vscode/src/glue.ts:295`), while the failures tree holds failing, edited and
fixed nodes only (`packages/editor/src/failure-tree.ts:92`) and the gutter marks flaky in open files alone: the
developer opens the dashboard to find the test. **(seen)** Fix: a 'Flaky in this run' group under the run node, from the
service, each test with its retries, pass rate and a Flake Lab action, in the outcome palette's flaky glyph; the status
menu's 'N flaky' row selects it. ([M18](#m18), [LI5](#li5))

<a id="hm11"></a>**HM11. The failures trees' right-click menus differ: JetBrains' are anonymous actions, four of ten
without an icon; VS Code's run node offers Open in Dashboard on hover only; one action has three names.** `failureMenu`
(`PiwiFailuresToolWindow.kt:323-360`) registers nothing, so no key reaches it; the run node's Open in dashboard is
inline only (`apps/vscode/package.json:737-739`), out of Shift+F10's reach; the screenshot is 'Open the failure
screenshot', 'Screenshot' or 'Open the Screenshot'. **(seen)** Fix: registered `Piwi.Failure.*` actions on [HM5](#hm5)'s
`DataKey`, with `FileTypes.Archive` and `FileTypes.Image`, Verify ×3, Debug This Failure ([TL17](#tl17)) and Jump to
Source; VS Code's inline actions in its menu too; one wording. ([M2](#m2), [LI5](#li5))

<a id="hm12"></a>**HM12. The Piwi tool window's header is two lines of inert gray text that repeat the run row and name
only the first connection.** It is a static label (`PiwiFailuresToolWindow.kt:93-97, 160-162`) built from the first
connected context (`Glue.kt:800-807`). **(seen)** Fix: one line, the connection a link to Settings ('3 Playwright
configs' with several), 'Baseline: CI run #124 on main ▾' a link to Compare With…, and the baseline in VS Code's view
description. ([Q8](#q8), [LI5](#li5))

<a id="hm13"></a>**HM13. The Piwi tool window's tab is 'Latest run' where the status popup and the run balloon say Open
the Failures, and its stripe button shows no failing count.** The count sits in `stripeTitle`
(`PiwiFailuresToolWindow.kt:159`, the tab at `:215`), which the new UI's icon-only stripe button hides; VS Code sets
`view.badge`. **(seen)** Fix: the tab named Failures; while tests fail, a `piwi_failing.svg` with a dot through
`toolWindow.setIcon` (`BadgeIconSupplier` is internal in 2024.1). ([Q8](#q8), [LI5](#li5))

### 7.3 The service's own state

<a id="hm14"></a>**HM14. VS Code's 'service not answering' welcome offers Refresh, which fails once the language client
has stopped, and no restart command exists.** The welcome (`apps/vscode/package.json:79-83`) calls `piwi.refresh`, which
has no catch (`apps/vscode/src/extension.ts:1083-1086`), and `lc.restart()` runs only on a proxy change
(`extension.ts:399-416`): once the client gives up restarting a crashing service, only a window reload helps. **(read)**
Fix: Restart the Editor Service (a new `piwi.restartService`) in that welcome, the unreachable tooltip and a failing
Refresh; JetBrains' empty text links the platform's restart in the same words ([ST23](#st23)). ([Q16](#q16))

### 7.4 Notifications

<a id="hm15"></a>**HM15. Neither editor tunes Piwi's messages by kind: JetBrains has one balloon group for everything,
and VS Code's end-of-run toast offers no way out.** One group, `Piwi` (`plugin.xml:75`), serves 14
`getNotificationGroup("Piwi")` calls in six files and every `PiwiCommands.notify`: verdicts, offers, problems, 'Copied.'
and the Debug in my editor consent (`PiwiDebugLink.kt:25-37`), a balloon that fades while the person is in the browser.
Muting 'Copied.' in Settings → Notifications mutes run results and connection errors. VS Code's `piwi.runNotifications`
defaults to `always` (`apps/vscode/package.json:872-886`), and none of the extension's 74 `show*Message` calls offers
Don't Show Again: ten re-runs, ten toasts. **(read)** Fix: one kind per message, one surface per kind ([LI14](#li14)):
JetBrains groups for results, requests (sticky), offers (suggestion type) and problems, confirmations in
`StatusBar.setInfo`; Only on Failure and a gear on the run toast and balloon. Whether `Piwi` stays the results group is
open (§13). ([Q13](#q13), [LI14](#li14))

<a id="hm16"></a>**HM16. The end-of-run verdict comes only for runs Piwi started, and each client words it on its own.**
`piwi/runEnded` goes to `context.ownRuns` alone (`packages/editor/src/run-watch.ts:699`), and a terminal run records the
origin `local` with no editor ref (`packages/reporter/src/internal/collect/metadata-collector.ts:134-146`): a terminal
run stopped at the editor's breakpoints, the IDE's gutter Run and a CI run of the branch all end with no verdict. The
verdict is built twice (`apps/vscode/src/glue.ts:642-675`, `Glue.kt:752-783`), which both editor guides rule out.
**(read)** Fix: `RunEnded` for every run the editor followed, with its origin, terminal and IDE-runner runs matched by
the run ref the reporter records from the live-run study's P5, once its P7 gives every local run a hub; a scope, mine or
mine and CI, on `piwi.runNotifications` and its JetBrains twin; the text and action ids from the service ('CI run #130
on feature-x · 2 new failures'). ([M21](#m21), [LI14](#li14))

<a id="hm17"></a>**HM17. A test held at a failure or at `page.pause()` in a background IDE gives no sign, where the
desktop app tells the system.** Neither `apps/jetbrains` nor `apps/vscode` calls `requestAttention` or reads
`window.state`; the desktop app signals a failure or a `page.pause()` from the background, never a step that was asked
for (`apps/docs/features/desktop-runs.md:37-38`). A headless test held at a failure waits unseen behind the browser.
**(read)** The rule is the live-run study's attention, built in its P6: interrupt once where the run was launched, a
badge elsewhere until answered. Fix: on a held failure or a `page.pause()`, never on Step, Pause or Run to, JetBrains
calls `AppIcon.requestAttention` (raising the IDE when 'Focus application on breakpoint' is on), VS Code notifies with
Resume and Go to the Stopped Line while unfocused, and the status item carries the badge. ([M21](#m21), [LI14](#li14))

<a id="hm18"></a>**HM18. JetBrains balloons carry no title and no icon.** None of the plugin's `createNotification`
calls sets either (the run verdict at `PiwiCommands.kt:149-150`, the desktop job, recording, run control and project
service balloons), so "Copied. Paste it to your agent." appears with nothing saying it came from Piwi; VS Code prefixes
every message with 'Piwi: ' (`apps/vscode/src/extension.ts:987`). **(read)** Fix: one `PiwiNotifier` that titles
('Piwi', or the run's name), icons, formats the text and picks the group by kind ([HM15](#hm15)). ([Q13](#q13),
[LI14](#li14))

<a id="hm19"></a>**HM19. In VS Code, a failed hover, CodeLens or code action request can pop a generic error toast with
Go to output.** The client options set no `revealOutputChannelOn` (`apps/vscode/src/extension.ts:418-434`), which
`vscode-languageclient` 10.1.2 defaults to `Error`, so its `handleFailedRequest` shows 'Request … failed' without the
'Piwi: ' prefix. **(read)** Fix: `RevealOutputChannelOn.Never`, and a failing service shown on the status item, a new
'unavailable' state with Open Log, as JetBrains keeps such errors in the IDE log. ([Q16](#q16), [LI14](#li14))

### 7.5 The published screenshot

<a id="hm20"></a>**HM20. The published JetBrains screenshot shows the failing status item with no icon and no error
color, both of which Rider draws.** `apps/docs/public/screenshots/jetbrains-failures.png` (docs, README, Marketplace
listing) draws 'Piwi: 2 failing · …' gray and bare, though `Glue.kt:334-337` sets both and
`apps/docs/features/jetbrains.md:51-52` promises them. **(seen)** Fix: recapture with
`apps/jetbrains/scripts/take-screenshots.mjs`, find why WebStorm drew it gray if it still does, and have the script
check the label's icon and color before it writes the image. ([Q15](#q15), [LI19](#li19))

## 8. Live runs in the editors: where they sit

The split with the live-run study ([live-runs.md](live-runs.md)) is the Status paragraph's. A finding that overlaps the
study names the study's finding and phase and says where the result lands in each editor; its fix adds only what the
study does not. By v0.68.0 the study has built its P0 to P4 and part of P5 (its Status paragraph): each finding says
what of it reached the editors, and "planned" marks a phase not built yet.

### 8.1 The glance

<a id="lr1"></a>**LR1. VS Code shows a run's state as up to nine status items, most of them icon-only, with one shared
name, codicon ids for screen readers and hard-coded keys.** `controlItems` (`apps/vscode/src/run-control.ts:985-1058`),
`progressItem` (`:712-733`) and `liveItem` (`:739-763`) add one item per control, the `Pausing… 12 s` item, the give-up
control and the run's count, all named `Piwi run control` (`apps/vscode/src/run-view.ts:298`, ordered at `:171-183`)
with no `accessibilityInformation`: a screen reader hears "debug-continue, Piwi: Resume (F5)". The tooltips print F5,
F10, Shift+F11 and Shift+F5 whatever the keybindings say, and a held failure still offers Step and Finish. **(seen)**
with seven items at v0.66.0; the two v0.68.0 adds **(read)**. Fix: one item named `Piwi`, its accessible name from its
text, its line [LR2](#lr2)'s, its click opening the status menu (Go to the Stopped Line, the controls, Watch a Worker's
Test, Share live); no tooltip names a key, and a held failure offers Resume alone. ([Q17](#q17), [M13](#m13))

<a id="lr2"></a>**LR2. JetBrains' status item drops the run's progress while a test is stopped or the run is shared, and
VS Code's keeps spinning through a stop.** Since v0.68.0 both editors count a run from its own process, and JetBrains
writes `Piwi: 3 of 9 · 1 failed` with a spinner (`Glue.kt:1726-1731`), but a stop or a share still comes first
(`PiwiStatusBar.kt:116-148`), with a pause icon even at a held failure (`:134`); VS Code's `liveText` still draws
`$(sync~spin) Piwi: 4/9 · 1 failing` from the instance through a stop (`apps/vscode/src/glue.ts:116-120`). **(read)**
The composed line is live-runs E14, planned in the study's P5. Fix: one line composed by the editor service for both
clients from `RunSession.progress`, flaky included, with the stop and the share (`Run #78 · 3 of 9 · 1 failed · paused
at checkout.page.ts:12 · live 2 · Open`), the failed icon at a held failure and the spinner only while tests run.
([M13](#m13))

<a id="lr18"></a>**LR18. The run's count and its pausing state are worded three ways, and VS Code shows two counts of
one run side by side.** VS Code's count item, new in v0.68.0, reads `$(beaker) 3 of 9 · $(error) 1`
(`apps/vscode/src/run-control.ts:712-733`) beside the instance's `$(sync~spin) Piwi: 4/9 · 1 failing · your run`
(`apps/vscode/src/glue.ts:116-119`); JetBrains reads `Piwi: 3 of 9 · 1 failed`, without the flaky count VS Code's
tooltip gives. `$(beaker)` is also VS Code's idle Piwi mark and its run node (`glue.ts:197, 379`), and the spinner means
pausing in VS Code but running in JetBrains, which shows a pausing run with `Actions.Pause`, a stop's icon. VS Code says
`Pausing… 12 s` and names the call in the tooltip alone (`run-control.ts:998-1006`), JetBrains `Piwi: pausing… · waits
in <call>` with no time (`Glue.kt:1892`), and neither marks the waiting call in the code, though `RunWaiting` carries
its place (`packages/editor/src/protocol.ts:1499-1505`). A click on the count opens Watch a Worker's Test in VS Code
(`run-control.ts:729`) and the status popup in JetBrains. **(read)** Fix: [LR2](#lr2)'s one line from the service, its
pausing part with the call and the time; the waiting line marked in the code with End Test; one glyph per state from the
outcome palette; the click opening the status menu in both. ([M13](#m13), [M22](#m22))

### 8.2 Steering in the debugger's places

<a id="lr3"></a>**LR3. A stop's controls are missing where debugger users look: VS Code's editor title and context menu,
and JetBrains' editor menu, Run menu and Run tab, titled Piwi for every run.** VS Code has no `editor/title` menu and no
stopped-run entry in `editor/context` (`apps/vscode/package.json:636-681`). JetBrains lists the stop actions in Tools →
Piwi, the status popup and the stop's own popups (`plugin.xml:195-248`), never in `EditorPopupMenu` or `RunMenu`, and a
console run's tab comes from `RunContentExecutor.withTitle("Piwi")` (`PiwiCommands.kt:337-338`) with Rerun, Stop and
Close only; the Status paragraph of [run-control.md](../adr/run-control.md) (lines 76-80) records why the toolbar of its
§3.2 was not built. **(seen)** The tab's name is live-runs E21, built in the study's P6. Fix: in VS Code an
`editor/title` strip while a run is live, in the debug toolbar's order and showing the bound keys, and a first
`editor/context` group while stopped; in JetBrains a registered `Piwi.RunControl` group in `EditorPopupMenu`, `RunMenu`
and the toolbar of a `RunContentDescriptor` the plugin builds. ([M14](#m14), [L3](#l3))

<a id="lr4"></a>**LR4. Only JetBrains leads back to a stopped line, from unregistered rows of its status popup; VS Code
has no way back once the developer scrolls away or opens another file.** Since v0.68.0 the status popup lists each stop
first, by its call, place and worker, and opens its line (`PiwiStatusBar.kt:183-189, 224-239`), and a new stop takes the
focus only on the worker the person is on (`PiwiRunControl.kt:537-616`). The rows are an inner `GoToStopAction`: no key,
no Tools → Piwi entry, nothing for Find Action ([AC6](#ac6)). VS Code reveals a stop as it opens
(`apps/vscode/src/run-view.ts:395-414`) and has no command to return, where the debugger has Show Execution Point.
**(read)** Fix: the rows registered as `Piwi.ShowStop`, on Show Execution Point's key while a test is stopped and with
the stop in a `DataKey`, and `piwi.showStop` in VS Code, first in the run section of the status popup and the status
menu, asking which by Worker N when several are stopped. ([M14](#m14))

<a id="lr5"></a>**LR5. VS Code marks a held failure with the yellow arrow and line of a breakpoint stop.** One
decoration draws every stop (`apps/vscode/src/run-view.ts:222-229`), where JetBrains draws `TestError` at a failure
(`PiwiRunControl.kt:1847`). **(seen)** Fix: a failure's arrow in the outcome palette's red on a new
`piwi.failurePointBackground` color, in the gutter and the overview ruler. ([Q17](#q17))

### 8.3 The stop line

<a id="lr6"></a>**LR6. The stop line holds up to twelve entries: VS Code clips it at laptop widths, and JetBrains draws
it in the editor's font with no icon.** `apps/vscode/src/run-view.ts:1058-1074` adds the paused text, five controls and
five code actions to the line's own lens; in VS Code 1.143.1 at 1440 px with the side bar open the row is cut at Mock
(1053 px in a 1014 px box), and [real-editor-checks.md](real-editor-checks.md) §3 records that the screenshot scene
closes the side bar to show it whole. JetBrains' `StopInlay` uses `EditorFontType.PLAIN` and no icon
(`PiwiRunControl.kt:1876-1930`). **(seen)** Fix: five entries in both, the reason in the study's words, then Resume,
Step, Finish and Write code…; Run to Cursor and End Test move to the hover and the context menu ([LR3](#lr3)), the
line's own lens hides meanwhile, JetBrains takes Code Vision's font and the gutter's icon, and a nightly check fails on
a row wider than its box. ([M14](#m14), [L6](#l6))

### 8.4 The list

<a id="lr7"></a>**LR7. A live run has no home in either editor, and nothing lists a run's workers, tests or stops.** In
Rider 2026.2.4.1 the run entries, 18 since v0.68.0, sit in Tools → Piwi, grayed while no run is live, and again in the
status popup while one is (`PiwiStatusBar.kt:269-274`); VS Code shows a pause and a stop icon. `RunSession` carries each
worker's test and state (`packages/editor/src/protocol.ts:1465-1550`), which Piwi Picker's Runs window and the desktop
tray list; the editors list workers only in Watch a Worker's Test's chooser (`Worker 2 · running <test>`), reached from
the palette, Tools → Piwi, the status popup and VS Code's count item. **(seen)** The worker list is live-runs E6,
planned in the study's P6. Fix: a Runs tab in the Piwi tool window and a Runs view in VS Code (a new id: `piwi.runs`
names the MCP provider), shown while a run is live, with the Runs window's rows (the run, then Worker N with its test,
its state, Watch and Pause and Watch, a stop with its place and controls), and run control as a Tools → Piwi submenu
shown only while live; until then Watch and Pause and Watch sit in the status menu's run section. Whether VS Code's view
sits beside Failures or in the Run and Debug container is open (§13); workers as a debug session's threads are
[LI10](#li10)'s alternative. ([L1](#l1))

### 8.5 The page

<a id="lr8"></a>**LR8. Neither the paused page nor v0.68.0's worker views carry Resume, Step, Finish or the code
actions; VS Code's tabs have no icon, and JetBrains' cannot be closed.** `pausedPageHtml`
(`apps/vscode/src/run-control.ts:1457-1496`) renders a caption, Watch live, Interact and the image, and its panel sets
no `iconPath` (`apps/vscode/src/run-view.ts:516-521`). The study's P4 built lane views beside it, not in its place: VS
Code's "Piwi: worker N" (`apps/vscode/src/worker-panel.ts:211-216`, no `iconPath` either), which takes Interact at a
stop and its worker's headless stop, and JetBrains' "Worker N" tab, which only watches (`configureLive(true, false,
false)`, `PiwiRunControl.kt:853`) while the Paused Page tab opens beside it; side by side, the tabs say Watch and Watch
live for one thing. Both JetBrains tabs are made closable (`PiwiRunControl.kt:712-715, 837-839`) in a tool window
without `canCloseContents` (`plugin.xml:71-72`), so "The run ended." stays until the IDE restarts. **(seen)** for the
paused page; the worker views **(read)**. Live-runs E13 is listed under P4, which shipped the lane views without the
controls. Fix: one page per worker in both editors, the paused page joining the worker view, with Resume, Step, Finish
and the code actions (an `ActionToolbar` of `Piwi.RunControl` in JetBrains), Watch and Interact as toggles with icons
under one input rule in both clients, tabs that close, VS Code's tab icons, and an accessible name on every control.
([M15](#m15))

### 8.6 What the study's model brings

<a id="lr9"></a>**LR9. The editor's own run now reaches the status bars from the run itself, but the Testing view and
the test lines still wait for the instance.** Since v0.68.0 the run's own process reports `run-begin`, `run-progress`
and `run-end` to the hub (`packages/editor/src/run-sessions.ts:565-602`), so both status bars count it offline and with
the desktop app ([LR18](#lr18)). The workers' test-begin and test-end still feed only agents and debug runs
(`packages/editor/src/server.ts:1779-1781`), and the Testing view, the running marks and the per-test results come from
the instance (`packages/editor/src/run-watch.ts:528-627`): in VS Code 1.143.1 a running test kept its CI failed mark,
and no line shows where a running test is. **(seen)** at v0.66.0. This is live-runs E3 (E2 for the running line), listed
under the study's P4, which brought the count alone. Lands: the Testing view and the test's line from the run's own
events, a spinner while it runs and the pause or failed glyph while it waits, and the running line marked. ([L1](#l1))

<a id="lr10"></a>**LR10. A CI or teammate run of the branch reads as the developer's own, and the status bar's run link
opens the previous run.** The editor service follows any run of the branch (`packages/editor/src/run-watch.ts:528-546`)
and `LiveRun` has no URL or origin (`packages/editor/src/protocol.ts:651-666`): CI run #130 shows as `Piwi: 4/9 · 1
failing` with running marks on tests nobody here started, and with run #124 live the tooltip links `Open run #120`.
**(seen)** The link is live-runs E4, and the origin on the status bars and the Testing view comes with it, planned in
the study's P5, whose built part gives each local run a ref (`piwiRunRef`) and the public `runUrl` that the reporter
prints and neither editor reads yet; CI runs of the branch as read-only sessions are E24, planned in P10. Lands: the
origin in the status line, the tooltips and the Testing view (`CI run #130 on feature-x`), the short form for the
developer's own run, and CI runs as read-only rows of the Runs view and tab. ([L1](#l1))

<a id="lr11"></a>**LR11. Neither editor lets the developer hold failures: a headless failure waits only if the run has
breakpoints or a `page.pause()`, or a Runs window happens to be open.** `packages/editor/src/server.ts:1724-1766` and
`packages/editor/src/run-sessions.ts:1380-1395` hold in those two cases only, and neither settings page has the tray's
switch, and watching a worker in a v0.68.0 lane view does not hold its failure either. **(read)** This is live-runs
E11, planned in the study's P6 (see
[developer-loop-audit.md](developer-loop-audit.md) V4). Lands: a Hold failures toggle, with who set it, in the run
section of the status popup and the status menu and on the run's row in the Runs view and tab. ([L1](#l1))

<a id="lr12"></a>**LR12. Stuck? never reaches the editors: a test held for minutes reads as plain "running".** The
instance publishes `test-stuck` (`apps/application/server/utils/stuck-tests.ts:71`); the editor service reads only
test-begin, test-completed and the run's state (`packages/editor/src/run-watch.ts:586-610`). **(read)** Keeping a
developer's own stop out of Stuck? is built on the instance (live-runs IO11): P3 sends no `test.stuck` for a run
started on a developer's machine, and P5's stops as text keep stopped time out of Stuck?. Lands in the editors:
`Stuck? running 4 min, usually 40 s` with Open the Run Page in the gutter tooltip and the Testing view, and `· 1 stuck?`
on the status line, never for a stopped worker. ([L1](#l1))

<a id="lr13"></a>**LR13. Between the click and the run's first report, Piwi's own surfaces show nothing and offer no
Stop.** Since v0.68.0 the run's own process opens its session at `run-begin`
(`packages/editor/src/run-sessions.ts:565-602`), so Stop and `0 of 9` show from Playwright's `onBegin`. A web server's
start and a global setup run before it, often 10 to 60 s, while VS Code's controls wait for a session
(`apps/vscode/src/run-control.ts:957`), as JetBrains' Stop the Run does (`PiwiRunControl.kt:2042-2043`), and only the
terminal or the Run tab shows the run. **(seen)** at v0.66.0. Fix: a starting session from the command (`Piwi: starting
checkout › pays…`, the study's lane state `starting`) with Stop enabled. ([M14](#m14))

<a id="lr14"></a>**LR14. A run shared live has four glyphs across the tools, and JetBrains draws it with the eye that
v0.68.0 gives Watch a Worker's Test, in the same popup; its link is offered in one notification only.** VS Code draws
`broadcast`, the dashboard `radio`, the Runs window `share`, and JetBrains' status item an eye (`PiwiStatusBar.kt:135`),
which since v0.68.0 is also `Piwi.WatchWorker`'s icon in the popup that item opens (`plugin.xml:217-219`);
`Piwi.ShareRunLive` has no icon (`plugin.xml:241`). In VS Code `$(eye)` marks both Watch a worker's test
(`apps/vscode/package.json:419-423`) and Stop following the active editor (`package.json:298`). Copy sits in the share's
notification only (`apps/vscode/src/run-view.ts:854-858`). **(read)** The study adds Open beside Copy (E20, planned in
P5). Fix: one Share live glyph in the concept table, on the status item now, the eye for Watch alone, Follow off
`$(eye)`, and Copy, Open and Stop Sharing wherever the run is listed. ([M4](#m4))

### 8.7 Words deferred to the study

<a id="lr15"></a>**LR15. A stop reads "Paused" in the editors, while the run page's rows, the Runs window and the tray
word each reason, and the timelines a third way.** Since v0.68.0 the run page's rows and the tray take one set of words
per reason (`apps/application/app/utils/stop-words.ts`: "Stopped at a breakpoint", "Held at its failure"), and the
timelines say "Paused" for a Pause from any tool (#1122). Both editors still write `Paused · <call>` for every reason
and `Failed · …` at a failure (`apps/vscode/src/run-control.ts:518-524`, `Glue.kt:1669-1681`), and the timelines say
"Paused at a breakpoint" where the rows say "Stopped at a breakpoint"
(`apps/application/app/utils/timeline.ts:156-162`). **(seen)** at v0.66.0, the rest **(read)**. The per-reason words are
the study's (IO17, built in P5). Fix: the editors and `pauseReasonText` take the rows' words, which the editor service
carries for both clients (FSL words do not move into MIT `packages/core`); the per-reason row joins
[developer-loop-audit.md](developer-loop-audit.md) §9. ([Q14](#q14), [M22](#m22))

<a id="lr16"></a>**LR16. One run has a different name in each place: the VS Code task, JetBrains' console tab and runner
configuration, and the Stop and Share live choosers.** The task is its command line
(`apps/vscode/src/glue.ts:1186-1189`), the console tab `Piwi`, the choosers the tests' titles or the config folder, and
`RunCommand` carries no label (`packages/editor/src/protocol.ts:332-357`); v0.68.0's lane views and Watch's choosers
name a worker but not its run, and JetBrains titles Pause and Watch's chooser "Watch Which Worker?"
(`PiwiRunControl.kt:2165`). **(seen)** The name is the study's: the target, then **Run #78** (planned in P5), on
JetBrains' Run tabs (planned in P6, E21). Fix: the service sends that label with `RunCommand`,
and both clients use it wherever a run is named. ([M14](#m14))

<a id="lr17"></a>**LR17. One worker is "Worker 1" in the editors' worker views and "worker 0" or "worker 3" in their
stop and End the test choosers.** Since v0.68.0 the lane views, Watch's chooser, the Runs window, the tray and the
dashboard name a worker by its slot from 1 (`Glue.workerName`, `Glue.kt:1737`; `apps/vscode/src/run-control.ts:580-582`;
the study's D1, built in P1 and P4), but VS Code's stop chooser, JetBrains' new Go to rows and both "End which waiting
test?" choosers print Playwright's `workerIndex`, which grows at each restart
(`apps/vscode/src/run-control.ts:1100-1108`, `apps/vscode/src/run-view.ts:746`, `Glue.stopLabel` at `Glue.kt:1825-1828`,
`PiwiRunControl.kt:2113`). With two workers and a breakpoint in the first worker's test, the popup's row ends "worker 0"
while the tab reads "Worker 1". **(read)** Fix: the four take `workerName(parallelIndex)`, as the worker views do.
([Q24](#q24), [M22](#m22))

## 9. Rider

Rider runs the same plugin as WebStorm, with other keymaps, another project model and a .NET backend beside the specs.
What differs is RD1 to RD8 below and four findings filed elsewhere:

| What differs in Rider | Where |
|---|---|
| Piwi's chords collide in the Visual Studio, VS 2022, ReSharper and Visual Assist keymaps | [AC12](#ac12), §4.5 |
| Piwi's Code Vision group has no name | [ST11](#st11), §6.2 |
| Nothing from Piwi in the Solution Explorer or the Tests menu | [AC3](#ac3), §4.1 |
| The settings page names `.idea` paths Rider does not use | [ST13](#st13), §6.2 |

<a id="rd1"></a>**RD1. Any debug session turns off Piwi's run-control keys, so with the backend under the debugger the
run keys do nothing at a Piwi stop, in Rider and in VS Code.** `RunControlAction.update` (`PiwiRunControl.kt:2004-2010`)
disables every control invoked from a key while `XDebuggerManager.debugSessions` is not empty, whatever the session's
state (menu entries stay enabled), and VS Code's run keys carry `!inDebugMode` (`apps/vscode/package.json:827-852`).
[run-control.md](../adr/run-control.md) records the rule at line 68, as do `apps/jetbrains/AGENTS.md:114-116` and
`apps/vscode/AGENTS.md:62-64`. The debugger takes those keys only from a paused session: Rider 2026.2.4.1 enables
`Resume` and `StepOver` only on a suspended one (read from its jars), and VS Code 1.143.1 binds F5 to `debug.continue`
only when `debugState == 'stopped'`. So while the backend runs under the debugger, unpaused, Piwi gives way and the
debugger ignores the key: only the mouse works at a Piwi stop. No `PiwiRunControlTest` case holds a debug session, and
no live IDE ran this. **(read)** Fix: Resume, Step, Run to Cursor and Finish give way only to a paused session
(`debugSessions.any { it.isSuspended }`; `debugState != 'stopped'` in place of `!inDebugMode` on `f5`, `f10`, `ctrl+f10`
and `shift+f11`), while Stop (VS Code's Shift+F5) and Pause still give way to any session, which uses both. It ships
with [RD2](#rd2) in [Q18](#q18), this proposal superseding that point of run-control.md (a shipped ADR is not edited),
with both AGENTS.md bullets updated and a test holding a running, unpaused `XDebugSession`. ([Q18](#q18), [L3](#l3))

<a id="rd2"></a>**RD2. Pause the Run takes Resume's key, so in Rider's Visual Studio keymaps F5 pauses a live Piwi run
instead of starting the debugger.** `Piwi.PauseRun` has `use-shortcut-of="Resume"` (`plugin.xml:195-196`),
`PiwiRunActionPromoter` puts it first while a run is live, and `PauseRunAction` yields the key to Resume only at a stop
(`PiwiRunControl.kt:2020-2036`); Rider's Tools → Piwi shows Pause the Run and Resume the Run both on F9. Rider
2026.2.4.1's Visual Studio, VS 2022, ReSharper and Visual Assist keymaps bind F5 to `Resume`, which with no session
opens Choose Debug Configuration. While a Piwi run is live, F5 pressed to debug the backend pauses the Playwright run,
the next F5 resumes it, and the debugger cannot be started from the keyboard until the run ends. The platform's `Pause`
has keys of its own (Ctrl+Alt+Break and Ctrl+Pause in the Visual Studio keymaps, F6 in the VSCode keymap, none in
`$default`), and VS Code's Pause has none. The same menu shows Run to Caret as Alt+Shift+9, the binding of the Linux
default keymaps (`Default for XWin`, which GNOME's and KDE's extend), where `apps/docs/features/jetbrains.md:84` gives
`$default`'s Alt+F9 alone. **(seen)** Fix: `use-shortcut-of="Pause"` and no keyboard exception in `PauseRunAction`, so
Pause shares the debugger's Pause key, has none in `$default` as in VS Code, and gives way to any running session
([RD1](#rd1)); Resume's key stays on `Piwi.ResumeRun` alone. `jetbrains.md:85-86`, added since, says Piwi's key comes
first where the keymap gives it to another action too, the behavior behind F5's effect, and is reworded;
`jetbrains.md:83-86` gets a row per keymap family (default: F9, F8, Alt+F9, Shift+F8, with Run to Caret on Alt+Shift+9
in the Linux default keymaps; Visual Studio: VS Code's F5, F10, Ctrl+F10, Shift+F11).
[developer-loop-audit.md](developer-loop-audit.md) P13 records the key as a parity difference; its effect in Rider is
new. ([Q18](#q18))

<a id="rd3"></a>**RD3. Specs beside a Rider solution, a layout the plugin's config search supports, may get no
highlighting in Rider, and Debug in my editor refuses them.** `findPlaywright` searches the Git repository when the
solution's folder holds no config (`Glue.kt:136-150`), but Rider 2026.2.4.1's `RiderHighlightingSettingProvider` returns
`SKIP_HIGHLIGHTING` for a file neither indexed nor in the project model. `debugRefusal` (`PiwiOpenHandler.kt:196-206`)
takes the raw `basePath`, `<solution>/.idea/.idea.<Name>` in Rider, and the content roots, so it answers "is outside the
project's folders" while `locate` (`PiwiOpenHandler.kt:235-255`) finds the same file for Open in IDE.
`examples/sample-app` has this layout. **(read)** Fix: one root list in `PiwiProjectService` for both, with a
`PiwiOpenHandlerTest` case, and a balloon in Rider when a config folder lies outside the solution, whose action runs
Rider's `AttachFolderAction` by id. ([Q19](#q19), [M17](#m17))

<a id="rd4"></a>**RD4. No check ever launches Rider, so its C# surfaces are unverified, yet the docs say the plugin is
checked on Rider.** `apps/docs/features/editor-coverage.md:126-128` says so; Rider gets only the Plugin Verifier, when
`all-ides` is set (`.github/workflows/reusable-jetbrains.yml:70`), and `apps/jetbrains/scripts/take-screenshots.mjs:78`
finds WebStorm only. Code Vision and the diagnostics run in the frontend, where JetBrains' docs say C# elements are not
visible; only a run settles it. **(read)** Fix: "verified for compatibility with Rider" in `editor-coverage.md:127`
until a Rider scene on `examples/sample-app/backends/aspnetcore` checks [RD3](#rd3), a controller's marks, lens and
diagnostics, [AC3](#ac3) and [AC12](#ac12). ([Q21](#q21), [M17](#m17))

<a id="rd5"></a>**RD5. Rider bundles the IDE's Playwright runner, but the code says it does not, and the setting grays
out with no reason where the runner is missing.** Rider 2026.2.4.1's folder menu offers the runner's Run 'Tests in
tests/', yet the KDoc at `PiwiPlaywrightRunner.kt:16-19` names WebStorm and IntelliJ IDEA Ultimate only, and
`PiwiConfigurable.kt:116` disables its checkbox without saying why. **(seen)** Fix: name Rider, document the option on
`jetbrains.md`, and say why the checkbox is off. ([Q21](#q21))

<a id="rd6"></a>**RD6. A Rider team whose Playwright tests are written in C# gets no Piwi tool window or status item,
and nothing says why.** The Marketplace description never says that only Playwright Test for JavaScript and TypeScript
is read (`plugin.xml:9-48`), and all but Tools → Piwi wait for a `playwright.config.*`. **(read)** Fix: say it in the
description and the docs, and show one balloon in Rider when a `*.csproj` references `Microsoft.Playwright*`; reading
such suites is [L7](#l7)'s decision. ([Q21](#q21), [M17](#m17), [L7](#l7))

<a id="rd7"></a>**RD7. A C# controller, like any application file, gets one "Reached by N tests" line above its usings
and nothing per action or endpoint.** `packages/editor/src/server.ts:2993-3008` puts the line at `line: 0`, and the
route manifest keeps only each handler's file
(`integrations/aspnetcore/PiwiTests.Instrumentation.AspNetCore/PiwiRouteManifest.cs:26`). **(read)** Fix: an optional
`line` per manifest route, read in the same PDB pass, and a lens per action
(`GET /api/orders/{id} · 4 tests · 1 failing`) in both editors. ([L4](#l4))

<a id="rd8"></a>**RD8. The dashboard prints .NET stack frames and route handlers as plain text, with no Open in IDE link
to Rider.** Server-log stacks are a `<pre>`
(`apps/application/app/components/test-case/TestCaseNetworkRequests.vue:568-571`). **(read)** Fix: `OpenInIdeLink` on
`in <path>:line N` frames and on Test Map handler nodes, at the handler's line once [RD7](#rd7) adds it. ([L4](#l4))

The Rider checks still open are §13's question 18; each needs a Rider scene ([M17](#m17)), not new tooling.

## 10. The larger items

Twenty items carry the principles of §2, each built over one or more steps of [§12](#12-the-plan). They are FSL work
(`packages/editor`, the clients, the dashboard, the desktop app) but for three pieces written anew on the MIT side: the
pause bar's glyphs in `packages/picker-dom` ([LI2](#li2)), two coverage colors in `packages/core` ([LI3](#li3)) and the
.NET pieces in `integrations/` ([LI17](#li17)); no code moves from FSL into MIT.

**Vocabulary (principles 1 and 7).**

<a id="li1"></a>

### LI1. One action catalog and one words table for both editors

`packages/editor/src/actions.ts` lists each action once: its ids, one wording recased per platform, a short label, its
concept ([LI2](#li2)), menus ([LI4](#li4)), when it applies, keys ([LI15](#li15)), synonyms and a docs anchor;
`src/words.ts` holds the words a client writes itself. The words of watching are the live-run study's
([live-runs.md](live-runs.md) D6: words in the FSL surfaces, enums in `@piwitests/core/live-lane`), and the catalog
keeps the editors' copy under the study's drift test. A vitest test holds both manifests to it first; later it generates
`package.nls.json`, a `PiwiBundle.properties` and `editors.md`'s commands table. **Lives in** `packages/editor` (FSL);
the pause bar (MIT) is read by the test, never fed. **Replaces** titles kept twice by hand and four hand-built popups.
**Depends on** nothing. **Revisits** [editor-extensions-audit.md](../adr/editor-extensions-audit.md) §3.6 (the case
split judged good) if Title Case wins, and makes [developer-loop-audit.md](developer-loop-audit.md) §9 a tested
artifact. Steps [M1](#m1), [M2](#m2), [M22](#m22).

<a id="li15"></a>

### LI15. Keys from one table, checked against every bundled keymap

Chords and run-control keys sit in the catalog per keymap family and generate VS Code's keybindings, `plugin.xml`'s
per-keymap entries and both docs tables; a unit test resolves the keymaps bundled with WebStorm, IDEA Ultimate and
Rider, and VS Code's defaults, and fails on a collision. One rule: Resume, Step, Run to Cursor and Finish give way to a
paused debugger only, Pause and Stop to any session, and Pause takes the platform Pause action's key. **Lives in**
`packages/editor` and both clients (FSL). **Replaces** three chords Rider's Visual Studio-family keymaps already bind,
run keys dead under any debug session, F5 pausing the run. **Depends on** [LI1](#li1). **Revisits** the IDE half of
[run-control.md](../adr/run-control.md)'s Status (no keys under a debug session, Pause on Resume Program's key) and
[developer-loop-audit.md](developer-loop-audit.md) P13; the ADR stays as written and the rule is recorded here. Steps
[Q17](#q17), [Q18](#q18), [M16](#m16).

**Look (principles 2 and 3).**

<a id="li2"></a>

### LI2. One concept table and a Piwi icon set built with the brand assets

A concept table gives each concept its glyph in every tool's set (Appendix A).
`apps/application/scripts/generate-brand-assets.mjs`, which already writes both editors' Piwi mark, also writes what the
platforms lack, drawn once from Piwi Picker's outline set (`apps/extension/src/shared/icons.ts`): the mark at New UI
sizes, record, plug, flaky, region, mock, broadcast and the rest Appendix A marks (new), with `_dark` and `expui/`
variants. A test reads every manifest and icon map and fails on a missing or different glyph. **Lives in**
`packages/editor` or `apps/application/shared` (§13), FSL; the pause bar's glyphs are drawn anew in picker-dom (MIT).
**Replaces** the film strip for record, the triangle for flaky, the person for Connect, four glyphs with two meanings.
**Depends on** nothing. **Revisits** [editor-local-runs.md](../adr/editor-local-runs.md) 6b and 6c (each editor chose
its tree icons) and the status item's icons, which [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7
asked for without naming any. Steps [Q9](#q9), [M4](#m4), [M6](#m6).

<a id="li3"></a>

### LI3. One outcome palette and mark kit, generated from STATUS_COLORS

`STATUS_COLORS` (`apps/application/shared/status-colors.ts`) and the dashboard's `getStatusIcon` shapes become every
tool's outcome marks, plus the states only the editors draw: unknown, paused, held failure, recording. A script writes
VS Code's `media/test-*.svg`, the JetBrains state icons, the held failure's execution point and the constants of Piwi
Picker's dots and the tray's dot; a `status-mark-colors.test.ts`, beside `coverage-mark-colors.test.ts`, reads every
copy and both JetBrains color schemes. **Lives in** `apps/application` and each tool's assets (FSL); the status palette
never moves into core, where `COVERAGE_MARK_COLORS` stays and gains the changed and uncovered-change colors.
**Replaces** `General.Warning` for flaky, an amber failed, a run button for running, the tray's own palette. **Depends
on** nothing. **Revisits** [desktop-run-progress.md](desktop-run-progress.md), whose tray dot took colors of its own.
Steps [Q2](#q2), [Q12](#q12), [Q17](#q17), [M5](#m5).

**Places (principles 4 and 5).**

<a id="li4"></a>

### LI4. One Piwi menu, the same shape in every place

Six sections in a fixed order: Run, Record, Run Control (only while a Piwi run is live), Dashboard, Agents, Connection,
each showing only what applies. The same shape fills Tools → Piwi as nested compact groups, a Piwi submenu in both
editors' context menus and file trees, the status popup, a new VS Code status menu (a quick pick with the state's action
preselected, so Enter still refreshes) and the tool window's gear; whether a chord also opens it is open (§13). **Lives
in** the catalog's menu fields and both manifests (FSL); ids stay. **Replaces** 40 flat rows, loose rows in both editor
menus, nothing in either file tree, a VS Code status click that only refreshes. **Depends on** [LI1](#li1). **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 (a status popup in JetBrains only) and §3.6, which
called VS Code's status bar the control center. Steps [Q3](#q3), [Q8](#q8), [M3](#m3).

<a id="li5"></a>

### LI5. One Piwi home per editor

Both homes list the same places in one order: Failures, Runs ([LI9](#li9)), the page, the log, and in JetBrains Get
Started ([LI12](#li12)). The Piwi tool window makes each a tab (Log is new), and its Paused Page and v0.68.0's Worker N
tabs become one worker tab ([LI9](#li9)); VS Code's Piwi panel holds Failures and Runs, its overflow menu opening the
page (an editor tab) and the log. One Failures toolbar order in both ([HM6](#hm6), [HM7](#hm7)), JetBrains' Open in
Dashboard acting on the selection; the service sends the view's state and words, node icon keys and tooltips, and a
'Flaky in this run' group. **Lives in** `failure-tree.ts`, `protocol.ts` and both clients (FSL). **Replaces** a
15-button toolbar with two identical globes, seven buttons shown while disconnected, two misreported empty states.
**Depends on** [LI1](#li1), [LI6](#li6). **Revisits** no decision: [editor-local-runs.md](../adr/editor-local-runs.md)
Part 6 built the two trees apart. Steps [Q7](#q7), [Q8](#q8), [M18](#m18), [M19](#m19).

<a id="li7"></a>

### LI7. One test line: one action list, Debug with Piwi, and a test card

The service sends each test line one grouped action list (`piwi/testActions`): Run with Piwi, Debug with Piwi and Verify
×3; Trace, Screenshot and Open in Dashboard; Copy Context for Agent; Record Here; the desktop jobs. JetBrains draws it
on the result icon's either click and on the IDE run icon (`JSTestRunLineMarkersAdditionalActionGroup`); VS Code in its
Testing menus and the hover. The gutter acts, the hover explains, the lens informs, quick fixes only edit. Debug with
Piwi builds the dashboard's Debug in my editor run (`RunTestsArgs.debug`) for a failure; a later `piwi/testCard` adds
history, flaky rate, owner and quarantine. **Lives in** `packages/editor` and both clients (FSL). **Replaces** anonymous
gutter actions, a click that opens a browser, five names for run. **Depends on** [LI1](#li1). **Revisits**
[developer-loop-audit.md](developer-loop-audit.md) P1 (Run and Verify ×3 on the result icon built, the run line marker
left) and the line's command, `piwi.openInDashboard` (`packages/editor/src/server.ts:2913-2917`). Steps [Q11](#q11),
[M7](#m7) to [M9](#m9), [L5](#l5).

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
the IDE's Playwright runner, not built). Steps [M8](#m8), [M9](#m9), [M20](#m20), [L2](#l2).

<a id="li9"></a>

### LI9. Where the editors host a live run

Glance: one status item and one menu per editor, the menu's run section the Run Control group; the line's run part (`Run
#78 · 3 of 9 · Open`, progress kept at a stop) is the study's P5; the count is built ([LR18](#lr18)). Steering, with no
debug session: VS Code's `editor/title` strip in the debug toolbar's order and a Run Control group in `editor/context`;
JetBrains' `RunMenu`, `EditorPopupMenu` and a Run tab per console run, named after its target with Pause and Step (the
study's P6), as a `RunContentDescriptor` Piwi builds. In the code: a five-entry stop line, a red execution point at a
held failure, Go to the Stopped Line, a starting state with Stop. List: a Runs view and tab, filled by P4 (progress), P5
(Run #N, origin), P6 (each worker's test, Hold failures), P9 (Share live) and P10 (CI runs, read-only). Page: one page
per worker with its controls, the paused page joining the worker views P4 built beside it ([LR8](#lr8)). **Lives in**
both clients and `packages/editor` (FSL). **Replaces** seven icon-only status items, a clipped stop line, Run tabs
titled 'Piwi'. **Depends on** [LI1](#li1), [LI6](#li6), the study's phases. **Revisits**
[run-control.md](../adr/run-control.md) §3.2 and its Status, which gave up the Run tab's toolbar because
`RunContentExecutor` fixes it: Piwi builds the descriptor itself. Steps [Q17](#q17), [M13](#m13) to [M15](#m15),
[L1](#l1).

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
dashboard's words (`formatStatusLabel`), and the verdict; clients keep one icon-key map and their casing. A cheaper
first step runs one JSON of inputs and outputs through `glue.ts` and `Glue.kt`. Alert only for failures new against the
baseline that a run started here, or local edits, produced (§13). **Lives in** `packages/editor` (FSL). **Replaces**
`statusBarView` and `Glue.statusView`, `testResultHover` and `testResultTooltip`, `connectionSummary`, two verdict
builders. **Depends on** nothing. **Revisits** no decision: it applies `apps/vscode/AGENTS.md`'s rule that a client
holds no logic the other needs, which the status popup of
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 put in the client. Steps [Q7](#q7), [Q11](#q11),
[M13](#m13), [M21](#m21), [M22](#m22).

**Settings and first steps (principles 7 and 8).**

<a id="li11"></a>

### LI11. One settings registry for both editors

`packages/editor/src/settings.ts` gives each option its key, type, default, scope (team, user, machine), group and
order, labels, description, synonyms and docs anchor, as `apps/application/shared/piwi-env-vars.ts` drives the
configuration reference. It generates VS Code's ordered categories, the JetBrains rows or a check of them, a docs table
and the walkthrough's settings step. New switches go through it: `piwi.codeLens`, `gutterIcons`, `coverageMarks`,
`locatorWarnings`, `failingTestTint`, `statusBarAlert` ([HM2](#hm2)) and, if the study's per-run Hold failures (P6)
needs a default, `holdFailures` ([LR11](#lr11)), read by the service to filter once for both clients. **Lives in**
`packages/editor` (FSL). **Replaces** an alphabetical list of code values, scopes that differ per editor, comments
naming wrong paths in Rider. **Depends on** nothing. **Revisits** [1.0-stabilization.md](1.0-stabilization.md) D25,
which freezes `piwi.serverUrl` and `piwi.project` only: the new keys are registered there before 1.0. Steps [Q4](#q4),
[Q5](#q5), [M10](#m10).

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
the settings page and as one dialog: the desktop app with its projects, the URL with Test Connection, the key with Sign
In…, Paste Key… and Remove, a project combo from the instance. The sign-in is a non-modal dialog with Copy Code and Copy
Link (VS Code's gains Copy Link); errors come from one table, and waiting for trust and a Node.js start problem become
states with their fix. **Lives in** `PiwiConnect.kt`, `PiwiConfigurable.kt` and the service's words (FSL). **Replaces**
up to five modal dialogs, a project typed by hand on the settings page, a page that reads None while connected.
**Depends on** [LI6](#li6). **Revisits** no earlier decision. Steps [Q5](#q5), [Q6](#q6), [M12](#m12).

**Messages (principle 8).**

<a id="li14"></a>

### LI14. One notification policy by kind

Each message has one kind and one surface per tool: a result, a request (Debug in my editor, a share link: sticky), an
offer (one at a time), a problem, a confirmation (in the status bar). JetBrains gets a notification group per kind and
one `PiwiNotifier` that titles and icons every balloon; VS Code's run notice gains an Only on Failure button. `RunEnded`
carries the verdict's words for every run the editor followed, a terminal run's once the study's P7 gives every local
run a hub. Attention on a live run ([HM17](#hm17)) is the study's P6; in a background editor its interrupt is
`AppIcon.requestAttention` or a VS Code notification. **Lives in** both clients and `RunEnded` (FSL). **Replaces** one
balloon group for everything, two hand-worded verdicts. **Depends on** [LI6](#li6). **Revisits** no decision of its own.
Steps [Q13](#q13), [Q16](#q16), [M21](#m21).

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
this plan, which leaves Rider out of capture. Steps [Q19](#q19), [Q21](#q21), [M17](#m17).

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
the latest IDEs. The copy actions stay for older IDEs; an agent outside the IDE takes the study's P8 router,
`npx @piwitests/reporter mcp`. **Lives in** `apps/jetbrains` (FSL). **Replaces** a token-bearing configuration pasted
into each agent after every reset. **Depends on** [LI4](#li4). **Revisits** the premise that the platform has no public
way to register an MCP server (`PiwiActions.kt:344-345`). Step [M23](#m23).

**Checks (principle 9).**

<a id="li19"></a>

### LI19. Both editors checked on the shared fixture, without a JetBrains license

Four layers: the catalog and concept-table tests ([LI1](#li1), [LI2](#li2)); golden fixtures through `glue.ts` and
`Glue.kt`; JetBrains platform tests on the 2024.1 test platform, which needs no license, drawing the editor fixture's
spec (`CodeVisionTestCase`, `findAllGutters`) and comparing it with a snapshot VS Code's nightly suite takes of the same
fixture; the keymap test ([LI15](#li15)). The nightly suite adds layout checks (no lens row wider than its box, a flaky
mark on a flaky test), and the JetBrains screenshot script checks the status item before writing ([HM20](#hm20)).
**Lives in** `apps/vscode/tests`, `apps/jetbrains/src/test` and `.github` (FSL). **Replaces** JetBrains checks that
never look at what the IDE draws. **Depends on** [LI1](#li1), [LI2](#li2). **Revisits**
[real-editor-checks.md](real-editor-checks.md) D1 to D3, which wait for a CI license before any JetBrains check of what
is drawn. Steps [Q1](#q1), [Q15](#q15), [L6](#l6).

**Hand-offs (principles 1 and 2).**

<a id="li20"></a>

### LI20. A hand-off contract with a way back

Each hand-off between the tools (Open in editor, Debug in my editor, Send to editor, Open in dashboard, Reproduce or
bisect, Share live, Pair with Piwi Picker, and since v0.68.0 Run on my machine, from the dashboard to the desktop app or
Piwi Runner) is one row: verb, glyph, label at both ends, how the landing confirms it, the way back. The dashboard says
Open in editor and names the entry that reaches Piwi's plugin; the desktop app says Pair and calls itself Piwi Desktop;
an editor whose source is the desktop app opens pages through `piwi://open/<page>`
(`apps/desktop/src-tauri/src/lib.rs:238-255`); a debug run from the dashboard reads 'Following run #81 in VS Code ·
Open' there (the study's P5) and offers Back to the failure in the editor. A test holds every label to the table, and
the docs' hand-offs table is generated from it. **Lives in** a table beside the concept table (FSL). **Replaces** one
destination under two names, 'Connect' meaning two things. **Depends on** [LI2](#li2). **Revisits**
[bug-report-to-failing-test.md](../adr/bug-report-to-failing-test.md)'s 'Connect Piwi Picker' card and
`tauri.conf.json`'s productName 'Piwi Dashboard'. Steps [Q22](#q22), [Q23](#q23), [M24](#m24).

## 11. Defects to file

The confirmed defects, filed on `PiwiTests/piwi` as #1115 to #1123, grouped by area as the repository's issues are; no
open or closed issue matched any of them. Rechecked at v0.68.0: #1122 was closed once its timeline item (row 16) was
fixed, and its rows 14, 23 and 24 still hold; every other row still holds; rows 27 and 28 are new, filed as #1213.

| # | Defect | Findings | Issue |
|---|---|---|---|
| 1 | JetBrains Code Vision keeps the last entry of a line, so a failing line reads 'Trace' alone (`PiwiCodeVisionProvider.kt:37-44`) | [TL16](#tl16) | #1115 |
| 2 | VS Code's Testing view draws a flaky test as a plain pass with default settings (`apps/vscode/src/glue.ts:1489-1496`) | [TL13](#tl13) | #1116 |
| 3 | Any debug session, suspended or not, turns off Piwi's run-control keys, and Pause takes F5 from the debugger in Rider's Visual Studio keymaps (`PiwiRunControl.kt:2004-2010`, `plugin.xml:196`) | [RD1](#rd1), [RD2](#rd2) | #1117 |
| 4 | Rider: Debug in my editor refuses a spec beside the solution folder that Open in IDE opens (`PiwiOpenHandler.kt:196-206`) | [RD3](#rd3) | #1118 |
| 5 | The Ctrl+Alt+Shift R, K and F chords collide with Rider's Visual Studio, ReSharper and Visual Assist keymaps (`plugin.xml:108, 126, 160, 173`) | [AC12](#ac12) | #1117 |
| 6 | Settings search and Find Action cannot find any Piwi option: no searchable-options index is built (`build.gradle.kts:95`) | [ST10](#st10) | #1119 |
| 7 | Piwi's Code Vision group has no name, so the Code Vision settings do not list it (`PiwiCodeVisionProvider.kt:19-21`) | [ST11](#st11) | #1115 |
| 8 | In an untrusted JetBrains project the status item, the Piwi tool window and the settings page say Piwi starts when a file opens, and trusting the project starts nothing (`PiwiProjectService.kt:215-220`, `Glue.kt:277, 795`) | [ST17](#st17) | #1119 |
| 9 | Settings → Tools → Piwi: Connect… applies every pending edit, Disconnect drops them or does nothing, and errors show raw Java text (`PiwiConfigurable.kt:209-218`, `PiwiConnect.kt:345-353`) | [ST19](#st19), [ST20](#st20) | #1119 |
| 10 | Settings → Tools → Piwi clips its comments and scrolls sideways (`PiwiConfigurable.kt:88-103, 124-131`) | [ST14](#st14) | #1119 |
| 11 | The editor screenshots on the docs and the Marketplace show lens counts and a status item the editors never draw (`apps/vscode/scripts/lib/editor-fixture.mjs:572`) | [ST6](#st6), [HM20](#hm20) | #1123 |
| 12 | The Piwi tool window's Open in Dashboard ignores the selected failure and opens the run page, as the globe beside it does (`PiwiActions.kt:141-166`) | [HM5](#hm5) | #1120 |
| 13 | Both homes call an unreachable instance 'not connected' and a project with no run 'no failure' (`PiwiFailuresToolWindow.kt:169-177`, `apps/vscode/src/failures-view.ts:126-127`) | [HM8](#hm8) | #1120 |
| 14 | At a stop or a live share, JetBrains' status item drops the run's progress, and VS Code's keeps spinning at a stop (`PiwiStatusBar.kt:116-148`, `apps/vscode/src/glue.ts:116-120`) | [LR2](#lr2) | #1122 |
| 15 | The JetBrains Paused Page tab, and since v0.68.0 the Worker tab, can never be closed (`plugin.xml:71-72`, `PiwiRunControl.kt:712-715, 837-839`) | [LR8](#lr8) | #1120 |
| 16 | The run page's timeline labels every Pause 'Paused from the editor': fixed in v0.68.0 (`66e60429`) | [LR15](#lr15) | #1122 |
| 17 | VS Code lists Piwi commands that do nothing without a connection, and JetBrains enables their twins (`apps/vscode/package.json:478-635`, `PiwiActions.kt:141-166, 249-295`) | [AC4](#ac4) | #1120 |
| 18 | A test's summary reads 'failing · passed 44/48 · failed' and prints raw status ids (`packages/editor/src/server.ts:2884-2888`) | [TL10](#tl10) | #1121 |
| 19 | `editors.md` says a click on a spec's lens opens the test in the dashboard, though the click runs every test of the spec, and no lens says what its click does (`apps/docs/features/editors.md:52`) | [TL11](#tl11) | #1121 |
| 20 | JetBrains' failing-test tint stops at the end of the text (`PiwiTestAnnotator.kt:68, 71`) | [TL14](#tl14) | #1121 |
| 21 | A failure from the developer's own run is labeled `ci-failure` in the Problems panel (`packages/editor/src/server.ts:1225`) | [TL12](#tl12) | #1121 |
| 22 | With the Testing view off, VS Code's gutter icon does nothing, and a test with no recent result gets no mark or hover (`apps/vscode/src/extension.ts:438-474`) | [TL6](#tl6) | #1116 |
| 23 | At a stop, VS Code's lens row runs past the editor's edge and hides the code actions (`apps/vscode/src/run-view.ts:1058-1074`) | [LR6](#lr6) | #1122 |
| 24 | VS Code's run-control status items share one name, read codicon ids to screen readers and name keys that may not apply (`apps/vscode/src/run-view.ts:298`, `apps/vscode/src/run-control.ts:988-1018`) | [LR1](#lr1) | #1122 |
| 25 | Once the editor service has stopped, VS Code's Failures view offers Refresh, which fails (`apps/vscode/src/extension.ts:1083-1086`) | [HM14](#hm14) | #1120 |
| 26 | Run This Spec leaves out the tests the instance does not know yet, and refuses a new spec (`apps/vscode/src/extension.ts:1013-1023`, `PiwiCommands.kt:196-205`) | [AC16](#ac16) | #1121 |
| 27 | One worker is 'Worker 1' in the worker views and `workerIndex` in the stop and End the test choosers (`Glue.kt:1825-1828`, `apps/vscode/src/run-control.ts:1100-1108`) | [LR17](#lr17) | #1213 |
| 28 | A desktop app that fails the token proof reads 'unreachable' with Retry (`packages/editor/src/context.ts:637`) | [HM8](#hm8) | #1213 |

## 12. The plan

Ranked by what each change buys a developer per day, then by size; each step is one pull request under the commit scope
in its row unless the row names more, and each quick win lands with the test that holds it.

### Quick wins

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="q1"></a>Q1 | **Every Code Vision entry of a line drawn, under a group named Piwi**; a `CodeVisionTestCase` on the editor fixture expects VS Code's row | `ide` | [TL16](#tl16), [ST11](#st11) |
| <a id="q2"></a>Q2 | **A flaky or unknown test never hidden on its line**: VS Code keeps a flaky tag, description and after-line mark while the Testing view owns the gutter, JetBrains a flaky icon in the dashboard's color; `glue.test.ts` and `GlueTest` | `ide` | [TL13](#tl13), [TL6](#tl6), [IC4](#ic4) |
| <a id="q3"></a>Q3 | **Tools → Piwi compact, and one Piwi submenu in both context menus**, same sections, ids kept; a platform test lists the group at rest | `ide` | [AC1](#ac1), [AC2](#ac2) |
| <a id="q4"></a>Q4 | **Settings search finds Piwi's options**; a `PiwiPluginTest` case | `ide` | [ST10](#st10) |
| <a id="q5"></a>Q5 | **The JetBrains settings page opens on the connection in use, wraps its comments and keeps Cancel**; worded certificate and 404 errors; `GlueTest` cases | `ide` | [ST9](#st9), [ST14](#st14), [ST18](#st18), [ST19](#st19), [ST20](#st20) |
| <a id="q6"></a>Q6 | **A project in safe mode says Piwi waits for trust, and trusting starts it**; a platform test in an untrusted project | `ide` | [ST17](#st17) |
| <a id="q7"></a>Q7 | **Honest empty states and gated commands in both failures views**: the view's state and words from the service, JetBrains' Refresh left enabled (it restarts a stopped service); `failure-tree.test.ts` | `ide` | [HM8](#hm8), [HM7](#hm7), [AC4](#ac4) |
| <a id="q8"></a>Q8 | **The JetBrains tool window: one Group By, a gear menu, Open in Dashboard on the selection, a tab named Failures**, with Refresh Latest Run (a new `Piwi.RefreshRun`, in D25), the status popup's sections and the node tooltips; `GlueTest` | `ide` | [HM5](#hm5), [HM6](#hm6), [HM3](#hm3), [AC10](#ac10), [HM13](#hm13), [HM12](#hm12), [HM9](#hm9) |
| <a id="q9"></a>Q9 | **An icon on every action, from the platform sets**, checked on 241, 262 and the 1.91 engines floor; failed as the red `TestError` until §13 settles it; a manifest test fails on an action without one, but for those waiting for M4's drawn glyphs (Appendix A's (new) rows) | `ide` | [IC1](#ic1), [IC3](#ic3), [IC10](#ic10), [IC11](#ic11), [AC5](#ac5) |
| <a id="q10"></a>Q10 | **Run, Verify and Record from VS Code's editor title** on a spec, one icon by state; new ids in D25; a test of the `editor/title` entries | `ide` | [AC5](#ac5) |
| <a id="q11"></a>Q11 | **One summary per test line in the dashboard's words, and lenses that say what a click does**; 'Local failure:' in the message until §13 settles a `local-failure` code; a service test holds the wording | `ide` | [TL10](#tl10), [TL11](#tl11), [TL12](#tl12), [HM4](#hm4) |
| <a id="q12"></a>Q12 | **The failing line and the coverage marks drawn alike in both editors**; `coverage-mark-colors.test.ts` | `ide` | [TL14](#tl14), [TL8](#tl8), [TL15](#tl15) |
| <a id="q13"></a>Q13 | **JetBrains balloons titled, iconed and grouped by kind**; Only on Failure on both run notices; a platform test reads each balloon's group and title | `ide` | [HM18](#hm18), [HM15](#hm15) |
| <a id="q14"></a>Q14 | **The timelines word each stop as the run page's rows do** (`stop-words.ts`); a unit test of the reason text | `ui` | [LR15](#lr15) |
| <a id="q15"></a>Q15 | **Screenshots that show what the editors draw**: the editor fixture answers per file; the JetBrains script checks the status item's icon and color before writing | `ide` | [ST6](#st6), [HM20](#hm20) |
| <a id="q16"></a>Q16 | **A stopped VS Code service can be restarted, and its errors stop popping toasts**; an integration-suite case | `ide` | [HM14](#hm14), [HM19](#hm19) |
| <a id="q17"></a>Q17 | **VS Code's nine run items named, announced and honest about keys; a held failure marked red**; `run-control.test.ts` | `ide` | [LR1](#lr1), [LR5](#lr5) |
| <a id="q18"></a>Q18 | **Run keys give way only to a paused debugger in both editors, and Pause leaves F5 to the debugger in Rider**; VS Code's four keys on `debugState != 'stopped'`, both AGENTS.md bullets updated; a `PiwiRunControlTest` case with a running session | `ide` | [RD1](#rd1), [RD2](#rd2) |
| <a id="q19"></a>Q19 | **Specs beside a Rider solution open and debug alike**: one list of project roots; a `PiwiOpenHandlerTest` with a sibling `e2e/` | `ide` | [RD3](#rd3) |
| <a id="q20"></a>Q20 | **Run This Spec runs every test of the file as it stands**, by location; a service test of a spec the instance does not know | `ide` | [AC16](#ac16) |
| <a id="q21"></a>Q21 | **The listings and the editor pages say what Piwi needs, reads and checks**; `docs-drift.test.ts` holds both listings | `docs` | [ST5](#st5), [RD6](#rd6), [RD5](#rd5), [RD4](#rd4) |
| <a id="q22"></a>Q22 | **The dashboard says Open in editor, and which entry reaches Piwi's plugin**; the localStorage keys kept; `ide-links.test.ts` | `ui` | [AC14](#ac14) |
| <a id="q23"></a>Q23 | **The desktop app names itself Piwi Desktop, and says Pair**; productName once its upgrade path is checked (§13); a test reads `tauri.conf.json` against `ECOSYSTEM_PIECES` | `desktop` | [AC13](#ac13), [AC15](#ac15) |
| <a id="q24"></a>Q24 | **One name per worker in both editors**: the stop chooser, JetBrains' Go to rows and both End the test choosers take `workerName(parallelIndex)`; `glue.test.ts` and `GlueTest` | `ide` | [LR17](#lr17) |

### Medium

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="m1"></a>M1 | **One action catalog, held against both manifests** ([LI1](#li1)); waits on the Title Case question | `ide` | [X1](#x1), [AC7](#ac7), [AC8](#ac8), [AC9](#ac9), [AC10](#ac10) |
| <a id="m2"></a>M2 | **Registered actions in every JetBrains popup**, the stop in a `DataKey`, Find Action synonyms; new ids in D25 | `ide` | [AC6](#ac6), [HM11](#hm11) |
| <a id="m3"></a>M3 | **One Piwi menu in every place** ([LI4](#li4)), New → Playwright Test (Recorded)… included; after M1 and M2; Piwi Picker's popup and the tray take its order and words in their own pull requests | `ide` | [AC1](#ac1), [AC3](#ac3), [HM1](#hm1), [X3](#x3) |
| <a id="m4"></a>M4 | **A Piwi icon set generated with the brand assets** ([LI2](#li2)), one failure-tree node table for both clients | `ide` | [X2](#x2), [IC2](#ic2), [IC7](#ic7), [IC8](#ic8), [IC9](#ic9), [LR14](#lr14) |
| <a id="m5"></a>M5 | **One outcome palette, generated and tested** ([LI3](#li3)); the editors, Piwi Picker and the tray take it in their own pull requests | `ui` | [IC4](#ic4), [IC3](#ic3), [TL5](#tl5) |
| <a id="m6"></a>M6 | **One glyph and one order per run control in the Runs window and the pause bar**, the pause bar's glyphs drawn anew in picker-dom (MIT); the desktop worker in a `desktop` pull request | `extension` | [IC5](#ic5), [IC6](#ic6) |
| <a id="m7"></a>M7 | **One action list per test line, from the service** (`piwi/testActions`), in JetBrains' result icon, VS Code's Testing menus and, with the Testing view off, `editor/lineNumber/context` | `ide` | [TL2](#tl2), [TL7](#tl7), [TL9](#tl9), [TL6](#tl6) |
| <a id="m8"></a>M8 | **Debug with Piwi in both editors** | `ide` | [TL17](#tl17) |
| <a id="m9"></a>M9 | **Piwi on the IDE run icon in JetBrains, and its result icon switchable**; the editor fixture gets a real `@playwright/test` | `ide` | [TL3](#tl3), [TL4](#tl4) |
| <a id="m10"></a>M10 | **One settings registry and grouped settings pages** ([LI11](#li11)); the new keys in D25 before 1.0 | `ide` | [ST7](#st7), [ST8](#st8), [ST12](#st12), [ST15](#st15), [ST13](#st13) |
| <a id="m11"></a>M11 | **One onboarding script** ([LI12](#li12)): JetBrains' Get Started tab, a walkthrough with images, one first-run queue | `ide` | [ST1](#st1), [ST2](#st2), [ST3](#st3), [ST21](#st21), [ST4](#st4) |
| <a id="m12"></a>M12 | **One Connect panel and a non-modal sign-in in JetBrains** ([LI13](#li13)) | `ide` | [ST16](#st16) |
| <a id="m13"></a>M13 | **The status item as one view model**, the alarm for new failures only, VS Code's run items, its count item included, folded into the one item and its status menu, one count worded once (`3 of 9`); the run part follows the study's P5 (live-runs E4, E14) | `ide` | [HM2](#hm2), [LR2](#lr2), [LR1](#lr1), [LR18](#lr18) |
| <a id="m14"></a>M14 | **Run controls where the debugger keeps its own**, as [LI9](#li9) places them; after M2 | `ide` | [LR3](#lr3), [LR6](#lr6), [LR4](#lr4), [LR13](#lr13), [LR16](#lr16) |
| <a id="m15"></a>M15 | **One page per worker, with the controls as `Piwi.RunControl`'s toolbar, and tabs that close**: the paused page joins the worker views the study's P4 built (live-runs E13); Watch and Interact as toggles with icons under one input rule, VS Code's tab icons, an accessible name on every control | `ide` | [LR8](#lr8) |
| <a id="m16"></a>M16 | **Per-keymap chords checked against every bundled keymap**, Mac OS X 10.5+'s `ForceRefresh` on Cmd+Alt+Shift+R included, and a Failures chord in both editors | `ide` | [AC12](#ac12) |
| <a id="m17"></a>M17 | **A Rider descriptor and a Rider scene** ([LI16](#li16)), `jetbrains.md`'s Rider table from the scene | `ide` | [RD4](#rd4), [RD6](#rd6), [RD3](#rd3), [AC3](#ac3) |
| <a id="m18"></a>M18 | **A flaky group in both failures trees**, selected from the flaky row of the status popup and the status menu | `ide` | [HM10](#hm10) |
| <a id="m19"></a>M19 | **A JetBrains log and one not-running message**, a Log tab ([developer-loop-audit.md](developer-loop-audit.md) P8) | `ide` | [ST23](#st23) |
| <a id="m20"></a>M20 | **Piwi's per-test data in VS Code's Testing view**: durations, descriptions and tags | `ide` | [TL20](#tl20) |
| <a id="m21"></a>M21 | **Verdicts worded by the service** for every run the editor followed, those of terminal runs after the study's P7, and the editors' native call for the study's attention (P6) | `ide` | [HM16](#hm16), [HM17](#hm17) |
| <a id="m22"></a>M22 | **The words both clients show, sent by the service**, held by a golden test across `glue.ts` and `Glue.kt`. The words of watching follow the study's P5 (D6) and its built `stop-words.ts`; the pausing line names its call and time in both clients | `ide` | [AC11](#ac11), [LR17](#lr17), [LR15](#lr15), [LR18](#lr18) |
| <a id="m23"></a>M23 | **Agents through the JetBrains IDE's MCP server** ([LI18](#li18)); first check that the toolset reaches the AI Assistant and Junie | `ide` | [ST22](#st22) |
| <a id="m24"></a>M24 | **Editors open the desktop app's pages through `piwi://open`**; each hand-off one glyph at both ends | `ide` | [IC11](#ic11) |

### Large

| Step | Change | Scope | Findings |
|---|---|---|---|
| <a id="l1"></a>L1 | **A Runs home in both editors**, placed as [LI9](#li9) says, with the catalog's actions, keys and names; it lands with the study's P6 (live-runs E6, E11) and fills as the other phases arrive | `ide` | [LR7](#lr7), [LR9](#lr9), [LR10](#lr10), [LR11](#lr11), [LR12](#lr12) |
| <a id="l2"></a>L2 | **VS Code's coverage view and a JetBrains test tree for Piwi runs** ([LI8](#li8)) | `ide` | [TL18](#tl18), [TL19](#tl19), [TL1](#tl1) |
| <a id="l3"></a>L3 | **A debug session spike, decided for both IDEs** ([LI10](#li10)), tried in Rider with the backend under the debugger | `ide` | [LR3](#lr3), [RD1](#rd1) |
| <a id="l4"></a>L4 | **Endpoint-level reach**: the manifest's handler line in `integrations/aspnetcore` first (MIT; no scope fits, so that commit has none), then the lens (`ide`) and Open in IDE on .NET frames (`ui`) | `ide` | [RD7](#rd7), [RD8](#rd8) |
| <a id="l5"></a>L5 | **A test card in both editors** (`piwi/testCard`), laid out like the dashboard's test row | `ide` | [TL21](#tl21) |
| <a id="l6"></a>L6 | **Both editors checked on the shared fixture, without a license** ([LI19](#li19)); the workflow change as its own `ci` commit | `ide` | [TL16](#tl16), [TL14](#tl14), [LR6](#lr6), [TL13](#tl13) |
| <a id="l7"></a>L7 | **Decide what Piwi is for Playwright on .NET**: a non-goal in `ROADMAP.md`, or a proposal for an MIT NuGet adapter | `docs` | [RD6](#rd6) |

### Sequence

Q1, Q2 and Q3 first: the Code Vision row, flaky on the test line and the menus are what a developer meets on every spec.
Then Q18 and Q19, the Rider steps, for the IDE the maintainer uses daily; the other quick wins in any order, each on its
own, Q8's run section waiting for M2's registered Run Control group. Then M1 and M2, on which the menus (M3), the
run-control places (M14) and the keymap work (M16) build; Q9 takes the platforms' glyphs now, and M4 and M5 add the ones
Piwi draws. The live-run steps take their place in the study's order: M14 needs none of its phases, M15 can start now
that P4 is built, M13's run line and M22's words of watching follow P5, L1 lands with P6, and M21's verdicts for
terminal runs follow P7. L3 decides before 1.0 whether M14's places are interim, and every step that adds a command id,
action id or setting key (M10's keys, Q8's `Piwi.RefreshRun`, Q16's `piwi.restartService`, M3's `piwi.statusMenu`, M11's
`Piwi.GetStarted`, M14's `piwi.showStop`, M19's `Piwi.OpenLog`, M13's `piwi.statusBarAlert`, L1's Runs view) registers
it in D25 in the same pull request; v0.68.0's `piwi.watchWorker`, `piwi.pauseAndWatch`, `Piwi.WatchWorker` and
`Piwi.PauseAndWatch` wait for the same entry (#1124).

## 13. Open questions

1. **A debug session or not** ([LI10](#li10)): keep [run-control.md](../adr/run-control.md) §3.2's choice and give
   Piwi's controls the debugger's places ([LI9](#li9)), or an inline `DebugAdapter` and an `XDebugProcess`? To decide
   before the run-control ids are registered in D25 and freeze at 1.0.
2. **Title Case for VS Code's command titles** ([AC8](#ac8)): adopt it in both IDEs, and drop leading articles ('Open
   Latest Run') at the same time?
3. **Caret or cursor**: [AC7](#ac7) names the control Run to Cursor, as JetBrains' own action does; does Run the Test at
   the Caret take the same word in both clients, or keep each platform's?
4. **Failed in JetBrains**: the platform's red `TestError`, native in both UIs and already the held stop's, or a red X
   matching VS Code and the dashboard? The IDE's runner draws an assertion failure as the amber X, so either choice
   departs from something.
5. **Record's color, and two marks**: flaky takes the dashboard's fuchsia shuffle (§2 principle 3, [IC4](#ic4)). Is
   Record's action icon red like Piwi Picker's dot, or gray, with red kept for the recording state as JetBrains' icon
   style asks? Can VS Code's margin show the flaky mark beside the Testing view's glyph ([TL13](#tl13)), and can
   JetBrains' gutter animate the running ring ([TL5](#tl5))?
6. **Where the concept table lives** (the catalog and the settings registry are in `packages/editor`, [LI1](#li1),
   [LI11](#li11)): `packages/editor`, bundled by both clients, or `apps/application/shared` beside `piwi-features.ts`
   and `piwi-ecosystem.ts`? Both are FSL; `packages/core` is MIT and cannot take Piwi Picker's drawings. Are
   `package.json` and `plugin.xml` generated from them, or kept by hand under a test?
7. **An icon font for VS Code, or codicons only**, writing 'flaky' where none fits ([IC8](#ic8)'s lean: the font)? The
   codicons proposed exist in 1.143.1 and are unchecked against the 1.91 engines floor.
8. **VS Code's status click**: the status menu with the state's action preselected (Enter keeps today's refresh), or a
   refresh while a chord opens the menu?
9. **What turns the status item to its alarm** ([HM2](#hm2)): failures new against the baseline, only those a run
   started here or local edits produced, or both?
10. **Where VS Code's Runs view lives**: in the Piwi panel beside Failures, matching JetBrains' Runs tab (this
    document's lean), or in Run and Debug, where developers looked at a stop? Whether JetBrains draws its run views in
    Swing or JCEF is the live-run study's open question 9.
11. **Plain Run and breakpoints**: does plain Run keep stopping at breakpoints, or leave stops to Debug with Piwi?
    `piwi.breakpoints` is a boolean, on by default (`apps/vscode/package.json:867-870`), and D25 does not list it: a
    value that limits stops to Debug runs needs a default for existing installs, and the key a D25 entry. Headedness is
    the live-run study's question 10; its P6 holds failures for an editor's debug run.
12. **A CI run on the status line**: the study puts the developer's own run first (P5) and lists CI runs of the branch
    read-only (P10). Does a CI run ever take the line while none of the developer's own is live?
13. **Team or personal settings**: which does a team share (`failureSeverity` in particular)? The new switches go into
    D25 before 1.0, and the service filters by them ([ST8](#st8), [LI11](#li11)).
14. **JetBrains' Get Started tab**: opened once per installation, as SonarQube for IDE's welcome is ([ST1](#st1)'s
    lean), or only from Tools → Piwi and the first-run balloon, keeping
    [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M8's lighter touch?
15. **Notification group ids**: D25 lists none, but splitting JetBrains' one 'Piwi' group drops the mute settings users
    gave it. Does 'Piwi' stay as the results group, so those settings keep applying?
16. **Rider's menus and keys**: whether Run Control goes in the Tests menu as well as the Run menu ([LR3](#lr3)); which
    Solution Explorer popup group works on Rider 2026.2; which letters are free in its Visual Studio 2022, Visual Studio
    and ReSharper keymaps; and which action runs when a keymap gives a Piwi chord to another action too?
17. **The IDE run icon's group**: is `JSTestRunLineMarkersAdditionalActionGroup` present and read in Rider 2026.2 and in
    every IDE of `verifyIdes` ([M9](#m9))?
18. **Rider's C# surfaces**: do Code Vision, LSP diagnostics and the hover appear on `.cs`, `.cshtml` and `.razor`
    files; does `SKIP_HIGHLIGHTING` apply to a folder beside the solution in the same Git root; does dotCover share the
    strip Piwi's coverage bar paints? Can CI run Rider, or is the Rider scene a check the maintainer runs before a
    release?
19. **The IDE's MCP server** ([LI18](#li18)): does `com.intellij.mcpServer`'s `mcpToolset` reach the AI Assistant and
    Junie or only external agents, which IDE versions bundle it, and does a module compiled against it pass
    `verifyPlugin` on 2024.1 and the latest Rider?
20. **A local failure's diagnostic code** ([TL12](#tl12)): register `local-failure` in D25 before 1.0, or keep the
    frozen `ci-failure` and word the origin in the message?
21. **Code Vision entries per line**: how many can one line carry, and does the service cap a line at that number
    ([Q1](#q1))?
22. **The in-editor debug action's name**: 'Debug with Piwi', pairing with Run with Piwi, the dashboard's 'Debug in my
    editor', or 'Debug This Failure' on a failure node? The choice goes in the catalog and in
    [developer-loop-audit.md](developer-loop-audit.md) §9.
23. **The desktop app's productName** ([AC13](#ac13)): what happens to installed copies on upgrade, on Windows and
    macOS?
24. **Playwright for .NET, Java and Python** ([LI17](#li17)): a non-goal stated everywhere a .NET user looks, or a NuGet
    adapter in `integrations/`? The maintainer's scope decision.

## Appendix A. The concept table, first draft

One row per concept, one glyph per tool, as §2 and [LI2](#li2) propose it. **(new)** marks a glyph Piwi draws: a
JetBrains SVG at 16 px with a `_dark` file and an entry in `PiwiIconMappings.json`, a VS Code glyph in the product-icon
font, a Piwi Picker key added to `apps/extension/src/shared/icons.ts`. A dash means the tool has no such action.

| Concept | Dashboard and desktop (lucide) | Piwi Picker (ICONS key) | VS Code (codicon or `$(piwi-*)`) | JetBrains (AllIcons or plugin SVG) |
|---|---|---|---|---|
| Connect | `plug` | `plug` | `$(plug)` | `connect.svg` (new) |
| Disconnect | `unplug` | `unlink` | `$(debug-disconnect)` | `disconnect.svg` (new) |
| Record | `circle`, filled | `record` | `$(record)` | `record.svg` (new) |
| Recording paused | – | `record`, gray | `$(circle-large-outline)` | `recordPaused.svg` (new) |
| Stop recording | – | `stop-circle` (new) | `$(stop-circle)` | `stopRecording.svg` (new) |
| Resume | `play` | `play` | `$(debug-continue)` | `Actions.Resume` |
| Pause | `pause` | `pause` | `$(debug-pause)` | `Actions.Pause` |
| Step | `redo-dot` | `skip` | `$(debug-step-over)` | `Actions.TraceOver` |
| Finish | `arrow-up-from-dot` | `step-out` (new) | `$(debug-step-out)` | `Actions.StepOut` |
| End the test | `ban` | `blocked` | `$(circle-slash)` | `RunConfigurations.TestIgnored` |
| Stop the run | `square` | `stop` | `$(debug-stop)` | `Actions.Suspend` |
| Pick | `crosshair` | `pick` | `$(target)` | `General.Locate` |
| Assert | `check-circle` | `check-circle` | `$(pass)` | `General.InspectionsOK` |
| Assert a region | `scan` | `viewport` | `$(screen-full)` or `$(piwi-region)` (new) | `region.svg` (new) |
| Mock a request | `network` | `network` | `$(arrow-swap)` or `$(piwi-mock)` (new) | `mock.svg` (new) |
| Share live ([LR14](#lr14)) | `radio` | `broadcast` (new) | `$(broadcast)` | `live.svg` (new) |
| Watch | `eye` | `eye` | `$(eye)`, built for Watch a worker's test | `Actions.Show`, built for `Piwi.WatchWorker` |
| Pause and watch | – | – | `$(piwi-pause-watch)` (new) | `pauseWatch.svg` (new) |
| Run on my machine | `monitor-play` | – | – | – |
| Pair | `link` | `link` | `$(link)` | `pair.svg` (new) |
| Open in dashboard | `external-link` | `external` | `$(link-external)` | `Ide.External_link_arrow` |
| Latest run, run node | the Piwi mark | – | `$(piwi)` (new) | `piwi.svg`, 16 px outline (new) |
| Cluster | `layers` | – | `$(layers)` | `layers.svg` (new) |
| Owner | `user` | – | `$(person)` | `General.User` |
| Trace | `file-archive` | – | `$(file-zip)` | `FileTypes.Archive` |
| Screenshot | `camera` | `camera` | `$(device-camera)` | `FileTypes.Image` |
| Reproduce in the desktop app | `monitor` | `monitor` | `$(device-desktop)` | `Nodes.Desktop` |
| Find the breaking commit | `git-branch` | – | `$(git-branch)` | `Vcs.Branch` |
| Verify ×3 | – | – | `$(sync)` | `Actions.Rerun` |
| Run this spec | – | – | `$(run-all)` | `Actions.RunAll` |
| Re-run the failing tests | – | – | `$(run-errors)` | `RunConfigurations.RerunFailedTests` |
| Coverage | `scan-line` | – | `$(run-coverage)` | `General.RunWithCoverage` |
| Passed: `emerald-500` `#10b981` | `check-circle-2` | a dot in the fill | `test-passed.svg`, generated | `RunConfigurations.TestPassed` |
| Failed: `rose-500` `#f43f5e` | `x-circle` | a dot in the fill | `test-failed.svg`, generated | `RunConfigurations.TestError` or a red X (new), [IC3](#ic3) |
| Flaky: `fuchsia-500` `#d946ef` | `shuffle` | a dot in the fill | `$(piwi-flaky)` and `test-flaky.svg` (new) | `testFlaky.svg` (new) |
| Running: `blue-500` `#3b82f6` | `loader-circle`, spinning | – | a ring in `test-running.svg` (new) | a ring (new), [TL5](#tl5) |
| Skipped: `zinc-400` `#a1a1aa`; fixme `zinc-600` | `minus-circle` | a dot in the fill | `test-skipped.svg`, generated | `RunConfigurations.TestIgnored` |
| Did not run: `amber-500` `#f59e0b` | `circle-slash` | – | – | `RunConfigurations.TestNotRan` |
| Interrupted: `slate-500` `#64748b` | `circle-pause`; the tray's dot | – | – | – |

The last seven rows are `STATUS_COLORS` (`apps/application/shared/status-colors.ts:36-45`) with the dashboard's
`getStatusIcon` glyphs (`apps/application/app/utils/index.ts:305-325`). The outcome palette adds four states with no key
there: unknown (JetBrains draws `TestNotRan`, VS Code nothing), paused, a held failure ([LR5](#lr5)) and recording
([IC2](#ic2)).

Every platform constant is to be checked on 241 and 262, and every codicon against the 1.91 engines floor, before use. A
first pass found each AllIcons constant above mapped to a New UI icon in both platforms' `PlatformIconMappings.json`,
and each codicon in the `codicon.css` VS Code 1.143.1 bundles; every lucide name is in the dashboard's icon set, though
`redo-dot`, `arrow-up-from-dot` and `scan` are not used by the dashboard yet.

The draft leaves seven collisions to settle, and the concept table's test (§2) should refuse a glyph given to two rows:
`$(run-all)` is VS Code's Re-run the failing tests today (`apps/vscode/package.json:274`), hence `$(run-errors)` for it;
`$(eye)` is also VS Code's Stop following the active editor (`:298`), and JetBrains' status item draws the eye for a
shared run in the popup that lists Watch with it ([LR14](#lr14)); Verify ×3's `$(sync)` spins in the running status item
(`apps/vscode/src/glue.ts:119`); `RunConfigurations.TestIgnored` is both End the test and Skipped; lucide `scan` sits
close to `scan-line`, and `ban` to `circle-slash`. The desktop app's Pick on the image draws `mouse-pointer-click`
(`apps/application/app/components/desktop/DesktopRunStopPage.vue:261`) where the dashboard's Pick draws `crosshair`, and
Piwi Picker's recording bar stops with `stop`, the square (`apps/extension/src/content/record-panel.ts:673`).

## Appendix B. Checked and found sound

What the slices and the two hands-on runs checked and found right, kept here so that no step of §12 reworks it.

- **The protocol and the runs.** The parity of [developer-loop-audit.md](developer-loop-audit.md) §8 still holds, and
  both clients build the same run arguments from the service's answers: the gaps above are in what each client draws,
  places and words **(read)**.
- **The platform's icons.** Of the plugin's 36 `AllIcons` constants (§3), all but [IC2](#ic2)'s film strip have a New UI
  icon in 262's `PlatformIconMappings.json`; in 241's, `Actions.GroupByFile` and `Debugger.NextStatement` have none
  either. `TestState.Run` and `Debugger.NextStatement` are 12 px gutter glyphs, 14 px in 262's New UI. Appendix A's
  constants exist on both with a New UI icon **(read)**.
- **The codicons.** The 37 codicons the extension uses are in VS Code 1.143.1's registry, and so are the menu points the
  plan uses (`testing/item/gutter`, `testing/item/context`, `testing/message/context`, `editor/title/run`,
  `file/newFile`, `editor/lineNumber/context`); neither set was checked against the 1.91 engines floor **(read)**.
- **The Piwi mark** is one drawing, written into `pluginIcon.svg`, `icons/piwi.svg` and `media/piwi.svg` by
  `apps/application/scripts/generate-brand-assets.mjs:208-213`; the plugin's `piwi_dark.svg` exists **(read)**.
- **Coverage colors**, one palette across the tools (§3), stay apart from dotCover's green and red in Rider, and each
  tooltip starts with "Piwi:" (`PiwiDefault.xml:20-38`, `Glue.kt:637-666`); every Rider scheme derives from Default or
  Darcula, so the `PIWI_*` keys reach it **(read)**.
- **The recording mark's menu** is built from the registered `Piwi.StopRecording`, `Piwi.PauseRecording` and
  `Piwi.ResumeRecording` (`PiwiRecording.kt:258-260`), so it shows Ctrl+Alt+Shift+R: the pattern [AC6](#ac6) and
  [TL2](#tl2) extend **(read)**.
- **JetBrains' status item** draws TestFailed and the error color for failing tests in Rider 2026.2.4.1; only the
  published image lacks them ([HM20](#hm20)) **(seen)**.
- **Rider.** The plugin starts in Rider 2026.2.4.1 and its editor service answers the editor fixture's stub **(seen)**;
  it finds a config beside a solution through Git (`Glue.kt:136-150`, `GlueTest.kt:1943-1951`) **(read)**. The editor
  menu shows Piwi's entries, and the Add menu offers Record a New Test File… **(seen)**. `use-shortcut-of` gives the run
  controls Rider's Visual Studio keys (F5, F10, Shift+F11, Ctrl+F10), Pause's aside ([RD2](#rd2)) **(read)**.
- **VS Code's Testing view** follows a live run test by test (`apps/vscode/src/test-explorer.ts:366-406`), the view
  JetBrains lacks ([TL19](#tl19)) **(read)**.
