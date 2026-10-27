/** Arguments for `showPickerChoices`. */
export interface PickerChoicesArg {
  failing: string | null;
  choices: Array<{ locator: string; score: number }>;
}

/**
 * Runs inside the browser via `evaluate()` — replaces the pick overlay with a
 * confirmation panel listing the ranked replacement locators. The chosen index
 * lands in `__piwiPickChoice` (-1 = skipped), polled from Node. While it shows,
 * `__piwiChoiceCleanup` takes it out of the page unanswered (a pick that ended
 * under it). Must stay fully self-contained.
 */
export function showPickerChoices(arg: PickerChoicesArg): void {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.body) {
    g.__piwiPickChoice = -1;
    return;
  }
  const Z = 2147483600;

  // An `__piwi` id, as every element Piwi adds to a page has: Pick on the image leaves Piwi's own out.
  const wrap = doc.createElement('div');
  wrap.id = '__piwi_picker_choices';
  wrap.style.cssText =
    `position:fixed;inset:0;z-index:${Z + 3};background:rgba(0,0,0,.45);` +
    'display:flex;align-items:center;justify-content:center;font:13px/1.5 system-ui,sans-serif;';
  const panel = doc.createElement('div');
  panel.style.cssText =
    'background:#111827;color:#f9fafb;border-radius:10px;padding:20px;' +
    'max-width:640px;width:90vw;max-height:70vh;overflow:auto;box-shadow:0 8px 40px rgba(0,0,0,.5);';
  // Syntax-highlight a locator expression, in the palette read on this panel's
  // dark background (self-contained — this whole function is serialized into
  // the page). Kept in sync by hand with `syntax-highlight.ts` and the copy in
  // overlay-element.ts: each must stay self-contained, since each is
  // serialized independently.
  const hlLocator = (expr: string): string => {
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const re =
      /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)(?=\s*:)|(true|false|null|\d+)|([{}(),.])/g;
    let html = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
      if (m.index > last) html += escHtml(expr.slice(last, m.index));
      const color = m[1] ? '#86efac' : m[2] ? '#d8b4fe' : m[3] ? '#93c5fd' : m[4] ? '#fcd34d' : '#9ca3af';
      html += `<span style="color:${color}">${escHtml(m[0])}</span>`;
      last = re.lastIndex;
    }
    if (last < expr.length) html += escHtml(expr.slice(last));
    return html;
  };
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:4px;';
  title.textContent = arg.failing ? 'Pick a replacement locator' : 'Pick a locator';
  const sub = doc.createElement('div');
  sub.style.cssText = 'color:#9ca3af;margin-bottom:12px;';
  if (arg.failing) {
    sub.innerHTML = `Replaces <code style="font-family:ui-monospace,Menlo,monospace">${hlLocator(arg.failing)}</code> — ranked by stability score.`;
  } else {
    sub.textContent = 'For the element you picked — ranked by stability score.';
  }
  panel.appendChild(title);
  panel.appendChild(sub);

  const cleanup = () => {
    doc.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (g.__piwiChoiceCleanup === cleanup) delete g.__piwiChoiceCleanup;
  };
  const done = (choice: number) => {
    g.__piwiPickChoice = choice;
    cleanup();
  };
  const onKey = (e: any) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done(-1);
  };

  arg.choices.forEach((c, i) => {
    const btn = doc.createElement('button');
    btn.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;' +
      'text-align:left;background:#0b1120;color:#f3f4f6;border:1px solid #374151;border-radius:6px;' +
      'padding:8px 12px;margin:0 0 8px;cursor:pointer;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;';
    const code = doc.createElement('span');
    code.innerHTML = hlLocator(c.locator);
    code.style.cssText = 'word-break:break-all;';
    const score = doc.createElement('span');
    score.textContent = String(c.score);
    score.style.cssText = 'color:#c4b5fd;flex-shrink:0;font-variant-numeric:tabular-nums;';
    btn.appendChild(code);
    btn.appendChild(score);
    btn.addEventListener('click', (e: any) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      done(i);
    });
    panel.appendChild(btn);
  });

  const skip = doc.createElement('button');
  skip.style.cssText =
    'background:none;border:none;color:#9ca3af;cursor:pointer;padding:6px 0 0;font:12px system-ui,sans-serif;';
  skip.textContent = 'Skip — keep the failure as-is (Esc)';
  skip.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done(-1);
  });
  panel.appendChild(skip);

  doc.addEventListener('keydown', onKey, true);
  g.__piwiChoiceCleanup = cleanup;
  wrap.appendChild(panel);
  doc.body.appendChild(wrap);
}
