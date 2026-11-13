// What a person watching a running test sees, read as the checks of the beats that watch: the dashboard's lane panel
// on a CI run, recorded in its page as it changes, and the Runs window's live view of a running test, looked at as it
// shows. The problems each one has are pure, so a test feeds them what a broken view would show.
import { RUN_WORDS_EN } from '@piwitests/run-model/words';

/**
 * How the dashboard's live view says the run ended, once the run page knows how (it says "The run ended." first), and
 * what it says as it ends before the run (`LIVE_VIEW_END_TEXT` in the dashboard's `shared/live-view.ts`).
 */
export const RUN_VERDICT = /^The run (passed|failed|timed out|was interrupted|was cancelled)/;
export const RUN_ENDED = 'The run ended.';
export const VIEW_ENDED = ['The test ended.', 'The worker left the run.'];
/**
 * The longest a watched lane may go without a new image, its run slowed down: from its first image to its last, and
 * from its last to the run's end.
 */
export const MAX_FRAME_GAP_MS = 15_000;
/** The fewest tests of a watched lane that run while it is watched, so that it hands over from one to the next. */
export const MIN_LANE_TESTS = 2;
/** The fewest images a watch shows of a lane whose test runs, slowed down, through the whole watch. */
export const MIN_FRAMES = 3;
/** The longest the Runs window's live view of a running test, slowed down, may show one image while it is watched. */
export const MAX_WATCH_GAP_MS = 3000;

/** A pattern of a sentence of the run model's English words, each `$name$` placeholder standing for any text. */
const wordsPattern = (words) => words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$\w+\\\$/g, '.+');
/**
 * What the Runs window says of a worker standing at a stop, whoever stopped it, or held at its failure: the run model's
 * words of every stop (`runs_stopped…`) and of a failure (`runs_failedAt`, `runs_stateFailed`), as one pattern of the
 * whole text.
 */
export const STOP_WORDS = new RegExp(
  `^(?:${Object.entries(RUN_WORDS_EN)
    .filter(([key]) => key.startsWith('runs_stopped') || key === 'runs_failedAt' || key === 'runs_stateFailed')
    .map(([, words]) => wordsPattern(words))
    .join('|')})$`,
);

/**
 * Records the dashboard's lane panel (docked beside the run page, or a sheet) in the page as it changes: when each new
 * image of the page showed, with how many of the lane's tests had ended then (its earlier tests and the outcome it
 * shows), and each thing its status line said, with the same count. `readLaneLog` reads it back.
 */
export function recordLaneView(page) {
  return page.evaluate(() => {
    const log = { frames: [], statuses: [] };
    window.__showcaseLaneLog = log;
    let src = null;
    let status = null;
    const look = () => {
      const panel = document.querySelector('[data-testid="lane-panel"]');
      if (!panel) return;
      const img = panel.querySelector('[data-testid="live-frame"]');
      const ended =
        panel.querySelectorAll('[data-testid="live-earlier"] li').length +
        (panel.querySelector('[data-testid="live-outcome"]') ? 1 : 0);
      if (img?.src && img.src !== src) {
        src = img.src;
        log.frames.push({ t: Date.now(), ended });
      }
      const said = panel.querySelector('[data-testid="live-status"]')?.textContent.trim() ?? '';
      if (said !== status) {
        status = said;
        log.statuses.push({ t: Date.now(), text: said, ended });
      }
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    look();
  });
}

/** What `recordLaneView` recorded in `page` so far. */
export function readLaneLog(page) {
  return page.evaluate(() => window.__showcaseLaneLog);
}

/**
 * What is wrong with a lane panel's log of a run that passed: none when images kept coming, without a pause longer
 * than `maxGapMs`, through each of the lane's tests from the first one watched (`MIN_LANE_TESTS` of them at least) up
 * to the run's end, and the view stayed open until the run ended, saying it passed.
 */
export function laneLogProblems({ frames, statuses }, maxGapMs = MAX_FRAME_GAP_MS) {
  const problems = [];
  const said = statuses.map((status) => status.text);
  const verdict = said.findIndex((text) => RUN_VERDICT.test(text));
  if (verdict < 0) problems.push(`the live view never said how the run ended: ${JSON.stringify(said)}`);
  else if (!said[verdict].startsWith('The run passed:')) {
    problems.push(`the live view said the run did not pass: ${said[verdict]}`);
  }
  const cut = said.slice(0, verdict < 0 ? said.length : verdict).find((text) => VIEW_ENDED.includes(text));
  if (cut) problems.push(`the live view ended before the run: "${cut}" (${JSON.stringify(said)})`);
  if (frames.length < MIN_FRAMES) {
    problems.push(`the live view showed ${frames.length} images of the page`);
    return problems;
  }
  // The run's end: the first thing the view said of it, up to its verdict.
  const end =
    verdict < 0 ? null : statuses.find((status) => status.text === RUN_ENDED || RUN_VERDICT.test(status.text));
  const times = [...frames.map((shown) => shown.t), ...(end ? [end.t] : [])];
  const longest = Math.max(...times.slice(1).map((t, i) => t - times[i]));
  if (longest > maxGapMs) problems.push(`the lane sent no image for ${longest / 1000} s`);
  const ended = statuses.length ? statuses[statuses.length - 1].ended : 0;
  const watched = ended - frames[0].ended;
  if (watched < MIN_LANE_TESTS) {
    problems.push(`the lane ran ${watched} test while watched: its hand-over to a next test went unchecked`);
  }
  for (let test = frames[0].ended; test < ended; test++) {
    if (!frames.some((shown) => shown.ended === test)) {
      const counts = JSON.stringify(frames.map((shown) => shown.ended));
      problems.push(`no image of the lane's test ${test + 1} of ${ended} (the tests ended at each image: ${counts})`);
    }
  }
  return problems;
}

/**
 * What is wrong with the looks taken at the Runs window's live view of a running test (`{ t, src, stopped }` each,
 * `t` when it was taken): none when the view showed at each look but the first, the page changed in it `MIN_FRAMES`
 * times or more, never showing one image longer than `maxGapMs` from the first look to the last, and the test stood at
 * no stop.
 */
export function watchedProblems(looks, maxGapMs = MAX_WATCH_GAP_MS) {
  if (!looks.length) return ['the live view was never looked at'];
  const problems = [];
  const shown = looks.filter((look) => look.src);
  if (shown.length < looks.length - 1) {
    problems.push(`the live view showed at ${shown.length} of ${looks.length} looks`);
  }
  const images = new Set(shown.map((look) => look.src)).size;
  if (images < MIN_FRAMES) problems.push(`the live view showed ${images} images of the page`);
  const changes = [looks[0], ...looks.filter((look, i) => i > 0 && look.src !== looks[i - 1].src), looks.at(-1)];
  const longest = Math.max(...changes.slice(1).map((look, i) => look.t - changes[i].t));
  if (longest > maxGapMs) problems.push(`the live view showed one image for ${longest / 1000} s`);
  if (looks.some((look) => look.stopped)) problems.push('the test stopped while it was watched');
  return problems;
}
