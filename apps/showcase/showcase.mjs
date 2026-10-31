#!/usr/bin/env node
// Piwi's showcase: one story, an order the shop's redesign broke, fixed from the failure page to the green run, played
// on the real tools (the dashboard, VS Code with the Piwi extension, Piwi Picker, the reporter, the test's browser) on
// one X screen. In check mode it plays every beat without capture or holds and asserts what each one left: the only
// run of the dashboard, the editor service, the VS Code extension, Piwi Picker and the reporter together. A virtual
// take films it: the same beats and checks at a person's pace, the whole screen recorded, each beat held while its
// lines are read, and the take log the cut reads; the cut renders the video from a take's results.
//
//   xvfb-run -a -s "-screen 0 3840x2160x24" node showcase.mjs --mode check [--until <beat>] [--out <dir>] [--keep]
//   xvfb-run -a -s "-screen 0 3840x2160x24" node showcase.mjs --take virtual [--until <beat>] [--out <dir>]
//   node showcase.mjs --cut <take's results> [--out <dir>] [--size 1080|2160] [--renderers <n>] [--beats <id,…>]
//
// It needs the reporter, the Nitro integration, the VS Code extension (with the editor service) and Piwi Picker built,
// VS Code downloaded into apps/vscode/.vscode-test (the extension's suites download it), and Playwright's Chromium;
// a take and the cut need ffmpeg. `--until` ends the take after that beat; `--keep` leaves the set's folder in place;
// `--lint` checks the lines alone.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTools } from './lib/capture.mjs';
import { prepareOut } from './lib/results.mjs';
import { Gestures, captureScreen, lintLines, play } from './lib/script.mjs';
import { SCALE, TILES, buildSet, createSet } from './lib/set.mjs';
import { FILM_PACE, startFilming } from './lib/take.mjs';
import { STORY } from './story.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const take = option('--take');
const cutFrom = option('--cut');
const mode = option('--mode') ?? (take ? 'film' : 'check');
const until = option('--until');
const out = path.resolve(option('--out') ?? (cutFrom ? path.join(cutFrom, 'cut') : path.join(here, 'results')));
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
/** Ends, saying what to install, unless ffmpeg and ffprobe run here. */
function needTools() {
  try {
    checkTools();
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

/** Prepares `dir` for results, or ends with what is wrong with it. */
function results(dir, options) {
  try {
    prepareOut(dir, options);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

if (cutFrom) {
  const size = Number(option('--size') ?? 1080);
  const renderers = Number(option('--renderers') ?? 2);
  if (![1080, 2160].includes(size)) {
    console.error(`--size ${size}: the cut is 1080 (1920 × 1080) or 2160 (3840 × 2160)`);
    process.exit(2);
  }
  if (!Number.isInteger(renderers) || renderers < 1 || renderers > 8) {
    console.error(`--renderers ${option('--renderers')}: a whole number from 1 to 8`);
    process.exit(2);
  }
  const takeDir = path.resolve(cutFrom);
  if (!fs.existsSync(path.join(takeDir, 'take.json'))) {
    console.error(`--cut ${cutFrom}: no take.json there, which a take writes in its results`);
    process.exit(2);
  }
  needTools();
  results(out, { keep: takeDir });
  const { cut } = await import('./lib/cut.mjs');
  // A cut stopped from outside ends its renderers and encoders and removes its work folder, then exits with the
  // signal's code.
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (stop.signal.aborted) return;
      say(`${signal}: ending the cut`);
      stop.abort(signal);
    });
  }
  try {
    await cut({ take: takeDir, out, size, renderers, beats: option('--beats')?.split(','), say, signal: stop.signal });
  } catch (error) {
    if (stop.signal.aborted) process.exit(128 + os.constants.signals[stop.signal.reason]);
    console.error(error);
    process.exit(1);
  }
  process.exit(0);
}
if (!['check', 'film'].includes(mode)) {
  console.error(`--mode ${mode}: the modes are check and film`);
  process.exit(2);
}
if (mode === 'film' && (take ?? 'virtual') !== 'virtual') {
  console.error(`--take ${take}: only the virtual take is built; the native take is to come.`);
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

if (mode === 'film') needTools();
results(out);
const logs = path.join(out, 'logs');
fs.mkdirSync(logs, { recursive: true });

const started = Date.now();
const set = createSet({ logs });
let gesture = null;
let filming = null;
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
      await teardown().catch((why) => say(`  ending the set failed: ${why}`));
      process.exit(128 + os.constants.signals[signal]);
    })();
  });
}

let failed = false;
try {
  say('Building the set');
  try {
    await buildSet(set, { say: (step) => say(`  ${step}`) });
    if (mode === 'film') {
      filming = await startFilming({
        set,
        out,
        story: STORY,
        scale: SCALE,
        width: TILES.dashboard.width * SCALE,
        height: TILES.dashboard.height * SCALE,
        say: (step) => say(`  ${step}`),
      });
    }
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
    ...(filming && { pace: FILM_PACE, prepare: filming.prepare }),
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
    raise:
      filming?.raise ??
      (async (window) => {
        if (window === 'vscode') await set.editor.raise();
        else if (window === 'dashboard') await set.dashboard.bringToFront();
        else if (window === 'runs') await set.runs.bringToFront();
        else if (window === 'test-browser' && set.attached?.browser.isConnected()) {
          await set.attached.page.bringToFront();
        }
      }),
    /** Runs a VS Code command from its palette, as a person does with F1. */
    palette: (title) => gesture.command('vscode', title, () => set.editor.command(title)),
  };
  say(`Playing the story in ${mode} mode`);
  await play({
    beats: STORY,
    context,
    out,
    mode,
    until,
    // Once a signal's handler closes the set, the beat it stops fails: the handler tells the take's end.
    say: (line) => {
      if (!interruption) say(line);
    },
    outcomes,
    hooks: filming?.hooks,
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
  if (filming && !interruption) {
    try {
      const counts = await filming.finish({ gestures: gesture?.log ?? [], outcomes });
      // At a constant frame rate, a frame repeated with one dropped is a grab that came late; repeats beyond the drops
      // are frames the capture missed.
      const grabbed = counts.frames - counts.dup + counts.drop;
      say(
        `The master: ${counts.frames} frames at 24 a second, ${grabbed} grabbed (${counts.dup} repeated, ` +
          `${counts.drop} dropped), in ${path.join(out, 'master.mkv')}; its log in ${path.join(out, 'take.json')}`,
      );
      if (counts.problem) {
        failed = true;
        say(`  The master is not sound: ${counts.problem}`);
      } else if (grabbed < counts.frames * 0.95) {
        say('  The capture missed frames: film the take again on a machine with nothing else running.');
      }
    } catch (why) {
      failed = true;
      say(`Ending the capture failed: ${why}`);
    }
  }
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
