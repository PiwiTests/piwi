/** Arguments for `showPauseBar`. */
export interface PauseBarArg {
  /** Where the test is paused, as `login.spec.ts:42`. */
  place: string;
  /** The attempt, 1-based, when the test is retried; null on the first attempt. */
  attempt: number | null;
  /** The action about to run, as `click` or `toBeVisible`. */
  action: string;
  /** The locator the action runs on, as source; null when unknown. */
  locator: string | null;
  /** Whether the editor that started the run can record from here: the bar then offers Record here. */
  record?: boolean;
}

/**
 * What the pause bar answers in `__piwiPauseState`: `resume` runs on to the next breakpoint, `step` pauses at the next
 * action, `pick` opens the element picker and shows the bar again after it, `record` records steps in the page for the
 * editor to write before the paused line, and shows the bar again once the recording stops, `finish` pauses no more in
 * this test.
 */
export type PauseChoice = 'resume' | 'step' | 'pick' | 'record' | 'finish';

/**
 * Runs inside the browser via `evaluate()` — shows a bar fixed at the top of
 * the page while a test is paused before an action: where it is paused, the
 * attempt, the action and its locator, and its buttons (Record here when the editor can record). The choice lands in
 * `__piwiPauseState` (see `PauseChoice`), polled from Node; Esc resumes. The
 * page under the bar stays live. Must stay fully self-contained.
 */
export function showPauseBar(arg: PauseBarArg): void {
  const g = globalThis as any;
  const doc = g.document;
  delete g.__piwiPauseState;
  if (!doc || !doc.body) {
    g.__piwiPauseState = 'resume';
    return;
  }
  if (typeof g.__piwiPauseCleanup === 'function') g.__piwiPauseCleanup();
  const Z = 2147483600;

  const bar = doc.createElement('div');
  bar.id = '__piwi-pause-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Piwi: test paused');
  bar.style.cssText =
    `position:fixed;top:0;left:0;right:0;z-index:${Z + 4};display:flex;align-items:center;gap:12px;` +
    'flex-wrap:wrap;padding:8px 12px;background:#111827;color:#f9fafb;border-bottom:2px solid #a78bfa;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.35);font:13px/1.5 system-ui,sans-serif;';

  const where = doc.createElement('div');
  where.style.cssText = 'font-weight:600;white-space:nowrap;';
  where.textContent = `Paused at ${arg.place}${arg.attempt ? ` · attempt ${arg.attempt}` : ''}`;
  const what = doc.createElement('code');
  what.style.cssText =
    'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8b4fe;' +
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;';
  what.textContent = arg.locator ? `${arg.action} · ${arg.locator}` : arg.action;
  what.title = what.textContent;
  bar.appendChild(where);
  bar.appendChild(what);

  const done = (choice: string) => {
    cleanup();
    g.__piwiPauseState = choice;
  };
  const onKey = (e: any) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done('resume');
  };
  const cleanup = () => {
    doc.removeEventListener('keydown', onKey, true);
    bar.remove();
    delete g.__piwiPauseCleanup;
  };

  const buttons: Array<[label: string, choice: string, hint: string, primary: boolean]> = [
    ['Resume', 'resume', 'Run on to the next breakpoint (Esc)', true],
    ['Step', 'step', 'Pause again at the next action', false],
    ['Pick a locator', 'pick', 'Pick an element on the page and confirm a locator for it', false],
    ...(arg.record
      ? [
          ['Record here', 'record', 'Record steps in this page: the editor writes them before this line', false] as [
            string,
            string,
            string,
            boolean,
          ],
        ]
      : []),
    ['Finish', 'finish', 'Run on and pause no more in this test', false],
  ];
  for (const [label, choice, hint, primary] of buttons) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = hint;
    btn.style.cssText =
      'border-radius:6px;padding:4px 12px;cursor:pointer;font:600 12px/1.5 system-ui,sans-serif;' +
      (primary
        ? 'background:#7c3aed;color:#fff;border:1px solid #7c3aed;'
        : 'background:#1f2937;color:#f3f4f6;border:1px solid #374151;');
    btn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      done(choice);
    });
    bar.appendChild(btn);
  }

  g.__piwiPauseCleanup = cleanup;
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(bar);
}

/**
 * Runs inside the browser — true once the pause bar answered, or once it is
 * gone without an answer (the page navigated): the host shows it again then.
 * Must stay fully self-contained.
 */
export function pauseAnswered(): boolean {
  const g = globalThis as any;
  if (g.__piwiPauseState !== undefined) return true;
  return !g.document?.getElementById('__piwi-pause-bar');
}

/**
 * Runs inside the browser — reads the pause bar's answer and removes every
 * trace of it; null when it gave none. Must stay fully self-contained.
 */
export function takePauseState(): string | null {
  const g = globalThis as any;
  const state = g.__piwiPauseState;
  if (typeof g.__piwiPauseCleanup === 'function') g.__piwiPauseCleanup();
  delete g.__piwiPauseCleanup;
  delete g.__piwiPauseState;
  return typeof state === 'string' ? state : null;
}
