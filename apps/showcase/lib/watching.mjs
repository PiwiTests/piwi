// What a person watching a running test sees, read as the checks of the beats that watch: the dashboard's lane panel
// on a CI run, recorded in its page as it changes, and the Runs window's live view of a running test, looked at as it
// shows. The problems each one has are pure, so a test feeds them what a broken view would show.

/**
 * How the dashboard's live view says the run ended, once the run page knows how (it says "The run ended." first), and
 * what it says as it ends before the run (`LIVE_VIEW_END_TEXT` in the dashboard's `shared/live-view.ts`).
 */
export const RUN_VERDICT = /^The run (passed|failed|timed out|was interrupted|was cancelled)/;
export const VIEW_ENDED = ['The test ended.', 'The worker left the run.'];
/** The longest a watched lane may go without a new image, from its first to its last, its run slowed down. */
export const MAX_FRAME_GAP_MS = 15_000;
/** The fewest images a watch shows of a lane whose test runs, slowed down, through the whole watch. */
export const MIN_FRAMES = 3;

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
 * than `maxGapMs`, through each of the lane's tests from the first one watched, and the view stayed open until the run
 * ended, saying it passed.
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
  const longest = Math.max(...frames.slice(1).map((shown, i) => shown.t - frames[i].t));
  if (longest > maxGapMs) problems.push(`the lane sent no image for ${longest / 1000} s`);
  const ended = statuses.length ? statuses[statuses.length - 1].ended : 0;
  for (let test = frames[0].ended; test < ended; test++) {
    if (!frames.some((shown) => shown.ended === test)) {
      const counts = JSON.stringify(frames.map((shown) => shown.ended));
      problems.push(`no image of the lane's test ${test + 1} of ${ended} (the tests ended at each image: ${counts})`);
    }
  }
  return problems;
}

/**
 * What is wrong with the looks taken at the Runs window's live view of a running test (`{ src, stopped }` each, every
 * `every` ms for `ms`): none when the view showed at each look but the first, the page changed in it `MIN_FRAMES` times
 * or more, and the test stood at no stop.
 */
export function watchedProblems(looks, { ms, every }) {
  const problems = [];
  const shown = looks.filter((look) => look.src);
  if (looks.length < (ms / every) * 0.8) problems.push(`${looks.length} looks in ${ms / 1000} s`);
  if (shown.length < looks.length - 1) {
    problems.push(`the live view showed at ${shown.length} of ${looks.length} looks`);
  }
  const images = new Set(shown.map((look) => look.src)).size;
  if (images < MIN_FRAMES) problems.push(`the live view showed ${images} images of the page`);
  if (looks.some((look) => look.stopped)) problems.push('the test stopped while it was watched');
  return problems;
}
