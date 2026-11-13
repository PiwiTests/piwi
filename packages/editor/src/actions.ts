/**
 * The editors' actions: each one's id in VS Code (a command of `apps/vscode/package.json`) and in JetBrains (actions
 * of `apps/jetbrains/.../plugin.xml`), and the one title both show. `tests/actions.test.ts` holds both manifests to it.
 *
 * A title is in sentence case and ends with an ellipsis when the action asks for something before it acts (a pick, a
 * name, a start page). Two words are each editor's own: `{cursor}` (VS Code's cursor, JetBrains' caret) and `{window}`
 * (what a VS Code window or a JetBrains project holds).
 */
export interface EditorAction {
  title: string;
  /** VS Code's command id, for an action VS Code has. */
  vscode?: string;
  /** JetBrains' action ids, for an action JetBrains has: one per place that registers it on its own. */
  jetbrains?: string[];
}

export type Editor = 'vscode' | 'jetbrains';

/** The words each editor says its own way. */
export const EDITOR_WORDS: Record<Editor, Record<'cursor' | 'window', string>> = {
  vscode: { cursor: 'cursor', window: 'window' },
  jetbrains: { cursor: 'caret', window: 'project' },
};

/** An action's title as one editor shows it. */
export function actionTitle(action: EditorAction, editor: Editor): string {
  return action.title.replace(/\{(cursor|window)\}/g, (_, word: 'cursor' | 'window') => EDITOR_WORDS[editor][word]);
}

