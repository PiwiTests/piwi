#!/usr/bin/env node
// Piwi's showcase: one story, an order the shop's redesign broke, fixed from the failure page to the green run, played
// on the real tools (the dashboard, VS Code with the Piwi extension, Piwi Picker, the reporter, the test's browser) on
// one X screen. In check mode it plays every beat without capture or holds and asserts what each one left: the only
// run of the dashboard, the editor service, the VS Code extension, Piwi Picker and the reporter together.
//
//   xvfb-run -a -s "-screen 0 3840x2160x24" node showcase.mjs --mode check [--until <beat>] [--out <dir>] [--keep]
//
// It needs the reporter, the Nitro integration, the VS Code extension (with the editor service) and Piwi Picker built,
// VS Code downloaded into apps/vscode/.vscode-test (the extension's suites download it), and Playwright's Chromium.
// `--until` ends the take after that beat; `--keep` leaves the set's folder in place; `--lint` checks the lines alone.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gestures, captureScreen, lintLines, play } from './lib/script.mjs';
import { SCALE, buildSet } from './lib/set.mjs';
import { STORY } from './story.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const mode = option('--mode') ?? 'check';
const until = option('--until');
const out = path.resolve(option('--out') ?? path.join(here, 'results'));
const say = (line) => console.log(line);

/** The variables by which the reporter, Playwright and the sample app tell a CI run (`detectCi` and the CI ids). */
const CI_VARIABLE =
  /^(CI|CONTINUOUS_INTEGRATION|BUILD_NUMBER|RUN_ID|GITHUB_\w+|RUNNER_\w+|JENKINS_URL|BUILD_ID|GITLAB_CI|CI_\w+|CIRCLECI|CIRCLE_\w+|TRAVIS|TRAVIS_\w+|TF_BUILD|BUILD_\w+|SYSTEM_\w+|BITBUCKET_\w+|TEAMCITY_\w+|CODEBUILD_\w+|bamboo_\w+|BUILDKITE|BUILDKITE_\w+|SEMAPHORE|SEMAPHORE_\w+|APPVEYOR|APPVEYOR_\w+|DRONE|DRONE_\w+)$/;

const problems = lintLines(STORY);
if (problems.length) {
  for (const problem of problems) console.error(`line: ${problem}`);
  process.exit(1);
}
if (args.includes('--lint')) {
  say(`${STORY.length} beats, every line within ${2} rows and its reading speed.`);
  process.exit(0);
}
if (mode !== 'check') {
  console.error(`--mode ${mode}: only check mode is built; film mode comes with capture and the cut.`);
  process.exit(2);
}
if (until && !STORY.some((b) => b.id === until)) {
  console.error(`--until ${until}: no such beat (${STORY.map((b) => b.id).join(', ')})`);
  process.exit(2);
}

// The set plays a developer's machine: a CI provider's variables leave this process's environment, which every app
// of the set inherits; the "CI" runs name their own.
for (const name of Object.keys(process.env)) {
  if (CI_VARIABLE.test(name)) delete process.env[name];
}

fs.rmSync(out, { recursive: true, force: true });
const logs = path.join(out, 'logs');
fs.mkdirSync(logs, { recursive: true });

const started = Date.now();
let set;
let outcomes = [];
let failed = false;
try {
  say('Building the set');
  set = await buildSet({ say: (step) => say(`  ${step}`), logs });
  const gesture = new Gestures({
    scale: SCALE,
    windows: {
      vscode: () => set.editor.page,
      dashboard: () => set.dashboard,
      runs: () => set.runs,
      'test-browser': () => set.attached.page,
    },
  });
  const context = {
    set,
    gesture,
    editor: set.editor,
    vscode: set.editor.page,
    dashboard: set.dashboard,
    runs: set.runs,
    instance: set.instance,
    repo: set.repo,
    testPage: set.testBrowser,
    state: {},
    /** Raises the window a beat is about first, as the stage shows it. */
    raise: async (window) => {
      if (window === 'vscode') await set.editor.raise();
      else if (window === 'dashboard') await set.dashboard.bringToFront();
      else if (window === 'runs') await set.runs.bringToFront();
      else if (window === 'test-browser' && set.attached?.browser.isConnected()) await set.attached.page.bringToFront();
    },
    /** Runs a VS Code command from its palette, as a person does with F1. */
    palette: async (title) => {
      gesture.log.push({ t: Date.now(), beat: gesture.beat, kind: 'command', window: 'vscode', title });
      await set.editor.command(title);
    },
  };
  say(`Playing the story in ${mode} mode`);
  outcomes = await play({
    beats: STORY,
    context,
    out,
    mode,
    until,
    say,
    keep: async (_beat, dir) => {
      fs.copyFileSync(set.instance.logFile, path.join(dir, 'dashboard.log'));
      set.editor.keepLogs(dir);
      for (const file of fs.readdirSync(logs)) fs.copyFileSync(path.join(logs, file), path.join(dir, file));
      fs.writeFileSync(path.join(dir, 'gestures.json'), JSON.stringify(gesture.log, null, 2));
      // The developer's checkout as it stood: what the beats wrote into it.
      fs.cpSync(set.repo.shop, path.join(dir, 'workspace'), {
        recursive: true,
        filter: (file) => !/[\\/](node_modules|test-results|\.nitro)([\\/]|$)/.test(file),
      });
    },
  });
  fs.writeFileSync(path.join(out, 'gestures.json'), JSON.stringify(gesture.log, null, 2));
  failed = outcomes.some((o) => o.outcome === 'failed');
} catch (error) {
  failed = true;
  console.error(error);
  fs.mkdirSync(path.join(out, 'failed-set'), { recursive: true });
  captureScreen(path.join(out, 'failed-set', 'screen.png'));
} finally {
  await set?.close();
  if (set && !args.includes('--keep')) fs.rmSync(set.dir, { recursive: true, force: true });
}

fs.writeFileSync(path.join(out, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
const skipped = outcomes.filter((o) => o.outcome === 'passed-with-skips').length;
say(
  `${failed ? 'Failed' : 'Passed'}: ${outcomes.filter((o) => o.outcome.startsWith('passed')).length} beats checked` +
    `${skipped ? `, ${skipped} with an assertion skipped for a known bug` : ''}, in ${Math.round((Date.now() - started) / 1000)} s.`,
);
process.exit(failed ? 1 : 0);
