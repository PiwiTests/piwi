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
remaining rows no longer name; git keeps their record. The defects still open are listed in §11. Built since: Q27
(JetBrains says a stopped service is not running, with Restart the editor service first, #1255; one did-not-answer
sentence, as a warning with its fixes, in the recording's, a pick's and a CI watch's messages too; the copies and Reset
the runs' MCP server token confirmed, the .NET note offered, Connect… on every connect-first answer and Restart where
the service is down; the tool window's header saying an unreachable instance as its empty text does, a desktop app that
fails its proof offering Open the log too, and the trust state naming Trust project…), Q28 (a test line's live state
from the developer's own run alone, another's named beside its own result, `CI run #130` or `run #131`; an agent's label
on `RunSession` and on the live run, in both status bars, the run choosers and JetBrains' Run tab), Q30 (Re-run failing
only while a test fails; the Worker tab's image named per kind of lane; Copy the MCP server configuration in VS Code's
palette only while connected, elsewhere answering to connect first, with Connect…; Run this spec's description; the
action groups, views and submenus in D25, its test reading them) and the rest of Q13 (Settings… last on JetBrains' run
balloon, Don't Show Again on VS Code's confirmation of what Piwi Picker inserted, `picker-inserted`, and a platform test
of each kind of balloon's group), with their findings; and a picked locator sent to the project whose run made it
(#1289). M10, M22 and M7 built since: JetBrains' Run options… lists Run headed and Hold failures as VS Code's,
in the words table's words (NF3); each failures view state carries the actions it links (`FailuresView.links`), which
JetBrains' tool window draws and VS Code's welcomes are held to, reading the instance again Retry wherever it answers a
failure (NF3); both editors mark the line a pausing test waits at, naming its worker, with End the test (LR18); and a
failure's quick fixes edit, Run with Piwi first only once its line was rewritten, its trace, context, page, the desktop
app's jobs and File an issue left to its node (`untestedSuspects`, `piwi/fileIssue`), Run, Debug and Verify ×3
named with Piwi wherever they are offered, and each test line's list offers Record steps in this test… after the last
line of its body (TL2, TL7). M5 built since, and M4 and M13 in part: JetBrains' running ring turns as VS Code's spins (TL5);
VS Code draws Assert a region and Mock a request with the plugin's glyphs from its icon font (`$(piwi-region)`,
`$(piwi-mock)`), every tool draws Share live with one broadcast, and Stop following leaves Watch's eye (X2, LR14 in
part); VS Code's running run takes the loader rather than Verify ×3's glyph (LR18), and the status item's other parts
were built with M13 (LR2, HM17). Two of the status item's last parts built since: a recording takes VS Code's Piwi item,
its controls in the status menu, as JetBrains' item shows it (LR1), and the alarm reads `Piwi: 2 failing`, the counts
fixed locally and flaky in its tooltip (HM2). M4 and M13 built since: an instance that does not answer wears one
glyph in both status items, a cloud struck through (`$(piwi-unreachable)`, `unreachable.svg`) (HM4), and JetBrains' run
tab opens a shared run's page and copies its link after its controls, as the status popup does;
VS Code's failures view lists finished runs alone, which no share outlives, and its status menu lists the shared ones
(LR14). M3 built since: Piwi Picker's popup stands its tiles in the menu's sections, in its order: Record actions and
Pick an element first, Piwi Picker's own tools under Pick, Report a bug and Replay under Record, and side by side Runs
under Run control, Tested elements under Dashboard and Agent context under Agents, the gear Connection; and the tray of
Piwi Desktop and Piwi Runner takes the menu's order, the run control first, the app, Agents and Connection, then its
own options, with Check for updates in both and each row's glyph (X3). M8 built since: a plain Run pauses at no breakpoint, Debug with Piwi does, as the IDE's own Run and Debug
(`piwi.breakpoints` `debug`, its default; `always` and `never` beside it; `RunTestsArgs.debugging`), the runs a
terminal starts with `always` alone (TL17), and **Debug the test at the cursor** in both editors. L2 built since:
VS Code's Testing view runs a Coverage profile that shows its tests' coverage of the files they reach in the Test
Coverage view (`piwi/coverageFiles`), and JetBrains paints Piwi's marks beside the IDE's coverage, a click on one offering to run the
tests that ran the line (`piwi/coverageTests`), go to the next line no test runs, hide the marks or edit their colors
(TL18); a run in JetBrains' Run tab draws its tests in the IDE's test tree as its workers begin and end them
(`piwi/runTest`), and such a run offers the IDE's Playwright runner once (TL19); with the Run, Debug and Coverage
profiles and the run icon's Piwi entry, each IDE's test UI carries Piwi's actions (TL1). M21 built since: a run the developer started in a
terminal or in the IDE's test runner is followed as the developer's own once its process names its page on the
instance, and its verdict says where it ran (`run #125 in a terminal`), from the service's words as every verdict
(HM16). L5 built since: a test's card, `piwi/testCard`, in VS Code's hover and on a click of
JetBrains' result icon: its latest runs as a strip, each to its run, how they went, its last failure, its
owner, tags and quarantine, with Run, Open in dashboard and More… (TL21). L1 in part since: a test the instance says
may be stuck says so on its line (`Stuck? running over 4 min, usually 40 s, in your run #130`), in VS Code's Testing
view's output and on both status lines (`· 1 stuck?`), never while it stands stopped (LR12); another's run in progress
names its branch on both status lines (`CI run #130 on feature-x`, LR10 in part); a Runs view in the Piwi panel
(`piwi.liveRuns`, beside Failures and CI Runs) and a Runs tab in the Piwi tool window list each run in progress, its
workers by lane with their tests and stops, and its page, each row's Watch, Pause and watch, Resume, Step and Stop the
run acting on it (LR7 in part: Hold failures on a run's row and run control as a Tools → Piwi submenu remain).
Also built since, with their findings: Q25 (the JetBrains plugin's labels
in sentence case, as VS Code's, so its labels quoted below in Title Case now read in sentence case), Q12, Q5's Test
connection (ST9), and Q8's Documentation in the gear, the headline in the hover alone and Reload Piwi with a glyph of
its own (HM9, ST18), and Q13's run notices on failures only by default and a run's balloon titled by its run, VS Code's
Connect failures in JetBrains' words (ST20), and Q23, the desktop app's product name, Piwi Desktop, which #1317 shipped
(AC13); and M6's End the test off the square and Finish's step-out glyph in the Runs window and the desktop app, and the
pause bar in the editors' order (IC5); and M22's held failure worded as the run page words it, and JetBrains' status
item saying why a test stopped (LR15); and M2's stop popup, result icon menu and failures tree built from registered
actions, the tree's as new `Piwi.Failure.*` ids, with Find Action synonyms, and the status popup's rows registered too
(`Piwi.ShowStop` on Show Execution Point's key, `Piwi.OpenRunPage`, `Piwi.OpenFailures`, `Piwi.NodeSettings`,
`Piwi.GoToRecordedLines`), one `Piwi.RunControl` group for Tools → Piwi and the status popup, and `Piwi.OpenTraceSoFar`
(AC6, NF2); VS Code's run node opens its page from its menu too, and both say Open the screenshot (HM11). M2 is built,
with HM11's Verify ×3 and Jump to Source (Go to the test) on failure nodes, and the status popup takes one entry per run
page (HM3); its three new groups (`Piwi.RunControl`, `Piwi.StatusActions`, `Piwi.FailureActions`) are in D25 with the
others (Q30). M5 and part of Q2: VS Code's outcome marks in the dashboard's colors and one flaky glyph, Piwi's shuffle,
in both editors (the result icon and JetBrains' CI tab), and Piwi Picker's dots in the same palette, a running ring in
both editors where they drew a run triangle, all held by `status-mark-colors.test.ts` (copies restated by hand, not
generated); and the dashboard's Reproduce here as the editors' monitor (IC11); both CI views draw a test's outcome with
its line's own mark, JetBrains' through one `PiwiIcons.outcome`. Q26, IC7 and Q9 in part: the JetBrains plugin draws a
glyph of its own in `icons/` for the 13 actions that had none, Connect's plug and a CI run's cloud, its status item a
shared run with Share live's broadcast; VS Code's Run the tests that reach this file and 'Piwi: unreachable' leave the
glyphs of the Piwi mark and Disconnect, and its CI lists open a run with the run pages' globe; `menus.test.ts` and
`PiwiPluginTest` fail on a glyph two concepts share but those they list (NF1). M5's tray and Runs window: the desktop
tray's dot in the outcome palette, a run that waits in the pause bar's violet, Piwi Picker's Runs window counting failed
and flaky in it, VS Code's flaky word after a line in fuchsia (`piwi.flakyForeground`) and the hover's flaky test with
the word (IC4 in part). Q8: the Piwi tool window's header is one line, the connection a link to Settings (`3 Playwright
configs` with several) and the baseline a link to Compare with…, the baseline in VS Code's failures view description
too, and JetBrains' status popup offers one entry per page (HM12, HM3). M18: both failures trees list the run's flaky
tests under 'Flaky in this run', from a `flaky` list the instance's branch failures answer gains, each opening at its
`test(…)` line, saying Flake Lab's rate (`flaky 18%`) and offering its Flakiness tab and Flake Lab's commands in its
menu (**Look into this flake…**, `piwi.lookIntoFlake`, in VS Code), and VS Code's status tooltip and JetBrains' status
popup open the group (**Show the run's flaky tests**, `piwi.showFlakyTests`, `Piwi.ShowFlakyTests`) (HM10). Q16: VS
Code's integration suite stops the editor service and starts it again through Restart the editor service (HM19 in part).
Q29: Connect's failure words are one table in the editor service (`connect-failures.json`), which VS Code reads and
`GlueTest` holds the JetBrains plugin's copy to, JetBrains gaining the expired, not-yet-valid, other-name, not-HTTPS and
page answers VS Code said (NF7). M6: the pause bar every headed stop shows draws each control's glyph, drawn anew in
`picker-dom` (IC6). M20: VS Code's Testing view tags each test with its quarantine, Playwright tags and owner, from the
catalog through `SpecTest`, and publishes each result with its own duration, a failure's or its latest run's (TL20); its
items carry no description, which the view would read out in place of the test's title (#1367). VS Code's failing,
recording and stopped lines mark the scrollbar in opaque colors of their own, as JetBrains' error stripes do (#1387).
Q2: a fixture check in each editor fails when a flaky test loses its flaky mark, VS Code's nightly suite reading its
Testing item and its line's mark, `PiwiPluginTest` the bundled service's answer for its line and the result icon that
answer draws (TL13). Q13 in part: VS Code's run verdict ends with **Settings**, which opens `piwi.runNotifications`; a
service notice that comes unasked, may come again and hides nothing the developer must hear carries a key
(`NOTICE_KEYS`): an agent's action and a run that was lost carry none, so a key is on some notices rather than on each.
VS Code offers **Don't Show Again** on it, kept in `piwi.hiddenMessages`. M21 in part: the service words a run's verdict
once for both clients (`RunEnded.verdict`, `verdictWords`), the run it names, its text, whether it fails, whether it is
said whatever the setting and its actions' ids, for the editor's runs and the CI runs of the branch it followed
(`RunEnded.origin`), which a scope on the run notifications setting leaves out (`piwi.runNotificationsScope` and its
JetBrains twin) (HM16 in part, its rest built with M21, above), and a test held at its
failure or at `page.pause()` while the editor is in the background calls once, VS Code with a notification offering
Resume and Go to the stopped line, JetBrains with `AppIcon.requestAttention`, raising the IDE from another application
while 'Focus application on breakpoint' is on, as the service marks the stop (`RunStop.calls`), the status item marked
until it is answered (HM17). M4 in part: one failure-tree node table for both editors, held to the protocol's icon keys
by `PiwiPluginTest`, a cluster drawn as Lucide's `layers`, an owner as a person and a spec as a file, and Assert a
region in the dashboard and the Runs window as the viewport corners; and the brand asset generator writes the editors'
outline mark, the body, lens and eye at 16 px and with the check at 20 px: the JetBrains New UI's through
`PiwiIconMappings.json`, VS Code's `$(piwi-mark)` in a product icon font built from the mark's strokes drawn as fills,
drawn by the status item, both trees' run node and VS Code's views (IC8, IC9). Q9: the font also takes the plugin's
flaky, Pause and watch and Stop sharing glyphs and the new Reload Piwi (`icons/reload.svg`, JetBrains' too) and Run to
the cursor glyphs, at one line weight, so every VS Code command draws one (IC1). M1: one action catalog,
`packages/editor/src/actions.ts`, gives each action its ids in both editors and one title in sentence case, with an
ellipsis wherever it asks for something first and each platform's word for the cursor and the window;
`tests/actions.test.ts` holds `package.json` and `plugin.xml` to it, and the titles that differed now read alike
(Connect…, Open the log, Run a saved selection…, Turn hold failures on or off for the run, Show or hide the coverage
marks, Finish the test, End the test, Record at the stop, Record here… for the caret alone), and a confirmation takes no
ellipsis (Stop sharing the run live, in the share menus too) (X1, AC7, AC10, AC9 and NF3 in part). M3 in part:
JetBrains' Tools → Piwi in six compact sections (run, record, run control, dashboard, agents, connection), its editor
submenu with Record a new test file… as VS Code's has, and a **Piwi** submenu in both editors' file trees that runs a
spec or the tests that reach a file and records a new test file, and JetBrains' New offering **Playwright test
(recorded)…** on a folder of a Playwright config alone (AC1, AC3 in part). M3's status menu: a click on VS Code's status
item opens **Open the Piwi menu** (`piwi.statusMenu`), a quick pick in the JetBrains popup's sections, its first row the
item's own action, so Enter still refreshes. M13 in part: VS Code's status tooltip links Connect only while not
connected, gives the item's failing count after the local runs, and says how many tests the failed results are when a
test failed on several Playwright projects (HM1); both editors' status items turn red only for a test the editor's own
run failed that the baseline does not fail (`RunStatus.alarm`, decided by the service), as `piwi.statusBarAlert` and its
JetBrains twin choose (`new`, `any`, `never`), never for a run in progress (HM2). VS Code's count item is folded into
the Piwi item, which counts the window's runs from their processes as JetBrains' single item does, with Watch a worker's
test in the status menu, and both word a run's count alike, `run #78 · 3 of 9 · 1 failed · 1 flaky` (`countWords`,
`Glue.countWords`, client copies under the same tests), the pass or error glyph once it ended (LR18). A run's status
reads in the dashboard's words from the service (`RunStatus.run.statusText`), and a recording as `recording` or
`recording paused`, with the recording glyph in JetBrains too (HM4). The service composes the runs' one line for both
status items (`piwi/runLineChanged`: the stop, or the call a pausing test waits in and for how long, the share, the
count), its state's glyph, and marks the item while a stop waits for the person (VS Code's warning background, a dot on
JetBrains' icon) until it is answered (LR2, HM17); VS Code's stop and share items fold into the Piwi item, whose menu
leads with Go to the stopped line (`piwi.showStop`) and holds the controls, End the test and the share (LR1). M7 in
part: the service sends each test line one grouped action list (`SummaryLine.actions`: Run with Piwi and Verify ×3, the
trace, the screenshot and the dashboard, Copy context for agent, the Flake Lab commands), which JetBrains' result icon
opens on either click and VS Code from the Testing view's gutter, item and message menus, the line number's menu with
the view off and the hover's **More…** (`piwi.testActions`) (TL6).
M8: Debug with Piwi in both editors, Piwi's run control rather than a debug session: in each test's action list, the
dashboard's Debug in my editor run for a failed test (stopping once at its line, with no consent prompt) and a headed
run holding its failures otherwise; VS Code's Debug profile in the Testing view; and **Debug with Piwi** on the
failure nodes of both editors, from the run the service builds (`WorkspaceFailure.debug`) (TL17 in part: the IDE run
icon waits on M9). M7 continued: the failure nodes of
both editors gain **Verify ×3 with Piwi** and **Go to the test**, from what the service finds of the failure's test
(`WorkspaceFailure.verify`, `WorkspaceFailure.test`) (HM11), and every quick fix carries Piwi's name, the service's
(`piwiActionTitle`) and the clients' recorded-locator ones alike. M9:
the IDE run icon's menu on a test offers Run with Piwi and Verify ×3 with Piwi on its line
(`JSTestRunLineMarkersAdditionalActionGroup`, TL3), Piwi test results on the Gutter Icons page switches Piwi's result
icon (TL4), and the editor fixture carries this repository's Playwright; TL3's check in Rider and every IDE of
`verifyIdes` remains. M22: the words both clients write themselves are one table (`packages/editor/src/words.json`,
`@piwitests/editor/words`), which VS Code reads and JetBrains' `EditorWords.WORDS` restates under `GlueTest`, its two
stop controls the catalog also titles held to it by `tests/words.test.ts`: a stop's controls and code actions with their
short labels (AC9, AC11), a recording's states, controls and edited block's message, JetBrains' banner reading as the
status bar, a worker's and a CI lane's name and the worker panel's title, and Hold failures' choices, short and whole,
and a run's state (NF3); the pausing line's call and time come from the service's run line (LR18). M10 in part: one
settings registry (`packages/editor/src/settings.json`, `@piwitests/editor/settings`) gives each option its group,
order, scope, type, default and choice labels; VS Code's settings follow its groups (Connection, Runs, Agents (MCP),
Advanced) with labeled choices, a team's options window-scoped and every other one application-scoped, the run options
written to the user's settings (ST7, ST12 and NF8 in part); `failureSeverity`, `serveRunsToAgents` and `testExplorer`
stay settable per project (open question 11 answered so), and JetBrains' page takes its group titles and labels, its AI
Assistant group renamed Agents (MCP) (ST21 in part). The display switches (ST8) are built: `piwi.codeLens` (all,
problems, off), which the service applies to `piwi/fileSummary` for both clients, dropping a spec's locator line inside
its only test; `piwi.locatorWarnings`, which it applies to the diagnostics; `piwi.gutterIcons` (VS Code's; JetBrains
keeps the platform's Gutter Icons switch); `piwi.coverageMarks`, which the toggle writes; `piwi.failingTestTint`; and
`piwi.ciPositions` (NF8), in an In the editor group of both settings pages. ST12 is built by scope rather than as a
Defaults page: a person's own options live at the IDE's level in JetBrains (`PiwiUserSettings`, `options/piwi.xml`), as
VS Code's user settings, a change applied in every open project, and a project's own stay in `workspace.xml`. Each
JetBrains group says once where its options are kept, the path from the project's store folder, Rider's included (ST13);
a reference page, Editor settings, lists every option by group, written by hand as the registry holds no descriptions,
its keys, defaults and kinds held to the registry by `docs-claims.test.ts`, and each VS Code setting, each JetBrains
group and the page's help button link its section (ST15); the copy notices name the agent's MCP settings, the AI
Assistant's only while it is enabled (ST21). ST7, ST8, ST12, ST13 and ST15 are left out of this document. M11 built: one
onboarding script (`packages/editor/src/onboarding.json`, `@piwitests/editor/onboarding`) of eight steps, connect, the
failures, a run, a breakpoint stop, a recording, pairing Piwi Picker, the MCP server and the settings, each with its
catalog action as the button and a docs screenshot where one exists. VS Code plays it as its walkthrough, with a
one-line description, the screenshots as `media.image` and an MCP step for 1.101 and later (`piwi.mcpProvided`);
JetBrains as a Get Started tab of the Piwi tool window (`Piwi.GetStarted`, in Tools → Piwi, the gear and Help), opened
once per installation, connected or not, in place of the first-run balloon, each step checked off once its action ran
(ST1, ST2). Both disconnected homes offer Record a new test file…, 'Recording works without one' (ST3). One first-run
queue in each editor: the first steps, then one offer per window or session; VS Code's MCP notice stays silent on 1.101
and later once the walkthrough opened (ST4). JetBrains' Agents (MCP) group holds the copy and token actions as buttons
(ST21). ST1 to ST4 and ST21 are left out of this document; the settings step is held to the registry by a test rather
than generated. M12 built: JetBrains' Connect panel (`PiwiConnectPanel`), in the settings page's Connection group, saved
with Apply, and as Connect's one dialog in place of its chain of five: the desktop app with its projects, or an instance
with Test connection, its key with Sign in…, Paste key… and Remove, saved on Apply, and a project from the instance's
list. The sign-in shows in the panel, its code and link with Copy code, Copy link and Open browser again, and VS Code's
sign-in message gains the same buttons (ST16, left out of this document). LI13's states for waiting on trust and a
Node.js start problem are dropped from M12: the settings page's In use group already says both, with Node.js settings….
M14 built: VS Code's editor title holds Pause or Resume, Step,
Finish and Stop in the debug toolbar's order, and its context menu a stop's controls while a test is stopped, after the
editor's Go to entries; JetBrains puts a stop's controls first in the editor's context menu and the run controls in the
Run menu while a run is live (`PiwiLiveRunGroup`), and a run's Run tab carries `Piwi.RunControl`'s actions, acting on
its run, in its toolbar (`PiwiRunTab`) (LR3). VS Code's Go to the stopped line was built before (LR4). JetBrains' stop
inlay takes VS Code's row, Resume, Step, Finish and Write code…, in an inlay hint's font with the gutter's mark, the
other controls in its context menu, VS Code's line gives up its own lenses while a stop shows, and the nightly showcase
fails on a stop row past its editor's edge (LR6). A run's session
opens as its command starts (`RunSession.starting`, `piwi/commandStarted`, which JetBrains sends from the console and
the IDE's runner), so the status line and an agent's `run_list` say it is starting and Stop ends it (LR13). The service
names each run it builds (`RunCommand.name`, `RunSession.name`, `runName`), its task or Run tab title and its name in
every chooser and the Watch chooser (`runTitle`), two of one name with their refs (LR16). LR4, LR13 and LR16 are left
out of this document. M15 built: one page per worker in both editors, the paused page named after its worker and the
worker view showing its slot's stops while it watches in sight, an accepted watch taking the slot's stop from the paused
page; both pages hold the stopped line's row, Resume, Step, Finish and Write code…, as a toolbar; Watch and Interact are
toggles with their glyphs in the words both editors write (`page.watch`, `page.interact`) under one input rule
(`page.input-rule`); VS Code's pages carry a tab icon, and every control an accessible name; JetBrains' Worker tab
offers Interact at a stop (LR8, NF6, left out of this document). M16 built: Piwi's chords are one table
(`packages/editor/src/keys.ts`), `Ctrl+Alt+Shift` (`Cmd`) with R, F and K and B for a new Open the failures in both
editors, acting from the keyboard only in a JavaScript or TypeScript editor and in Piwi's views, and another letter, or
none, in the keymaps that give one to another action: the Visual Studio and ReSharper families', TextMate's, the Linux
desktops' and Mac OS X 10.5+'s Force Refresh; a test checks them against every keymap bundled with WebStorm (2024.1 and
2026.3), IDEA Ultimate, Rider, PyCharm, PhpStorm, GoLand and RubyMine (`apps/jetbrains/keymap-chords.json`, which
`apps/jetbrains/scripts/keymap-chords.py` reads from the IDEs), sharing a chord only with an action that acts elsewhere
alone, and against AltGr's letters (AC12, left out of this document; #1117). The run-control keys stay set by each
client, with no table (deferred). Record here is a code action where the service says a recording writes
(`piwi/recordPlace`): a new test past the imports, steps in a test's or a function's body, in VS Code's Ctrl+. (kind
`refactor.piwi`) and JetBrains' Alt+Enter, never on an import or in a class body (TL9). M4's record family: JetBrains
draws Record's actions with a gray disc (`icons/record.svg`), Stop recording with a ring around a square, and a
recording's gutter mark and banner with a red dot in a ring, a gray ring while paused, and VS Code a paused recording
with `$(circle-large-outline)`; JetBrains' Pause recording draws the ring and Resume recording Record's disc, and VS
Code marks the recorded block's first line in the gutter with the same glyphs, which `status-mark-colors.test.ts` holds
byte for byte; JetBrains' mark is also a menu (IC2). M4 in part: Piwi Picker draws Stop recording as a square in a ring
(`stop-circle`) and Share live as a broadcast mark (`broadcast`) on its buttons and its "shared live" line, in the
recording bar, the popup and the DevTools panel, apart from the run's Stop and a share of a result. M5 in part: Piwi
Picker counts a test that waits for you in the pause bar's violet, in the popup's Runs tile, the toolbar's badge and the
Runs window, held by `status-mark-colors.test.ts` (IC4); both editors tint a failing test, its failing line and a
recording in `STATUS_COLORS`' failed and running fills, the JetBrains schemes blending them over classic Default's or
Darcula's background, and VS Code's held failure's arrow takes the failed fill (LI3); VS Code's running ring spins,
still under the system's reduced motion (TL5 in part). Q5: `PiwiPluginTest` holds Settings → Tools → Piwi within 100
columns of its font, every text the page fills itself holding a long sentence and an address (ST14). §14 adds the
findings the code that built the plan raised. The live-run study, [live-runs.md](../adr/live-runs.md), has built P0 to
P6 and P8 to P10, each but for leftovers its Status names, and part of P7 and P11, and §8 names what the editors still
lack; this document owns where each editor hosts a run and the debug-session question ([LI10](#li10)), the study the
live model, its words and its phases. Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. It cites and does not
restate [editor-extensions-audit.md](../adr/editor-extensions-audit.md),
[developer-loop-audit.md](developer-loop-audit.md) §8 (P1 to P15) and §9 (the vocabulary),
[record-from-the-ide.md](record-from-the-ide.md), [real-editor-checks.md](real-editor-checks.md),
[live-view-next.md](live-view-next.md) Part 6 and [extension-ux-audit.md](extension-ux-audit.md). A pull request that
builds a step removes its row and the findings it fixes, and names it in this paragraph; the one that ships the last
step moves the document to `adr/`.

**Summary.**

- **What is left.** Most of the plan's quick wins are built; the steps left center on the Rider layer (M17) and the debug-session decision (L3).
- **The data is shared and mostly right; everything around it differs.** One action has up to five names and two places,
  one outcome up to seven marks and four colors, one click means one thing in Rider and another in VS Code, and only the
  coverage colors and the stop words are held to one source by a test.
- **Two findings lead (§0)**: what a test's own line still lacks, and no check that opens Rider.
- **Nine principles (§2):** one name, one glyph and one outcome palette per concept, held by tests; one menu shape and
  one home per editor; the IDE's own places first; the service words and decides, the clients draw; every entry
  registered and discoverable; quiet and switchable; checked where it is used, Rider included.
- **Twenty larger items (§10) and a ranked plan (§12):** the three medium and five large steps left, each the size of a
  pull request.

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
Code's webview and JetBrains' tab, each named after its worker); the **editor service**; the **editor fixture**
(`apps/vscode/scripts/lib/editor-fixture.mjs`, the stub instance both screenshot scripts use); the **action catalog**,
the **concept table** and the **outcome palette** (proposed in §2); the **live-run study**
([live-runs.md](../adr/live-runs.md)).

---

## 0. The findings that matter most

1. **Rider's IDE run icon is unchecked** ([TL3](#tl3)).

2. **No check opens Rider** to see a spec beside the solution or a C# file ([RD3](#rd3), [RD4](#rd4)).

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
   against, in sentence case in both editors.**
2. **One glyph per concept and one meaning per glyph, from the concept table; a glyph no platform has, Piwi draws
   once.**
3. **One outcome palette: `STATUS_COLORS` and the dashboard's status glyphs, restated in each tool and held to them by a
   test, as `coverage-mark-colors.test.ts` holds the coverage marks; flaky, quarantine and history always drawn.**
   ([LI3](#li3))
4. **One menu shape (Run, Record, Run Control, Dashboard, Agents, Connection, each showing what applies now) and one
   home per editor, with the same tabs, toolbar order and empty states.**
5. **The IDE's own places first, with Run, Debug and Coverage meaning what the IDE means; Piwi's own marks only for what
   the IDE cannot show.** ([TL3](#tl3), [LR3](#lr3), [AC3](#ac3))
6. **The service words and decides, the clients draw, and a contract test fails when the service sends an icon key a
   client lacks.** ([HM8](#hm8), HM16 built)
7. **Registered and discoverable: every Piwi entry in a JetBrains popup is a registered action, every VS Code command
   has an icon and a when clause.** ([LI1](#li1))
8. **Quiet, and switchable where the IDE keeps its switches: an alarm only for what the developer's own work caused, one
   interruption, and an off switch for every mark.** ([TL4](#tl4))
9. **Checked where it is used: both editors compared on the editor fixture without a JetBrains license, a Rider scene on
   `examples/sample-app`'s ASP.NET Core backend, and docs that claim only what a check holds.** ([RD4](#rd4))

**What 1.0 allows.** [1.0-stabilization.md](1.0-stabilization.md) D25 lists every command, setting and action id of both
editors, their action groups, views and submenus, held to the manifests by
`apps/application/tests/unit/editor-ids-register.test.ts`. Titles, icons, menus and their order are not frozen, so they
may change before 1.0 and after. Every id a step adds is registered in D25 in the same pull request.

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
[record-from-the-ide.md](record-from-the-ide.md) Part 2 plans, on config folders only. ([M17](#m17), [LI4](#li4),
[LI16](#li16))

### 4.4 Names

## 5. The test line

What works: both editors draw the same answer per line from the editor service (`piwi/fileSummary`), so the pass rate,
the failing line and the evidence are the same data in Rider and in VS Code. **(read)** What differs is what a click
does, what the line says and which marks it carries.

### 5.1 The gutter and its menus

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
page lists `LineMarkerProviderDescriptor`s, not an annotator's icon. A green check from the developer's
run can sit beside a red X from CI, and only the IDE's can be hidden. **(read)** Fix: a "Piwi test results" entry on
the Gutter Icons page, a descriptor whose switch the annotator reads. ([M9](#m9), [LI8](#li8))

### 5.2 One role per surface

### 5.6 Debug

### 5.7 The IDE's own test UI

### 5.8 A test card

## 6. Settings, connection, onboarding and agents

What works: the API key never sits in a setting (VS Code's secret storage and the IDE's password safe, each per
instance), both clients take the connection order from the service (`packages/editor/src/context.ts:263`), and
`apps/vscode/tests/walkthrough.test.ts` fails when a walkthrough step names a command that is gone. **(read)** The
direction is one settings registry ([LI11](#li11)), one onboarding script ([LI12](#li12)), and the connection computed
once and shown first ([LI13](#li13)).

### 6.1 The first minutes

Built with M11: one onboarding script both editors play, VS Code's walkthrough with images and JetBrains' Get Started
tab, the disconnected welcomes offering a recording, and one first-run queue. The Status says how.

### 6.2 The settings pages

Built with M10: one settings registry, both pages grouped by it, each option scoped once, and the Editor
settings page it links. The Status says how.

### 6.3 Connecting

Built with M12: one Connect panel in JetBrains, on the settings page and as one dialog, and a sign-in whose code and
link stay at hand in both editors. The Status says how.

### 6.4 Agents

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

### 7.2 The homes

<a id="hm8"></a>**HM8. No check on the editor fixture covers a state of the Piwi tool window.** Both clients word an
instance that does not answer, a desktop app that fails its proof and a lost connection as the service does, with the
same links per state, and their unit tests hold the words; nothing opens either editor on the fixture in each state.
**(read)** Fix: each state checked on the editor fixture in both. ([LI5](#li5), [L6](#l6))

### 7.4 Notifications

## 8. Live runs in the editors: where they sit

The split with the live-run study ([live-runs.md](../adr/live-runs.md)) is the Status paragraph's. A finding that
overlaps the study says where the result lands in each editor, and names the study's finding and phase where that phase
is not built; its fix adds only what the study does not. At `b0ff6772` the study has built P0 to P6 and P8 to P10, each
but for leftovers its Status names, and part of P7 and P11, its P4 without E2, E3 and E13 in the editors.

### 8.1 The glance

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
`EditorPopupMenu`, `RunMenu` and the toolbar of a `RunContentDescriptor` the plugin builds. Built with M14; L3 decides
the debug session. ([L3](#l3))

### 8.4 The list

<a id="lr7"></a>**LR7. The developer's own live run has no home in either editor, and nothing lists its workers, tests
or stops in a view.** The run's 22 entries sit in Tools → Piwi while they apply (`plugin.xml:214-290`), and 20 of them
again in the status popup while a run is live (`PiwiStatusBar.kt:187-192, 264-268`); VS Code shows it in its status
item. `RunSession` carries each worker's test and state
(`packages/editor/src/protocol.ts:1798-1842, 1865-1915`), which Piwi Picker's Runs window and the desktop tray list;
the editors list the workers only as lines of the status tooltips (`Glue.workersNowText` at `Glue.kt:2160`,
`workersNow` at `apps/vscode/src/run-control.ts:956`) and in Watch a Worker's Test's chooser
(`Worker 2 · running <test>`). **(read)** Fix: a Runs tab in the Piwi tool window and a Runs view in VS Code (a new
id: `piwi.runs` names the MCP provider), shown while a run is live, with the Runs window's rows (the run, then Worker N
with its test, its state, Watch and Pause and Watch, a stop with its place and controls), and run control as a Tools →
Piwi submenu; until then Watch and Pause and Watch sit in the status menu's run section. Whether VS Code's view sits
beside Failures or in the Run and Debug container is open (§13); workers as a debug session's threads are
[LI10](#li10)'s alternative. ([L1](#l1))

### 8.5 What the study's model brings

<a id="lr9"></a>**LR9. The Testing view and the test lines take the developer's own run from the instance, so a run
that reports to none shows no test running, and no line shows where a running test is.** The service sets a test's
live state from the instance's run stream (`packages/editor/src/run-watch.ts:622-668`), which the test lines
(`packages/editor/src/server.ts:3060-3061`) and the Testing view (`apps/vscode/src/test-explorer.ts:383-410`) read; the
workers' own reports reach the Testing view only as output lines, once a test run follows the instance's run
(`test-explorer.ts:418-432`). No line marks the call a running test of the developer's own is at, where a CI run's
positions are marked (`apps/vscode/src/ci-view.ts:90-106`). **(read)** This is live-runs E3 (E2 for the running line),
of the study's P4. Fix: the Testing view and the test's line from the run's own events, a spinner while it runs and the
pause or failed glyph while it waits, and the running line marked. ([L1](#l1))

<a id="lr10"></a>**LR10. A teammate's run of the branch reads as a plain run, and CI runs sit apart from the developer's
runs.** `LiveRun` tells only the developer's own run and a CI run (`packages/editor/src/protocol.ts`), so a teammate's
run reads `Piwi: run #131 · 4 of 9` in both status bars and `running in run #131` beside a test's result. **(read)**
Fix: CI runs as read-only rows of the Runs view and tab, and the run's origin in the tooltips (a teammate's
machine, the desktop app), which the instance does not send yet; the status line and the tooltips name another's run's
branch (`CI run #130 on feature-x`), the developer's own the short form. ([L1](#l1))

### 8.7 Words deferred to the study

## 9. Rider

Rider runs the same plugin as WebStorm, with other keymaps, another project model and a .NET backend beside the specs.
What differs is RD3, RD4, RD7 and RD8 below and one finding filed elsewhere:

| What differs in Rider                                        | Where             |
| ------------------------------------------------------------ | ----------------- |
| Nothing from Piwi in the Solution Explorer or the Tests menu | [AC3](#ac3), §4.1 |

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
diagnostics, and [AC3](#ac3). ([M17](#m17))

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
M22's (built), its chords M16's ([LI15](#li15)); its concept came with M4's glyphs (built) and its menus came with M3 (built).

<a id="li15"></a>

### LI15. Keys from one table, checked against every bundled keymap

Chords and run-control keys sit in the catalog per keymap family and generate VS Code's keybindings, `plugin.xml`'s
per-keymap entries and both docs tables; a unit test resolves the keymaps bundled with WebStorm, IDEA Ultimate and
Rider, and VS Code's defaults, and fails on a collision. The table records the rule both clients follow: Resume, Step,
Run to Cursor and Finish give way to a suspended debugger, Pause to a running one and Stop to any session, Pause on the
platform Pause action's key. **Lives in** `packages/editor` and both clients (FSL). **Replaces** chords Rider's Visual
Studio-family and ReSharper keymaps already bind, keys set per client with no collision check. **Depends on**
[LI1](#li1). **Revisits** no decision. Built with M16 in part: the chords are their own table
(`packages/editor/src/keys.ts`), not the catalog, and a test holds both manifests and the docs' table of keys to it
rather than generating them; it checks them against every keymap bundled with WebStorm (2024.1 and 2026.3), IDEA
Ultimate, Rider, PyCharm, PhpStorm, GoLand and RubyMine (`apps/jetbrains/keymap-chords.json`) and VS Code's. They act
from the keyboard only in a JavaScript or TypeScript editor and in Piwi's views, so a chord shares its key only with
an action acting elsewhere alone (`SHARED_CHORDS`). The run-control keys, which each client still sets, are deferred.

**Look (principles 2 and 3).**

<a id="li2"></a>

### LI2. One concept table and a Piwi icon set built with the brand assets

A concept table gives each concept its glyph in every tool's set (Appendix A).
`apps/application/scripts/generate-brand-assets.mjs`, which already writes both editors' Piwi mark, also writes what the
platforms lack, drawn once from Piwi Picker's outline set (`apps/extension/src/shared/icons.ts`): record, plug,
flaky, region, mock, broadcast and the rest Appendix A lists, with `_dark` and `expui/` variants, and their VS Code
glyphs in the icon font beside `$(piwi-mark)`. A test reads every manifest and icon map and fails on a missing or different glyph. **Lives in**
`packages/editor` or `apps/application/shared` (§13), FSL; the pause bar's glyphs are drawn anew in picker-dom (MIT).
**Replaces** the film strip for record, the person for Connect, four glyphs with two meanings. **Depends on** nothing.
**Revisits** [editor-local-runs.md](../adr/editor-local-runs.md) 6b and 6c (each editor chose its tree icons) and the
status item's icons, which [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 asked for without naming
any. Built with M4.

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
M5 (built).

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
called VS Code's status bar the control center. Step M3 (built).

<a id="li5"></a>

### LI5. One Piwi home per editor

Both homes list the same places in one order: Failures, Runs ([LI9](#li9)), the page, the log, and in JetBrains Get
Started ([LI12](#li12)). The Piwi tool window makes each a tab (Log is new), and its Paused Page and v0.68.0's Worker N
tabs become one worker tab ([LI9](#li9)); VS Code's Piwi panel holds Failures and Runs, its overflow menu opening the
page (an editor tab) and the log. The gear holds Documentation in both, JetBrains' Open in dashboard
acting on the selection; the service sends the view's state and words, node icon keys and tooltips, and a 'Flaky in this
run' group. **Lives in** `failure-tree.ts`, `protocol.ts` and both clients (FSL). **Replaces** the Paused Page and
Worker N tabs side by side, a log with no place in the home, a gear without Documentation. **Depends on** [LI1](#li1),
[LI6](#li6). **Revisits** no decision: [editor-local-runs.md](../adr/editor-local-runs.md) Part 6 built the two trees
apart.

<a id="li7"></a>

### LI7. One test line: one action list, Debug with Piwi, and a test card

The service sends each test line one grouped action list (`SummaryLine.actions`, with the file's summary): Run with Piwi, Debug with Piwi and Verify
×3; Trace, Screenshot and Open in dashboard; Copy context for agent; Record here; the desktop jobs. JetBrains draws it
on the result icon (the right-click, and the click after the test's card) and on the IDE run icon (`JSTestRunLineMarkersAdditionalActionGroup`); VS Code in its
Testing menus and the hover. The gutter acts, the hover explains, the lens informs, quick fixes only edit. Debug with
Piwi builds the dashboard's Debug in my editor run (`RunTestsArgs.debug`) for a failure; a later `piwi/testCard` adds
history, flaky rate, owner and quarantine. **Lives in** `packages/editor` and both clients (FSL). **Replaces** anonymous
gutter actions, a click that opens a browser, five names for run. **Depends on** [LI1](#li1). **Revisits**
[developer-loop-audit.md](developer-loop-audit.md) P1 (Run and Verify ×3 on the result icon built, the run line marker
left) and the line's command, `piwi.openInDashboard` (`packages/editor/src/server.ts:3143-3147`). Steps M8 (built),
[M9](#m9), L5 (built).

<a id="li8"></a>

### LI8. Each IDE's own test UI as Piwi's home

VS Code: Run, Debug and Coverage profiles, the instance's coverage as `FileCoverage` (`loadDetailedCoverage`), and
durations, descriptions and TestTags from `SpecTest`. JetBrains: an SMTRunner console fed by the run channel in
[LI9](#li9)'s Run tab, so every Piwi run gets the IDE's test tree; the result icon a switchable Gutter Icons entry;
Piwi's coverage bar beside the IDE's own, not over it. Piwi's own marks stay for flaky, quarantine, history and
[live-view-next.md](live-view-next.md) Part 6's CI position. **Lives in** both clients and the service (FSL).
**Replaces** coverage VS Code's coverage view never sees, a Debug Test that reaches nothing, two disagreeing state icons
on one JetBrains line. **Depends on** [LI7](#li7), [LI3](#li3). **Revisits**
[editor-extensions-audit.md](../adr/editor-extensions-audit.md) L1 (a results-only Testing view, built) and §6.4 (offer
the IDE's Playwright runner, built with L2). Steps M8 and L2 (built), [M9](#m9).

<a id="li9"></a>

### LI9. Where the editors host a live run

Glance: one status item and one menu per editor, the menu's run section the Run Control group; the line's run part (`Run
#78 · 3 of 9 · Open`, progress kept at a stop) is the study's P5; the count is built. Steering, with no
debug session: VS Code's `editor/title` strip in the debug toolbar's order and a Run Control group in `editor/context`;
JetBrains' `RunMenu`, `EditorPopupMenu` and a Run tab per console run, named after its target with Pause and Step (the
study's P6), as a `RunContentDescriptor` Piwi builds. In the code: a stop line of the paused text and four controls, Go
to the stopped line, a starting state with Stop; the red execution point at a held failure is built. List: a Runs view
and tab, filled by P4 (progress), P5 (Run #N, origin), P6 (each worker's test, Hold failures), P9 (Share live) and P10
(CI runs, read-only). Page: one page per worker with its controls, built. **Lives in** both clients and `packages/editor` (FSL). **Replaces** up to nine icon-only status
items, a clipped stop line, run controls missing from the debugger's places. **Depends on** [LI1](#li1), [LI6](#li6),
the study's phases. **Revisits** [run-control.md](../adr/run-control.md) §3.2 and its Status, which gave up the Run
tab's toolbar because `RunContentExecutor` fixes it: Piwi builds the descriptor itself. Steps M13 (built),
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
dashboard's words (`formatStatusLabel`), and the verdict; clients keep one icon-key map. A cheaper first step runs one
JSON of inputs and outputs through `glue.ts` and `Glue.kt`. Alert only for failures new against the baseline that a run
started here, or local edits, produced (§13). **Lives in** `packages/editor` (FSL). **Replaces** `statusBarView` and
`Glue.statusView`, `testResultHover` and `testResultTooltip`, `connectionSummary`, two verdict builders. **Depends on**
nothing. **Revisits** no decision: it applies `apps/vscode/AGENTS.md`'s rule that a client holds no logic the other
needs, which the status popup of [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M7 put in the client.
Steps M13, M21 and M22 (built).

**Settings and first steps (principles 7 and 8).**

<a id="li11"></a>

### LI11. One settings registry for both editors

`packages/editor/src/settings.ts` gives each option its key, type, default, scope (team, user, machine), group and
order, labels, description, synonyms and docs anchor, as `apps/application/shared/piwi-env-vars.ts` drives the
configuration reference. It generates VS Code's ordered categories, the JetBrains rows or a check of them, a docs table
and the walkthrough's settings step. New switches go through it: `piwi.codeLens`, `gutterIcons`, `coverageMarks`,
`locatorWarnings`, `failingTestTint`, `statusBarAlert`, read by the service to filter once for both
clients. **Lives in** `packages/editor` (FSL). **Replaces** an alphabetical list of code values, scopes that differ per
editor, comments naming wrong paths in Rider. **Depends on** nothing. **Revisits** no decision; each new key joins the
list of [1.0-stabilization.md](1.0-stabilization.md) D25 in the pull request that adds it. Step M10 (built).

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
in JetBrains). Built as step M11.

<a id="li13"></a>

### LI13. The connection first, and one Connect panel in JetBrains

The connection view model ([LI6](#li6)) comes first wherever settings are. In JetBrains, Connect becomes one panel, in
the settings page and as one dialog: the desktop app with its projects, the URL with Test connection, the key with Sign
in…, Paste key… and Remove, a project combo from the instance. The sign-in shows in the panel with Copy code and Copy
link (VS Code's gains Copy link); errors come from one table, and waiting for trust and a Node.js start problem become
states with their fix. **Lives in** `PiwiConnect.kt`, `PiwiConfigurable.kt` and the service's words (FSL). **Replaces**
up to five modal dialogs, a project typed by hand on the settings page, a page that reads None while connected.
**Depends on** [LI6](#li6). **Revisits** no earlier decision. Steps Q27 and M12 (built).

**Messages (principle 8).**

<a id="li14"></a>

### LI14. One notification policy by kind

Each message has one kind and one surface per tool: a result, a request (Debug in my editor, a share link: sticky), an
offer (one at a time), a problem, a confirmation (in the status bar). JetBrains' groups per kind and `PiwiNotifier`
title a run's balloon with its run, and both clients' run notices gain a gear to their setting. `RunEnded` carries the
verdict's words for every run the editor followed, a terminal run's once the study's P7 gives every local run a hub.
Attention on a live run, built, is the study's P6; in a background editor its interrupt is
`AppIcon.requestAttention` or a VS Code notification. **Lives in** both clients and `RunEnded` (FSL). **Replaces** one
'Piwi' title on every balloon, run notices that do not lead to their setting, two hand-worded verdicts. **Depends on**
[LI6](#li6). **Revisits** no decision of its own. Steps M21 (built).

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
to register an MCP server (`PiwiActions.kt:487-488`). Steps M10 and M11 (built), [M23](#m23).

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
[bug-report-to-failing-test.md](../adr/bug-report-to-failing-test.md)'s 'Connect Piwi Picker' card. Its step, editors
opening the desktop app's pages through `piwi://open`, was dropped: the hand-off over HTTP already brings the app's
window forward.

## 11. Defects filed

The defects still open on `PiwiTests/piwi`, grouped by area as the repository's issues are.

| Issue | What still holds                                                                                                 | Findings    |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| #1118 | Rider's highlighting of a spec folder beside the solution is unchecked, and nothing offers to attach that folder | [RD3](#rd3) |

## 12. The plan

Ranked by what each change buys a developer per day, then by size; each step is one pull request under the commit scope
in its row unless the row names more, and each quick win lands with the test that holds it. Every step that adds a
command id, action id, group id, view id or setting key registers it in D25 in the same pull request.

### Quick wins

| Step | Change | Scope | Findings |
| ---- | ------ | ----- | -------- |

### Medium

| Step                | Change                                                                                                                                                                                                                                                                                        | Scope | Findings                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------- |
| <a id="m9"></a>M9   | **Piwi on the IDE run icon in JetBrains, and its result icon switchable**; the editor fixture gets a real `@playwright/test`                                                                                                                                                                  | `ide` | [TL3](#tl3), [TL4](#tl4)              |
| <a id="m17"></a>M17 | **A Rider descriptor and a Rider scene** ([LI16](#li16)): Rider's highlighting of a folder beside the solution and the Attach Folder balloon (#1118), C# files' marks and lenses checked before the listings and `editor-coverage.md` claim them, `jetbrains.md`'s Rider table from the scene | `ide` | [RD3](#rd3), [RD4](#rd4), [AC3](#ac3) |
| <a id="m23"></a>M23 | **Agents through the JetBrains IDE's MCP server** ([LI18](#li18)); first check that the toolset reaches the AI Assistant and Junie                                                                                                                                                            | `ide` | [ST22](#st22)                         |

### Large

| Step              | Change                                                                                                                                                                                                                                                                          | Scope  | Findings                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| <a id="l1"></a>L1 | **A Runs home for the developer's own runs in both editors**, placed as [LI9](#li9) says, with the catalog's actions, keys and names, Hold failures on each run's row, and the place of the CI list settled                                                                     | `ide`  | [LR7](#lr7), [LR9](#lr9), [LR10](#lr10), [NF10](#nf10) |
| <a id="l3"></a>L3 | **A debug session spike, decided for both IDEs** ([LI10](#li10)), tried in Rider with the backend under the debugger                                                                                                                                                            | `ide`  | [LR3](#lr3)                                            |
| <a id="l4"></a>L4 | **Endpoint-level reach**: the manifest's handler line in `integrations/aspnetcore` first (MIT; no scope fits, so that commit has none), then the lens (`ide`) and Open in IDE on .NET frames (`ui`)                                                                             | `ide`  | [RD7](#rd7), [RD8](#rd8)                               |
| <a id="l6"></a>L6 | **Both editors checked on the shared fixture, without a license** ([LI19](#li19)): a `CodeVisionTestCase` expecting VS Code's row, `findAllGutters`, golden fixtures through `glue.ts` and `Glue.kt`, and the nightly layout checks; the workflow change as its own `ci` commit | `ide`  | none ([LI19](#li19))                                   |
| <a id="l7"></a>L7 | **Decide what Piwi is for Playwright on .NET**: a non-goal in `ROADMAP.md`, or a proposal for an MIT NuGet adapter                                                                                                                                                              | `docs` | none ([LI17](#li17))                                   |

### Sequence

On the action catalog, one Piwi menu (M3, built); M17 closes #1118; L1's Runs home settles where the CI list goes (NF10); L3 decides before 1.0
whether M14's places are interim.

## 13. Open questions

1. **A debug session or not** ([LI10](#li10)): keep [run-control.md](../adr/run-control.md) §3.2's choice and give
   Piwi's controls the debugger's places ([LI9](#li9)), or an inline `DebugAdapter` and an `XDebugProcess`? To decide
   before 1.0 freezes the run-control ids D25 lists.
2. **Caret or cursor**, decided: each platform's word, as the action catalog says it (`{cursor}` in
   `packages/editor/src/actions.ts`: Run to the cursor in VS Code, Run to the caret in JetBrains).
3. **Two marks**: flaky takes the dashboard's fuchsia shuffle (§2 principle 3). Can VS Code's margin show
   the flaky mark beside the Testing view's glyph, and can JetBrains' gutter animate the running ring? Yes: it turns (M5).
   Record's action icon is decided: gray, with red kept for the recording state, as JetBrains' icon style asks.
4. **Where the concept table lives** (the catalog and the settings registry are in `packages/editor`, [LI1](#li1),
   [LI11](#li11)): `packages/editor`, bundled by both clients, or `apps/application/shared` beside `piwi-features.ts`
   and `piwi-ecosystem.ts`? Both are FSL; `packages/core` is MIT and cannot take Piwi Picker's drawings. Are
   `package.json` and `plugin.xml` generated from them, or kept by hand under a test?
5. **The codicons' floor**: the codicons Appendix A proposes exist in VS Code 1.143.1 and are unchecked against the
   1.91 engines floor.
6. **VS Code's status click**, decided: the status menu, with the state's action preselected so Enter keeps today's
   refresh.
7. **What turns the status item to its alarm**, decided: failures new against the baseline that the
   editor's own run produced, both conditions, with `piwi.statusBarAlert` (`new`, `any`, `never`) and its JetBrains twin.
8. **Where VS Code's Runs view lives**: in the Piwi panel beside Failures, matching JetBrains' Runs tab (this document's
   lean), or in Run and Debug, where developers looked at a stop? Whether JetBrains draws its run views in Swing or JCEF
   is the live-run study's open question 9.
9. **Plain Run and breakpoints**, decided: a plain Run pauses at none, Debug with Piwi does (`piwi.breakpoints` `debug`,
   its default; `always` keeps every run stopping, an old `true` read as it), as the IDE's own Run and Debug.
   Headedness is the live-run study's question 10; its P6 holds failures for an editor's debug run.
10. **A CI run on the status line**: the study puts the developer's own run first (P5) and lists CI runs of the branch
    read-only (P10). Does a CI run ever take the line while none of the developer's own is live?
11. **Team or personal settings**: which does a team share (`failureSeverity` in particular)? The new switches go into
    D25 before 1.0, and the service filters by them ([LI11](#li11)).
12. **JetBrains' Get Started tab**: answered by M11, opened once per installation, as SonarQube for IDE's welcome is,
    in place of [editor-extensions-audit.md](../adr/editor-extensions-audit.md) M8's first-run balloon.
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
18. **The in-editor debug action's name**, decided: Debug with Piwi, beside Run with Piwi and Verify ×3 with Piwi, on a
    test's line and on a failure's node alike, in the catalog (`packages/editor/src/actions.ts`).
19. **Playwright for .NET, Java and Python** ([LI17](#li17)): a non-goal stated everywhere a .NET user looks, or a NuGet
    adapter in `integrations/`? The maintainer's scope decision.

## 14. Found since: what building the plan added

The reviews at `b0ff6772` read the code that built the plan and the live-run study's phases against §2's principles.
Each finding below is new, read in the code at that commit; Kotlin files are cited by name as above. The defects among
them were filed as #1315 and #1255, both closed.

<a id="nf10"></a>**NF10. The CI list sits outside §8.4's places.** CI runs got a view and a tab of their own
(`apps/vscode/src/ci-view.ts`, `PiwiCiRuns.kt`), while §8.4 puts them as read-only rows of a Runs view and tab, which
the developer's own runs still lack. **(read)** Fix: settle in [L1](#l1) whether the CI list joins the Runs home.
([L1](#l1))

## Appendix A. The concept table, first draft

One row per concept, one glyph per tool, as §2 and [LI2](#li2) propose it. A JetBrains `*.svg` is Piwi's, in the
plugin's `icons/` with a `_dark` copy. **(new)** marks a glyph Piwi is still to draw: a JetBrains SVG, a VS Code glyph
in the product-icon font, a Piwi Picker key added to `apps/extension/src/shared/icons.ts`. A dash means the tool has no
such action.

| Concept                                         | Dashboard and desktop (lucide) | Piwi Picker (ICONS key) | VS Code (codicon or `$(piwi-*)`)                    | JetBrains (AllIcons or plugin SVG)                                                                            |
| ----------------------------------------------- | ------------------------------ | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Connect                                         | `plug`                         | `plug`                  | `$(plug)`                                           | `connect.svg`                                                                                                 |
| Disconnect                                      | `unplug`                       | `unlink`                | `$(debug-disconnect)`                               | `disconnect.svg`                                                                                              |
| An instance that does not answer                | –                              | –                       | `$(piwi-unreachable)`                               | `unreachable.svg`                                                                                             |
| Get started                                     | –                              | –                       | `$(book)`                                           | `AllIcons.General.ShowInfos`                                                                                  |
| Record                                          | `circle`, filled               | `record`                | `$(record)`                                         | `record.svg`, gray; `recording.svg`, red, while recording                                                     |
| Recording paused                                | –                              | `record`, gray          | `$(circle-large-outline)`                           | `recordPaused.svg`                                                                                            |
| A test's actions                                | –                              | –                       | `$(list-selection)`                                 | the result icon itself (its click)                                                                            |
| Debug a test or a failure                       | –                              | –                       | `$(debug-alt)`                                      | `AllIcons.Actions.StartDebugger`                                                                              |
| Stop recording                                  | –                              | `stop-circle`           | `$(stop-circle)`                                    | `stopRecording.svg`                                                                                           |
| Resume                                          | `play`                         | `play`                  | `$(debug-continue)`                                 | `Actions.Resume`                                                                                              |
| Pause                                           | `pause`                        | `pause`                 | `$(debug-pause)`                                    | `Actions.Pause`                                                                                               |
| Step                                            | `redo-dot`                     | `skip`                  | `$(debug-step-over)`                                | `Actions.TraceOver`                                                                                           |
| Finish                                          | `arrow-up-from-dot`            | `step-out`              | `$(debug-step-out)`                                 | `Actions.StepOut`                                                                                             |
| End the test                                    | `ban`                          | `blocked`               | `$(circle-slash)`                                   | `RunConfigurations.TestIgnored`                                                                               |
| Stop the run                                    | `square`                       | `stop`                  | `$(debug-stop)`                                     | `Actions.Suspend`                                                                                             |
| Pick                                            | `crosshair`                    | `pick`                  | `$(target)`                                         | `General.Locate`                                                                                              |
| Assert                                          | `check-circle`                 | `check-circle`          | `$(pass)`                                           | `General.InspectionsOK`                                                                                       |
| Assert a region                                 | `scan`                         | `viewport`              | `$(piwi-region)`                                    | `region.svg`                                                                                                  |
| Mock a request                                  | `network`                      | `network`               | `$(piwi-mock)`                                      | `mock.svg`                                                                                                    |
| Share live                                      | `radio`                        | `broadcast`             | `$(broadcast)`                                      | `live.svg`                                                                                                    |
| Stop sharing live                               | `circle-stop`                  | `eye-off`               | `$(piwi-stop-live)`                                 | `stopLive.svg`                                                                                                |
| Watch                                           | `eye`                          | `eye`                   | `$(eye)`, built for Watch a worker's test           | `Actions.Show`, built for `Piwi.WatchWorker`                                                                  |
| Interact                                        | `hand`                         | `hand`                  | the hand, drawn in a worker's page, built           | `interact.svg`, built                                                                                         |
| Write code…                                     | -                              | -                       | a lens and a page's button, no glyph                | `Actions.IntentionBulb`, built on a worker's page                                                             |
| Pause and watch                                 | `pause`, `eye` once stopped    | `pause`                 | `$(piwi-pause-watch)`                               | `pauseWatch.svg`                                                                                              |
| Run on my machine                               | `monitor-play`                 | –                       | –                                                   | –                                                                                                             |
| Run headed, Hold failures (start options)       | –                              | –                       | `$(settings)` on Run options…                       | `General.Settings` on Run options…, `Debugger.Db_exception_breakpoint` for Hold failures, none for Run headed |
| Show the stopped test's browser                 | –                              | –                       | `$(browser)`                                        | `browser.svg`                                                                                                 |
| Share with Playwright tools                     | –                              | –                       | `$(tools)`                                          | `tools.svg`                                                                                                   |
| Reset the runs' MCP token                       | –                              | –                       | `$(key)`                                            | `key.svg`                                                                                                     |
| Run the tests that reach this file              | –                              | –                       | `$(references)`                                     | `testsForFile.svg`                                                                                            |
| A CI run of the branch                          | –                              | –                       | `$(cloud)`                                          | `ciRun.svg`                                                                                                   |
| Pair                                            | `link`                         | `link`                  | `$(link)`                                           | `pair.svg`                                                                                                    |
| Open in dashboard                               | `external-link`                | `external`              | `$(link-external)`                                  | `Ide.External_link_arrow`                                                                                     |
| Latest run, run node, Open the failures         | the Piwi mark                  | –                       | `$(piwi-mark)`, built for Open the failures         | `piwi.svg`, 16 px outline, built for `Piwi.OpenFailures`                                                      |
| Cluster                                         | `layers`                       | –                       | `$(layers)`                                         | `layers.svg`                                                                                                  |
| Owner                                           | `user`                         | –                       | `$(person)`                                         | `General.User`                                                                                                |
| Trace                                           | `file-archive`                 | –                       | `$(file-zip)`                                       | `FileTypes.Archive`                                                                                           |
| Screenshot                                      | `camera`                       | `camera`                | `$(device-camera)`                                  | `FileTypes.Image`                                                                                             |
| Reproduce in the desktop app                    | `monitor`                      | `monitor`               | `$(device-desktop)`                                 | `Nodes.Desktop`                                                                                               |
| Find the breaking commit                        | `git-branch`                   | –                       | `$(git-branch)`                                     | `Vcs.Branch`                                                                                                  |
| Flake Lab                                       | `flask-conical`                | –                       | `$(beaker)`                                         | `flask.svg`                                                                                                   |
| File an issue                                   | `circle-dot`                   | –                       | `$(issues)`                                         | `issue.svg`                                                                                                   |
| Verify ×3                                       | –                              | –                       | `$(sync)`                                           | `Actions.Rerun`                                                                                               |
| Go to a failure's test                          | –                              | –                       | `$(go-to-file)`                                     | `Nodes.Test`                                                                                                  |
| Run this spec                                   | –                              | –                       | `$(run-all)`                                        | `Actions.RunAll`                                                                                              |
| Re-run the failing tests                        | –                              | –                       | `$(run-errors)`                                     | `RunConfigurations.RerunFailedTests`                                                                          |
| Coverage                                        | `scan-line`                    | –                       | `$(run-coverage)`                                   | `General.RunWithCoverage`                                                                                     |
| Passed: `emerald-500` `#10b981`                 | `check-circle-2`               | a dot in the fill       | `test-passed.svg`                                   | `RunConfigurations.TestPassed`                                                                                |
| Failed: `rose-500` `#f43f5e`                    | `x-circle`                     | a dot in the fill       | `test-failed.svg`                                   | `RunConfigurations.TestError`                                                                                 |
| Flaky: `fuchsia-500` `#d946ef`                  | `shuffle`                      | a dot in the fill       | `test-flaky.svg`, and `$(piwi-flaky)` for a codicon | `testFlaky.svg`                                                                                               |
| Running: `blue-500` `#3b82f6`                   | `loader-circle`, spinning      | –                       | a ring in `test-running.svg`, spinning              | `testRunning.svg`, a ring, turning                                                                            |
| Skipped: `zinc-400` `#a1a1aa`; fixme `zinc-600` | `minus-circle`                 | a dot in the fill       | `test-skipped.svg`                                  | `RunConfigurations.TestIgnored`                                                                               |
| Did not run: `amber-500` `#f59e0b`              | `circle-slash`                 | –                       | –                                                   | `RunConfigurations.TestNotRan`                                                                                |
| Interrupted: `slate-500` `#64748b`              | `circle-pause`; the tray's dot | –                       | –                                                   | –                                                                                                             |

The last seven rows are `STATUS_COLORS` (`apps/application/shared/status-colors.ts:36-45`) with the dashboard's
`getStatusIcon` glyphs (`apps/application/app/utils/index.ts:311-331`). The outcome palette adds four states with no key
there: unknown (JetBrains draws `TestNotRan`, VS Code nothing), paused, a held failure and recording.

Every platform constant is to be checked on 241 and 262, and every codicon against the 1.91 engines floor, before use. A
first pass found each AllIcons constant above mapped to a New UI icon in both platforms' `PlatformIconMappings.json`,
and each codicon in the `codicon.css` VS Code 1.143.1 bundles; every lucide name is in the dashboard's icon set, though
`redo-dot` and `arrow-up-from-dot` are not used by the dashboard yet.

The draft leaves its collisions to settle, which `menus.test.ts` and `PiwiPluginTest` list as the glyphs two concepts
still share: `RunConfigurations.TestIgnored` is both End the test and Skipped;
lucide `scan` sits close to `scan-line`, and `ban` to `circle-slash`. The desktop app's Pick on the image draws
`mouse-pointer-click` (`apps/application/app/components/desktop/DesktopRunStopPage.vue:356`) where the dashboard's Pick
draws `crosshair`.

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
- **VS Code's Testing view** follows a live run test by test (`apps/vscode/src/test-explorer.ts:379-411`) **(read)**.
