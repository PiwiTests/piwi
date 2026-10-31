// A take in film mode: the master recorded while the story plays, the window a gesture acts in raised so the master
// shows it, each beat held while its lines are read, and the take log the cut reads (`take.json`): the beats and their
// lines with their start and length, the gestures with their boxes and points, the windows' rectangles, what was
// raised and when, when the test's browser was open, and the capture's frames. Every time is the wall clock's, in ms.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureProblem, startCapture, syncFlash } from './capture.mjs';
import { contentOnScreen, screenMetrics, waitFor } from './script.mjs';
import { TEST_BROWSER_CDP, listening } from './set.mjs';
import { MASTER_FPS, scheduleLines } from './timeline.mjs';

/** A person's pace: a pause before each gesture, where the cut's pointer travels to it, and a delay between keys. */
export const FILM_PACE = { before: 900, key: 55 };

/** How long a beat's end stays on screen after its last action, before the next beat starts (ms). */
export const SETTLE_MS = 1200;

/** The master's file in a take's results. */
export const MASTER_FILE = 'master.mkv';

/** The take log's file in a take's results, and its format's version. */
export const TAKE_FILE = 'take.json';
const TAKE_VERSION = 1;

/** The tiles a raise brings over the dashboard's window, which covers the screen. */
const TILE_WINDOWS = ['vscode', 'runs', 'test-browser'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page's content on the screen, in device pixels (`contentOnScreen`), with its device pixel ratio. */
async function contentRect(page, scale) {
  return contentOnScreen(await screenMetrics(page), scale);
}

/**
 * Opens the dashboard's pages the beats visit, once, before the capture: the dev server builds each page on its first
 * visit, which takes seconds a take would film. The dashboard is back on the project's runs after.
 */
async function warmDashboard(set) {
  const { dashboard, instance } = set;
  const [red] = await instance.runs();
  const failing = (await instance.run(red.id)).testCases.find((c) => c.status === 'failed');
  await dashboard.goto(`${instance.base}/test-runs/${red.id}`, { waitUntil: 'domcontentloaded' });
  await dashboard
    .getByRole('link', { name: new RegExp(failing.title) })
    .first()
    .waitFor({ timeout: 120_000 });
  await dashboard.goto(`${instance.base}/test-run-cases/${failing.executionId}`, { waitUntil: 'domcontentloaded' });
  // The dev server reloads a page whose new dependencies it has just bundled: the tab is clicked until it shows.
  const debug = dashboard.getByRole('button', { name: 'Debug in my editor' }).first();
  await waitFor(
    async () => {
      if (await debug.isVisible()) return true;
      await dashboard
        .getByRole('tab', { name: /Source/ })
        .click({ timeout: 5_000 })
        .catch(() => {});
      return false;
    },
    'the failure page’s Source tab',
    120_000,
    1_000,
  );
  await dashboard.goto(`${instance.base}/projects/${set.projectId}`, { waitUntil: 'domcontentloaded' });
  await dashboard.getByRole('link', { name: `Run #${red.id}`, exact: true }).waitFor({ timeout: 120_000 });
}

/**
 * Starts filming the built `set` into `out`: opens the dashboard's pages once, measures the windows, starts the
 * capture of the whole screen (`width` × `height`), shows the sync flash, and follows the test's browser's window.
 * Resolves with what the take plays through: `hooks` for `play`, `raise` for the context, `prepare` for the gestures,
 * and `finish`, which ends the capture and writes the take log.
 */
export async function startFilming({ set, out, story, scale, width, height, take = 'virtual', say }) {
  const log = {
    version: TAKE_VERSION,
    take,
    screen: { width, height, scale },
    windows: {},
    beats: [],
    raises: [],
    presence: [],
  };
  say('the dashboard’s pages, opened once before the capture');
  await warmDashboard(set).catch((why) =>
    say(`  opening them failed, the take films their first load: ${why.message}`),
  );
  log.windows.vscode = await contentRect(set.editor.page, scale);
  log.windows.dashboard = await contentRect(set.dashboard, scale);
  log.windows.runs = await contentRect(set.runs, scale);

  // The test's browser of each run is measured once it is reached, the first time.
  const attach = set.testBrowser;
  set.testBrowser = async () => {
    const page = await attach();
    if (!log.windows['test-browser']) log.windows['test-browser'] = await contentRect(page, scale).catch(() => null);
    return page;
  };

  say('the capture: the whole screen, lossless, and the sync flash');
  const capture = startCapture({ file: path.join(out, MASTER_FILE), display: process.env.DISPLAY, width, height });
  set.closers.push(() => capture.stop());
  const running = await capture.running();
  log.master = { file: MASTER_FILE, fps: MASTER_FPS, spawned: capture.spawned, running, raised: capture.raised };
  if (!capture.raised) say('  the capture runs at the set’s priority: nothing here lets it run ahead (root, or sudo)');
  log.flash = await syncFlash({ scale });

  // When the test's browser is open, as its debugging port tells: the cut shows its window only then.
  let open = false;
  const follow = setInterval(async () => {
    const now = await listening(TEST_BROWSER_CDP);
    if (now !== open) log.presence.push({ t: Date.now(), window: 'test-browser', open: now });
    open = now;
  }, 250);

  let up = null;
  /** Raises `window`: the dashboard's window over the screen, or every tile over it. */
  const raise = async (window) => {
    if (!window || window === 'card') return;
    const want = window === 'dashboard' ? 'dashboard' : 'tiles';
    if (want === 'dashboard') await set.dashboard.bringToFront();
    else {
      await set.editor.raise();
      await set.runs.bringToFront();
      if (set.attached?.browser.isConnected() && !set.attached.page.isClosed()) {
        await set.attached.page.bringToFront().catch(() => {});
      }
    }
    if (want !== up) log.raises.push({ t: Date.now(), up: want, window });
    up = want;
  };

  await raise('dashboard');

  let current = null;
  const hooks = {
    started(b) {
      current = { id: b.id, start: Date.now(), lines: scheduleLines(b.lines.en, Date.now()) };
      log.beats.push(current);
    },
    /** The hold: the beat stays until its lines are read, and its last action's result `SETTLE_MS` more. */
    async ended() {
      // A capture that ended before the take has nothing left to film it with.
      const ended = capture.ended();
      if (ended) throw new Error(`the capture ended mid-take (${ended.error ?? `exit ${ended.code ?? ended.signal}`})`);
      const last = current.lines.at(-1);
      const due = Math.max(last ? last.start + last.ms : 0, Date.now() + SETTLE_MS);
      await sleep(due - Date.now());
      current.end = Date.now();
    },
  };

  return {
    hooks,
    raise,
    /** Before a gesture in `window`: raises it when the screen shows the other layer. */
    prepare: async (window) => {
      if (TILE_WINDOWS.includes(window) === (up === 'tiles')) return;
      await raise(window);
    },
    /**
     * Ends the capture and writes the take log with the `gestures` and the `outcomes`; resolves with its counts and
     * `problem`, what is wrong with the master (`captureProblem`), or null.
     */
    async finish({ gestures, outcomes }) {
      clearInterval(follow);
      const stopped = Date.now();
      const counts = await capture.stop();
      const problem = captureProblem(counts, { running, stopped });
      Object.assign(log.master, counts, { stopped, problem });
      log.story = story.map((b) => ({
        id: b.id,
        title: b.title,
        card: !b.run,
        seconds: b.seconds,
        focus: b.focus,
        lines: b.lines.en,
      }));
      log.outcomes = outcomes;
      log.gestures = gestures;
      fs.writeFileSync(path.join(out, TAKE_FILE), JSON.stringify(log, null, 2));
      return { ...counts, problem };
    },
  };
}
