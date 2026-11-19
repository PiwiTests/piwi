// What a person watching a running test sees, read as the checks of the beats that watch: VS Code's worker panel on the
// developer's own run, looked at as it shows, and the dashboard's watch of a CI run (Watch all's tiles and the lane
// panel), recorded in its page as it changes. The problems each one has are pure, so a test feeds them what a broken
// view would show.

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
/** The fewest images a watch shows of a lane whose test runs, slowed down, through the whole watch. */
export const MIN_FRAMES = 3;
/** The fewest calls the lane panel names under the image of a test it shows in full, slowed down. */
export const MIN_CALLS = 2;
/** The fewest workers Watch all shows an image of, in a CI run of three workers. */
export const MIN_TILES = 2;
/** The longest the editor's view of a running test, slowed down, may show one image while it is watched. */
export const MAX_WATCH_GAP_MS = 3000;

/**
 * Records the dashboard's watch of a run in its page as it changes: Watch all's tiles (each new image of a worker's
 * page, by the worker it shows), and the lane panel, docked beside the run page or a sheet: when each new image of the
 * page showed, with how many of the lane's tests had ended then (its earlier tests and the outcome it shows), each
 * call it named under the image, the images of its filmstrip, and each thing its status line said, with the same
 * count. `readWatchLog` reads it back.
 */
export function recordWatch(page) {
  return page.evaluate(() => {
    const log = { tiles: {}, frames: [], calls: [], strip: 0, statuses: [] };
    window.__showcaseWatchLog = log;
    let src = null;
    let status = null;
    let call = null;
    const look = () => {
      for (const tile of document.querySelectorAll('[data-testid="watch-all-tile"]')) {
        const image = tile.querySelector('[data-testid="watch-all-image"]');
        const worker = tile.dataset.worker;
        const seen = (log.tiles[worker] ??= []);
        if (image?.src && seen.at(-1)?.src !== image.src) seen.push({ t: Date.now(), src: image.src });
      }
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
      const named = panel.querySelector('[data-testid="live-call"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      if (named && named !== call) {
        call = named;
        log.calls.push(named);
      }
      log.strip = Math.max(log.strip, panel.querySelectorAll('[data-testid="live-filmstrip-shot"]').length);
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

/** What `recordWatch` recorded in `page` so far. */
export function readWatchLog(page) {
  return page.evaluate(() => window.__showcaseWatchLog);
}

/**
 * What is wrong with Watch all's tiles of a run of several workers: none when `minTiles` workers at least showed an
 * image of their page.
 */
export function tileProblems({ tiles }, minTiles = MIN_TILES) {
  const shown = Object.entries(tiles).filter(([, images]) => images.length);
  if (shown.length >= minTiles) return [];
  return [
    `Watch all showed the page of ${shown.length} of ${Object.keys(tiles).length} workers (${minTiles} at least)`,
  ];
}

/**
 * What is wrong with the lane panel's log of a run that passed, the lane shown in full: none when images kept coming,
 * without a pause longer than `maxGapMs`, through each of the lane's tests from the first one watched up to the run's
 * end, the view named the calls of its test (`MIN_CALLS` at least) and their filmstrip, and stayed open until the run
 * ended, saying it passed.
 */
export function laneLogProblems({ frames, calls, strip, statuses }, maxGapMs = MAX_FRAME_GAP_MS) {
  const problems = [];
  const said = statuses.map((status) => status.text);
  const verdict = said.findIndex((text) => RUN_VERDICT.test(text));
  if (verdict < 0) problems.push(`the live view never said how the run ended: ${JSON.stringify(said)}`);
  else if (!said[verdict].startsWith('The run passed:')) {
    problems.push(`the live view said the run did not pass: ${said[verdict]}`);
  }
  const cut = said.slice(0, verdict < 0 ? said.length : verdict).find((text) => VIEW_ENDED.includes(text));
  if (cut) problems.push(`the live view ended before the run: "${cut}" (${JSON.stringify(said)})`);
  const named = calls.filter((text) => text.startsWith('At '));
  if (named.length < MIN_CALLS) {
    problems.push(`the live view named ${named.length} calls under the image: ${JSON.stringify(calls)}`);
  }
  if (!strip) problems.push('the live view showed no filmstrip of the calls that ended');
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
  for (let test = frames[0].ended; test < ended; test++) {
    if (!frames.some((shown) => shown.ended === test)) {
      const counts = JSON.stringify(frames.map((shown) => shown.ended));
      problems.push(`no image of the lane's test ${test + 1} of ${ended} (the tests ended at each image: ${counts})`);
    }
  }
  return problems;
}

/**
 * What is wrong with the looks taken at the editor's view of a running test (`{ t, src, stopped }` each, `t` when it
 * was taken, `stopped` whether the view showed a stop's controls): none when the view showed at each look but the
 * first, the page changed in it `MIN_FRAMES` times or more, never showing one image longer than `maxGapMs` from the
 * first look to the last, and the test stood at no stop.
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

/**
 * The running lines VS Code marks in its visible editors: the text it writes after each line of a call a test is in
 * (`Worker 1 · Click getByRole('button')`), from the decoration's `::after` content.
 */
export function runningLines(vscode) {
  return vscode.evaluate(() => {
    const marks = [];
    for (const span of document.querySelectorAll('.monaco-editor .view-line span')) {
      const content = getComputedStyle(span, '::after').content;
      if (!content || content === 'none' || content === 'normal') continue;
      const text = content.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      if (/^Worker \d+/.test(text)) marks.push(text);
    }
    return marks;
  });
}