export const EDITOR_ACTIONS: readonly EditorAction[] = [
  { title: 'Connect…', vscode: 'piwi.connect', jetbrains: ['Piwi.Connect'] },
  { title: 'Disconnect', vscode: 'piwi.disconnect', jetbrains: ['Piwi.Disconnect'] },
  { title: 'Settings…', vscode: 'piwi.openSettings', jetbrains: ['Piwi.OpenSettings'] },
  { title: 'Open the log', vscode: 'piwi.openLog', jetbrains: ['Piwi.OpenLog'] },
  { title: 'Reload Piwi', vscode: 'piwi.refresh', jetbrains: ['Piwi.Refresh'] },
  { title: 'Restart the editor service', vscode: 'piwi.restartService', jetbrains: ['Piwi.RestartService'] },
  { title: 'Refresh the latest run', vscode: 'piwi.refreshRun', jetbrains: ['Piwi.RefreshRun'] },
  { title: 'Run the tests that reach this file', vscode: 'piwi.runTestsForFile', jetbrains: ['Piwi.RunTestsForFile'] },
  { title: 'Run the test at the {cursor}', vscode: 'piwi.runTestAtCursor', jetbrains: ['Piwi.RunTestAtCursor'] },
  {
    title: 'Verify the test at the {cursor} ×3',
    vscode: 'piwi.verifyTestAtCursor',
    jetbrains: ['Piwi.VerifyTestAtCursor'],
  },
  { title: 'Run this spec', vscode: 'piwi.runSpec', jetbrains: ['Piwi.RunSpec'] },
  { title: 'Run a saved selection…', vscode: 'piwi.runSelection', jetbrains: ['Piwi.RunSelection'] },
  { title: 'Open in dashboard', vscode: 'piwi.openInDashboard', jetbrains: ['Piwi.OpenInDashboard'] },
  { title: 'Open the latest run', vscode: 'piwi.openRun', jetbrains: ['Piwi.OpenLatestRun'] },
  { title: 'Open the run page', vscode: 'piwi.openRunPage', jetbrains: ['Piwi.OpenRunPage'] },
  { title: 'Turn hold failures on or off for the run', vscode: 'piwi.holdFailures', jetbrains: ['Piwi.HoldFailures'] },
  {
    title: 'Copy the MCP server configuration',
    vscode: 'piwi.copyMcpConfiguration',
    jetbrains: ['Piwi.CopyMcpConfiguration'],
  },
  {
    title: "Copy the runs' MCP server configuration for agents",
    vscode: 'piwi.copyRunsMcpConfiguration',
    jetbrains: ['Piwi.CopyRunsMcpConfiguration'],
  },
  {
    title: "Reset the runs' MCP server token",
    vscode: 'piwi.resetRunsMcpToken',
    jetbrains: ['Piwi.ResetRunsMcpToken'],
  },
  { title: 'Pair with Piwi Picker', vscode: 'piwi.pairPicker', jetbrains: ['Piwi.PairPicker'] },
  { title: 'Run this test', vscode: 'piwi.runTest', jetbrains: ['Piwi.Failure.RunTest'] },
  { title: 'Re-run the failing tests', vscode: 'piwi.rerunFailing', jetbrains: ['Piwi.RerunFailing'] },
  { title: 'Compare with…', vscode: 'piwi.compareWith', jetbrains: ['Piwi.CompareWith'] },
  { title: 'Copy context for agent', vscode: 'piwi.copyAgentContext', jetbrains: ['Piwi.Failure.CopyContext'] },
  { title: 'Show or hide the coverage marks', vscode: 'piwi.toggleCoverage', jetbrains: ['Piwi.ToggleCoverageMarks'] },
  { title: 'Reproduce in the desktop app', vscode: 'piwi.reproduceInDesktop', jetbrains: ['Piwi.Failure.Reproduce'] },
  {
    title: 'Find the breaking commit in the desktop app',
    vscode: 'piwi.bisectInDesktop',
    jetbrains: ['Piwi.Failure.FindBreakingCommit'],
  },
  { title: 'Open the trace', vscode: 'piwi.openTrace', jetbrains: ['Piwi.Failure.OpenTrace'] },
  { title: 'Open the screenshot', vscode: 'piwi.openScreenshot', jetbrains: ['Piwi.Failure.OpenScreenshot'] },
  { title: 'Record here…', vscode: 'piwi.record', jetbrains: ['Piwi.RecordHere', 'Piwi.RecordHereGenerate'] },
  { title: 'Record a new test file…', vscode: 'piwi.recordFile', jetbrains: ['Piwi.RecordNewFile'] },
  { title: 'Stop recording', vscode: 'piwi.stopRecording', jetbrains: ['Piwi.StopRecording'] },
  { title: 'Pause recording', vscode: 'piwi.pauseRecording', jetbrains: ['Piwi.PauseRecording'] },
  { title: 'Resume recording', vscode: 'piwi.resumeRecording', jetbrains: ['Piwi.ResumeRecording'] },
  { title: 'Pause the run', vscode: 'piwi.pauseRun', jetbrains: ['Piwi.PauseRun'] },
  { title: 'Stop the run', vscode: 'piwi.stopRun', jetbrains: ['Piwi.StopRun'] },
  { title: 'Resume the run', vscode: 'piwi.resumeRun', jetbrains: ['Piwi.ResumeRun'] },
  { title: 'Step to the next call', vscode: 'piwi.stepRun', jetbrains: ['Piwi.StepRun'] },
  { title: 'Run to the {cursor}', vscode: 'piwi.runToCursor', jetbrains: ['Piwi.RunToCaret'] },
  { title: 'Finish the test', vscode: 'piwi.finishRun', jetbrains: ['Piwi.FinishRun'] },
  { title: 'End the test', vscode: 'piwi.endTest', jetbrains: ['Piwi.EndTest'] },
  { title: 'Show the paused page', vscode: 'piwi.showPausedPage', jetbrains: ['Piwi.ShowPausedPage'] },
  { title: "Watch a worker's test", vscode: 'piwi.watchWorker', jetbrains: ['Piwi.WatchWorker'] },
  { title: "Pause and watch a worker's test", vscode: 'piwi.pauseAndWatch', jetbrains: ['Piwi.PauseAndWatch'] },
  { title: 'Open the trace so far', vscode: 'piwi.openTraceSoFar', jetbrains: ['Piwi.OpenTraceSoFar'] },
  { title: 'Pick a locator at the stop', vscode: 'piwi.pickAtStop', jetbrains: ['Piwi.PickAtStop'] },
  { title: 'Record at the stop', vscode: 'piwi.recordAtStop', jetbrains: ['Piwi.RecordAtStop'] },
  { title: 'Assert at the stop', vscode: 'piwi.assertAtStop', jetbrains: ['Piwi.AssertAtStop'] },
  { title: 'Assert a region at the stop', vscode: 'piwi.assertRegionAtStop', jetbrains: ['Piwi.AssertRegionAtStop'] },
  { title: 'Mock a request at the stop…', vscode: 'piwi.mockAtStop', jetbrains: ['Piwi.MockAtStop'] },
  {
    title: "Share the stopped test's browser with Playwright tools",
    vscode: 'piwi.shareWithPlaywright',
    jetbrains: ['Piwi.ShareWithPlaywright'],
  },
  { title: "Show the run's flaky tests", vscode: 'piwi.showFlakyTests', jetbrains: ['Piwi.ShowFlakyTests'] },
  { title: "Show the stopped test's browser", vscode: 'piwi.showBrowser', jetbrains: ['Piwi.ShowBrowser'] },
  { title: 'Share the run live on the team instance', vscode: 'piwi.shareRunLive', jetbrains: ['Piwi.ShareRunLive'] },
  { title: 'Stop sharing the run live', vscode: 'piwi.stopSharingRun', jetbrains: ['Piwi.StopSharingRun'] },
  {
    title: "Share this {window}'s runs live until I stop",
    vscode: 'piwi.shareWindowLive',
    jetbrains: ['Piwi.ShareWindowLive'],
  },
  {
    title: "Stop sharing this {window}'s runs live",
    vscode: 'piwi.stopSharingWindowLive',
    jetbrains: ['Piwi.StopSharingWindowLive'],
  },
  { title: 'Get started', vscode: 'piwi.getStarted' },
  { title: 'Run options…', vscode: 'piwi.runOptions' },
  { title: 'Open the run in progress', vscode: 'piwi.openLiveRun' },
  { title: 'Run tests', vscode: 'piwi.runTests' },
  { title: 'Group the failures by…', vscode: 'piwi.groupFailuresBy' },
  { title: 'Follow the active editor', vscode: 'piwi.toggleFollowEditor' },
  { title: 'Stop following the active editor', vscode: 'piwi.stopFollowingEditor' },
  { title: 'Run a command', vscode: 'piwi.runCommand' },
  { title: 'Copy text', vscode: 'piwi.copyText' },
  { title: 'Reproduce, bisect or run Flake Lab in the desktop app', vscode: 'piwi.desktopJob' },
  { title: 'Look into this flake…', vscode: 'piwi.lookIntoFlake' },
  { title: 'Shared live: open the run page, copy its link or stop sharing…', vscode: 'piwi.liveMenu' },
  { title: 'Write code at the stop…', vscode: 'piwi.codeAtStop' },
  { title: 'Run headed', jetbrains: ['Piwi.RunHeaded'] },
  { title: "Hold failures from each run's start…", jetbrains: ['Piwi.RunHoldFailures'] },
  {
    title: "Copy the runs' MCP server configuration for Claude Code or Cursor",
    jetbrains: ['Piwi.CopyRunsMcpHttpConfiguration'],
  },
  { title: 'Documentation', jetbrains: ['Piwi.OpenDocumentation'] },
  { title: 'Go to the stopped line', jetbrains: ['Piwi.ShowStop'] },
  { title: 'Open the failures', jetbrains: ['Piwi.OpenFailures'] },
  { title: 'Node.js settings…', jetbrains: ['Piwi.NodeSettings'] },
  { title: 'Go to the recorded lines', jetbrains: ['Piwi.GoToRecordedLines'] },
];
