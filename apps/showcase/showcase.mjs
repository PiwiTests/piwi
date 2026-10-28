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
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gestures, captureScreen, lintLines, play } from './lib/script.mjs';
import { SCALE, buildSet, createSet } from './lib/set.mjs';
import { REPO_ROOT } from './lib/workspace.mjs';
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

/** The file that marks a folder as the showcase's results, which a take may empty. */
const RESULTS_MARKER = '.piwi-showcase-results';

/**
 * Empties `dir` for a take's results and marks it. A folder the showcase did not make is never emptied: one that holds
 * files without the marker is refused, and so are the file system's root, the home folder, the repository's root and
 * the current folder.
 */
function prepareOut(dir) {
  const refused = [path.parse(dir).root, os.homedir(), REPO_ROOT, process.cwd()].map((p) => path.resolve(p));
  if (refused.includes(dir)) {
    console.error(`--out ${dir}: a take empties its results folder; name a folder of its own.`);
    process.exit(2);
  }
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length && !entries.includes(RESULTS_MARKER)) {
      console.error(`--out ${dir}: it holds files a take did not write; name an empty folder or a take's results.`);
      process.exit(2);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, RESULTS_MARKER),
    'The results of a showcase take: the next take empties this folder.\n',
  );
}

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

prepareOut(out);
const logs = path.join(out, 'logs');
fs.mkdirSync(logs, { recursive: true });

const started = Date.now();
const set = createSet({ logs });
let gesture = null;
const outcomes = [];

/**
 * What a take that stops keeps in `dir`, in this order, before anything closes: the whole screen, VS Code's logs (the
 * extension host's and the Piwi output), every other app's log (the dashboard's, the "CI" runs', Piwi Picker's), the
 * gestures, and the developer's checkout as the beats left it. Synchronous, so a signal's other handlers come after.
 */
function keepEvidence(dir) {
  fs.mkdirSync(dir, { recursive: true });
  captureScreen(path.join(dir, 'screen.png'));
  set.editor?.keepLogs(dir);
  for (const file of fs.readdirSync(logs)) fs.copyFileSync(path.join(logs, file), path.join(dir, file));
  if (gesture) fs.writeFileSync(path.join(dir, 'gestures.json'), JSON.stringify(gesture.log, null, 2));
  if (set.repo && fs.existsSync(set.repo.shop)) {
    fs.cpSync(set.repo.shop, path.join(dir, 'workspace'), {
      recursive: true,
      filter: (file) => !/[\\/](node_modules|test-results|\.nitro)([\\/]|$)/.test(file),
    });
  }
}

const teardown = () => set.close({ keep: args.includes('--keep') });

// A take stopped from outside (Ctrl+C, the job's cancel or timeout, a closed terminal) keeps what it had, ends the set
// and every process it started, and exits with the signal's code.
let interruption = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interruption ??= (async () => {
      say(`${signal}: keeping the screen and the logs in ${path.join(out, 'interrupted')}, then ending the set`);
      try {
        keepEvidence(path.join(out, 'interrupted'));
      } catch (why) {
        say(`  keeping them failed: ${why}`);
      }
      fs.writeFileSync(path.join(out, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
      await teardown();
      process.exit(128 + os.constants.signals[signal]);
    })();
  });
}

let failed = false;
try {
  say('Building the set');
  try {
    await buildSet(set, { say: (step) => say(`  ${step}`) });
  } catch (error) {
    if (!interruption) {
      console.error(error);
      try {
        keepEvidence(path.join(out, 'failed-set'));
      } catch (why) {
        say(`  keeping the logs failed: ${why}`);
      }
      say(`  the screen and the logs are in ${path.join(out, 'failed-set')}`);
    }
    error.reported = true;
    throw error;
  }
  gesture = new Gestures({
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
  await play({
    beats: STORY,
    context,
    out,
    mode,
    until,
    say,
    outcomes,
    // A beat that fails as a signal's handler closes the set keeps nothing: the handler kept the take as it stood.
    keep: async (_beat, dir) => {
      if (!interruption) keepEvidence(dir);
    },
  });
  fs.writeFileSync(path.join(out, 'gestures.json'), JSON.stringify(gesture.log, null, 2));
  failed = outcomes.some((o) => o.outcome === 'failed');
} catch (error) {
  failed = true;
  if (!error?.reported && !interruption) console.error(error);
} finally {
  if (!interruption) await teardown();
}
// A signal's handler ends the take.
if (interruption) await new Promise(() => {});

fs.writeFileSync(path.join(out, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
const skipped = outcomes.filter((o) => o.outcome === 'passed-with-skips').length;
say(
  `${failed ? 'Failed' : 'Passed'}: ${outcomes.filter((o) => o.outcome.startsWith('passed')).length} beats checked` +
    `${skipped ? `, ${skipped} with an assertion skipped for a known bug` : ''}, in ${Math.round((Date.now() - started) / 1000)} s.`,
);
process.exit(failed ? 1 : 0);
