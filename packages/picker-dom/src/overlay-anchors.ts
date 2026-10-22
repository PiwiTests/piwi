/** An ancestor the human blessed as an anchor, with its in-page uniqueness counts. */
export interface PickedAnchorInfo {
  tag: string;
  /** Hops from the picked element (1 = direct parent). */
  depth: number;
  testId: string | null;
  id: string | null;
  ariaLabel: string | null;
  /** Resolved anchor role (explicit attribute or tag-implied). */
  role: string | null;
  /** Document-wide match count for the anchor's own test id. */
  testIdCount?: number;
  /** Document-wide match count for the anchor's own id. */
  idCount?: number;
  /** Document-wide count of same-role elements carrying the same aria-label. */
  labeledRoleCount?: number;
  /** Document-wide count of elements resolving to the anchor's role. */
  roleCount?: number;
  /** Leaf matches (picked element's identity) within this anchor's subtree. */
  scopedLeafCount?: number;
}

/** The picked element's identity used for anchor-scoped candidates. */
export interface PickedLeafInfo {
  role: string | null;
  level: number | null;
}

/**
 * The anchors step's texts a host may give in its own language; each one left
 * out is the English default. `{count}` in a text stands for a number.
 */
export interface AnchorPickerStrings {
  title?: string;
  hint?: string;
  /** The footer with no parent selected. */
  noneSelected?: string;
  matchesOne?: string;
  /** `{count}` elements, any count but one. */
  matchesMany?: string;
  countUnavailable?: string;
  /** Under a parent: what it contains. */
  containsOne?: string;
  containsMany?: string;
  /** Under a parent that cannot be selected. */
  needsTestId?: string;
  /** A parent with no test id, id or role, in place of its hook. */
  noHook?: string;
  use?: string;
  skip?: string;
}

/** Arguments for `showAnchorPicker` — the role maps mirror the single source of truth in `@piwitests/core`. */
export interface AnchorPickerArg {
  tagRoles: Record<string, string>;
  inputRoles: Record<string, string>;
  roleSources: string;
  leafRole: string;
  leafLevel: number | null;
  leafTestId: string | null;
  /**
   * The attribute `getByTestId` reads in the project (Playwright's
   * `testIdAttribute`), which `leafTestId` and each parent's test id are read
   * from; `data-testid` when null or absent.
   */
  testIdAttribute?: string | null;
  /** The panel's texts, for a host that shows another language than English. */
  strings?: AnchorPickerStrings;
}

/**
 * Runs inside the browser via `evaluate()` — the anchor step: lists the picked
 * element's ancestors so the human can bless one or more stable parents to
 * scope the locator to. Each row shows the ancestor's strongest hook and how
 * many leaf matches it contains; the footer shows a live "matches N" count for
 * the combined selection, recomputed against the real page on every toggle
 * (exactly 1 = green). Hovering a row outlines that ancestor in the page and
 * names it in a chip pinned to it. Resolves through `__piwiAnchorState` ('done' | 'skipped'); selected anchors
 * land in `__piwiPickAnchors` (+ `__piwiPickChainCount`). While the step
 * shows, `__piwiAnchorCleanup` holds its teardown (see `removeAnchorPicker`).
 * Role resolution reuses the maps passed in `arg` (single source of truth in
 * `@piwitests/core`). The ancestors and every count reach through open shadow
 * roots, as Playwright's locators do. The panel is in English unless
 * `arg.strings` gives its texts. Must stay fully self-contained.
 */
export function showAnchorPicker(arg: AnchorPickerArg): void {
  const g = globalThis as any;
  const doc = g.document;
  const el = g.__piwiPickedElement;
  if (!doc || !doc.body || !el) {
    g.__piwiAnchorState = 'skipped';
    return;
  }
  const Z = 2147483600;
  const { tagRoles, inputRoles, roleSources, leafRole, leafLevel, leafTestId } = arg;
  const testIdAttr = arg.testIdAttribute || 'data-testid';
  const words = {
    title: 'Scope to stable parents (optional)',
    hint: 'Pick one or more parents to anchor the locator to. Hover a row to see the parent.',
    noneSelected: 'No parents selected — standard alternatives only.',
    matchesOne: '✓ Selection matches exactly 1 element',
    matchesMany: '✗ Selection matches {count} elements',
    countUnavailable: 'Match count unavailable',
    containsOne: 'contains exactly 1 matching element',
    containsMany: 'contains {count} matching elements',
    needsTestId: `add a ${testIdAttr} to make this usable`,
    noHook: 'no stable hook',
    use: 'Use selected parents',
    skip: 'Skip (Esc)',
  };
  for (const key of Object.keys(words) as Array<keyof typeof words>) {
    const given = arg.strings?.[key];
    if (typeof given === 'string' && given) words[key] = given;
  }
  const counted = (template: string, n: number | string) => template.replace('{count}', String(n));

  const roleOf = (n: any): string | null => {
    const explicit = n.getAttribute && n.getAttribute('role');
    if (explicit) return explicit;
    const tag = (n.tagName || '').toLowerCase();
    if (tag === 'input') return inputRoles[(n.getAttribute('type') || 'text').toLowerCase()] ?? 'textbox';
    if (tag === 'select') return n.getAttribute('multiple') != null ? 'listbox' : 'combobox';
    if (tag === 'a') return n.getAttribute('href') != null ? 'link' : null;
    return tagRoles[tag] ?? null;
  };
  const levelOf = (n: any): number | null => {
    const m = /^h([1-6])$/.exec((n.tagName || '').toLowerCase());
    if (m) return Number(m[1]);
    const al = n.getAttribute && n.getAttribute('aria-level');
    return al && /^\d+$/.test(al) ? Number(al) : null;
  };

  // An element's parent, out through its shadow root's host at the top of an
  // open shadow root, as Playwright's locators pierce them.
  const parentOf = (n: any): any => {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode ? n.getRootNode() : null;
    return root && root !== doc && root.host ? root.host : null;
  };
  // The page's open shadow roots, nested ones included, found once: every
  // count below searches them as well as the light DOM, as Playwright does.
  const shadowRoots: any[] = [];
  const collectRoots = (root: any) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const sr = all[i].shadowRoot;
      if (sr) {
        shadowRoots.push(sr);
        collectRoots(sr);
      }
    }
  };
  try {
    collectRoots(doc);
  } catch {
    shadowRoots.length = 0;
  }
  // Whether `node` is `scope` or inside it, across shadow boundaries.
  const within = (node: any, scope: any): boolean => {
    if (scope === doc) return true;
    for (let n = node; n; n = parentOf(n)) if (n === scope) return true;
    return false;
  };
  // `scope.querySelectorAll(sel)` plus the matches in every open shadow root
  // under the scope, its own included.
  const queryAll = (scope: any, sel: string): any[] => {
    const found: any[] = Array.from(scope.querySelectorAll(sel));
    for (const sr of shadowRoots) if (within(sr.host, scope)) found.push(...Array.from(sr.querySelectorAll(sel)));
    return found;
  };

  // A role the maps cannot give the picked element itself (one only the
  // host's accessibility model computes, such as a paragraph's) cannot be
  // counted from them: its counts are unavailable rather than 0.
  const leafCountable = !!leafTestId || roleOf(el) === leafRole;

  // Leaf matches inside a scope: same test id when the element has one,
  // otherwise same resolved role (level-scoped for headings). -1 when unknown.
  const leafMatches = (scope: any): number => {
    try {
      if (leafTestId) return queryAll(scope, `[${testIdAttr}=${JSON.stringify(leafTestId)}]`).length;
      if (!leafCountable) return -1;
      const nodes = queryAll(scope, roleSources);
      if (nodes.length > 2000) return -1;
      let matched = 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (roleOf(n) !== leafRole) continue;
        if (leafLevel != null && levelOf(n) !== leafLevel) continue;
        matched++;
      }
      return matched;
    } catch {
      return -1;
    }
  };

  // Document-wide role nodes, computed once for anchor uniqueness counts.
  let roleNodes: any[] = [];
  try {
    const all = queryAll(doc, roleSources);
    if (all.length <= 4000) roleNodes = all;
  } catch {
    roleNodes = [];
  }
  const count = (sel: string): number | undefined => {
    try {
      return queryAll(doc, sel).length;
    } catch {
      return undefined;
    }
  };

  // Ancestor rows, nearest parent first, up to (not including) body.
  interface Row {
    node: any;
    info: any;
    hookLabel: string;
    selectable: boolean;
  }
  const rows: Row[] = [];
  let node = parentOf(el);
  let depth = 0;
  while (node && depth < 12) {
    depth++;
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const testId = node.getAttribute(testIdAttr);
    const id = node.getAttribute('id');
    const ariaLabel = node.getAttribute('aria-label');
    const role = roleOf(node);
    const info: any = { tag, depth, testId: testId || null, id: id || null, ariaLabel: ariaLabel || null, role };
    if (testId) info.testIdCount = count(`[${testIdAttr}=${JSON.stringify(testId)}]`);
    if (id) {
      try {
        info.idCount = count(`#${doc.defaultView.CSS.escape(id)}`);
      } catch {
        // Keep idCount undefined — the Node side treats it as non-unique.
      }
    }
    if (role) {
      let roleCount = 0;
      let labeledCount = 0;
      for (const n of roleNodes) {
        if (roleOf(n) !== role) continue;
        roleCount++;
        if (ariaLabel && n.getAttribute && n.getAttribute('aria-label') === ariaLabel) labeledCount++;
      }
      info.roleCount = roleCount;
      if (ariaLabel) info.labeledRoleCount = labeledCount;
    }
    info.scopedLeafCount = leafMatches(node);

    const hookLabel = testId
      ? `${testIdAttr}="${testId}"`
      : id
        ? `#${id}`
        : ariaLabel && role
          ? `${role} "${ariaLabel}"`
          : role
            ? `role ${role}`
            : words.noHook;
    rows.push({
      node,
      info,
      hookLabel,
      selectable: !!(testId || id || (role && (ariaLabel || info.roleCount === 1))),
    });
    node = parentOf(node);
  }

  if (rows.length === 0) {
    g.__piwiAnchorState = 'skipped';
    return;
  }

  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  // A light hairline outside each ring and a dark one outside that, so both
  // outlines keep their edge over white, black and busy backgrounds alike.
  const outline = doc.createElement('div');
  outline.style.cssText =
    `position:fixed;pointer-events:none;z-index:${Z};box-sizing:border-box;` +
    'border:2px solid #22c55e;background:rgba(34,197,94,.10);border-radius:4px;display:none;' +
    'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(5,46,22,.5);';
  // Names the ancestor the hovered row would scope to, pinned to that ancestor.
  const outlineLabel = doc.createElement('div');
  outlineLabel.style.cssText =
    `position:fixed;pointer-events:none;z-index:${Z + 1};display:none;box-sizing:border-box;` +
    'max-width:min(420px,90vw);background:#0b1120;color:#f9fafb;border:1px solid #22c55e;' +
    `border-radius:6px;padding:3px 7px;font:12px/1.45 ${MONO};white-space:nowrap;` +
    'overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 18px rgba(0,0,0,.5);';
  const pickedOutline = doc.createElement('div');
  const pr = el.getBoundingClientRect();
  pickedOutline.style.cssText =
    `position:fixed;pointer-events:none;z-index:${Z};box-sizing:border-box;` +
    'border:2px solid #a855f7;background:rgba(168,85,247,.14);border-radius:4px;' +
    'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(59,7,100,.55);' +
    `left:${pr.left}px;top:${pr.top}px;width:${pr.width}px;height:${pr.height}px;`;
  const panel = doc.createElement('div');
  panel.style.cssText =
    `position:fixed;top:12px;right:12px;z-index:${Z + 3};width:min(340px,calc(100vw - 56px));` +
    'max-height:82vh;overflow:auto;' +
    'background:#111827;color:#f9fafb;border-radius:10px;padding:16px;' +
    'font:12px/1.5 system-ui,sans-serif;box-shadow:0 8px 40px rgba(0,0,0,.5);';
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px;';
  title.textContent = words.title;
  const sub = doc.createElement('div');
  sub.style.cssText = 'color:#9ca3af;margin-bottom:10px;';
  sub.textContent = words.hint;
  panel.appendChild(title);
  panel.appendChild(sub);

  const selected = new Set<number>();
  const footer = doc.createElement('div');
  footer.style.cssText = 'margin:10px 0;font-weight:600;';

  // Segment priority mirrors the Node-side generator so the live count and the
  // emitted chain agree: testid > id > labeled role > bare role.
  const segMatches = (scope: any, info: any): any[] => {
    try {
      if (info.testId) return queryAll(scope, `[${testIdAttr}=${JSON.stringify(info.testId)}]`);
      if (info.id) return queryAll(scope, `#${doc.defaultView.CSS.escape(info.id)}`);
      const nodes = queryAll(scope, roleSources);
      if (nodes.length > 2000) return [];
      return nodes.filter(
        (n: any) =>
          roleOf(n) === info.role &&
          (!info.ariaLabel || (n.getAttribute && n.getAttribute('aria-label') === info.ariaLabel)),
      );
    } catch {
      return [];
    }
  };

  const chainCount = (): number => {
    const chosen = rows.filter((_, i) => selected.has(i)).sort((a, b) => b.info.depth - a.info.depth);
    if (chosen.length === 0) return -1;
    let scopes: any[] = [doc];
    for (const row of chosen) {
      const next: any[] = [];
      for (const s of scopes) next.push(...segMatches(s, row.info));
      scopes = next.slice(0, 200);
      if (scopes.length === 0) return 0;
    }
    let total = 0;
    for (const s of scopes) {
      const c = leafMatches(s);
      if (c < 0) return -1;
      total += c;
      if (total > 50) return total;
    }
    return total;
  };

  const refreshFooter = () => {
    if (selected.size === 0) {
      footer.textContent = words.noneSelected;
      footer.style.color = '#9ca3af';
      g.__piwiPickChainCount = undefined;
      return;
    }
    const c = chainCount();
    g.__piwiPickChainCount = c;
    if (c === 1) {
      footer.textContent = words.matchesOne;
      footer.style.color = '#4ade80';
    } else {
      footer.textContent = c < 0 ? words.countUnavailable : counted(words.matchesMany, c);
      footer.style.color = '#fbbf24';
    }
  };

  rows.forEach((row, i) => {
    const line = doc.createElement('label');
    line.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #374151;border-radius:6px;' +
      `margin-bottom:6px;cursor:${row.selectable ? 'pointer' : 'default'};opacity:${row.selectable ? '1' : '.45'};`;
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.disabled = !row.selectable;
    const text = doc.createElement('span');
    text.style.cssText = 'flex:1;min-width:0;';
    const code = doc.createElement('code');
    code.style.cssText = `display:block;font:12px ${MONO};color:#f3f4f6;word-break:break-all;`;
    code.textContent = `<${row.info.tag}> ${row.hookLabel}`;
    const hint = doc.createElement('span');
    hint.style.cssText = 'color:#9ca3af;';
    const inside = row.info.scopedLeafCount ?? -1;
    hint.textContent = row.selectable
      ? inside === 1
        ? words.containsOne
        : inside < 0
          ? words.countUnavailable
          : counted(words.containsMany, inside)
      : words.needsTestId;
    text.appendChild(code);
    text.appendChild(hint);
    line.appendChild(box);
    line.appendChild(text);
    line.addEventListener('mouseenter', () => {
      const r = row.node.getBoundingClientRect();
      outline.style.display = 'block';
      outline.style.left = r.left + 'px';
      outline.style.top = r.top + 'px';
      outline.style.width = r.width + 'px';
      outline.style.height = r.height + 'px';
      outlineLabel.textContent = `<${row.info.tag}> ${row.hookLabel}`;
      outlineLabel.style.display = 'block';
      const lr = outlineLabel.getBoundingClientRect();
      const vw = g.innerWidth || doc.documentElement.clientWidth || 0;
      const top = r.top - lr.height - 6 < 4 ? r.bottom + 6 : r.top - lr.height - 6;
      outlineLabel.style.left = Math.max(6, Math.min(r.left, vw - lr.width - 6)) + 'px';
      outlineLabel.style.top = top + 'px';
    });
    line.addEventListener('mouseleave', () => {
      outline.style.display = 'none';
      outlineLabel.style.display = 'none';
    });
    box.addEventListener('change', () => {
      if (box.checked) selected.add(i);
      else selected.delete(i);
      refreshFooter();
    });
    panel.appendChild(line);
  });

  panel.appendChild(footer);

  const cleanup = () => {
    doc.removeEventListener('keydown', onKey, true);
    panel.remove();
    outline.remove();
    outlineLabel.remove();
    pickedOutline.remove();
    if (g.__piwiAnchorCleanup === cleanup) delete g.__piwiAnchorCleanup;
  };
  const done = (state: 'done' | 'skipped') => {
    g.__piwiPickAnchors = state === 'done' ? rows.filter((_, i) => selected.has(i)).map((r) => r.info) : [];
    g.__piwiAnchorState = state;
    cleanup();
  };
  const onKey = (e: any) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    done('skipped');
  };

  const buttonRow = doc.createElement('div');
  buttonRow.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const useBtn = doc.createElement('button');
  useBtn.style.cssText =
    'flex:1;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:8px;cursor:pointer;font:600 12px system-ui;';
  useBtn.textContent = words.use;
  useBtn.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done(selected.size > 0 ? 'done' : 'skipped');
  });
  const skipBtn = doc.createElement('button');
  skipBtn.style.cssText =
    'background:none;border:1px solid #374151;color:#9ca3af;border-radius:6px;padding:8px 10px;cursor:pointer;font:12px system-ui;';
  skipBtn.textContent = words.skip;
  skipBtn.addEventListener('click', (e: any) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done('skipped');
  });
  buttonRow.appendChild(useBtn);
  buttonRow.appendChild(skipBtn);
  panel.appendChild(buttonRow);

  refreshFooter();
  g.__piwiAnchorCleanup = cleanup;
  doc.addEventListener('keydown', onKey, true);
  // A modal dialog the page opened sits in the top layer and makes the rest of
  // the page inert: the overlay goes at its end, unless the dialog lays out
  // \`position: fixed\` children in its own box (a transform, a filter,
  // containment…), and back to the body when it closes.
  const mountParent = (): any => {
    let modal: any = null;
    try {
      modal = doc.querySelector('dialog:modal');
    } catch {
      modal = null;
    }
    if (!modal) return doc.body;
    const s = g.getComputedStyle(modal);
    const holdsFixed =
      s.transform !== 'none' ||
      s.perspective !== 'none' ||
      s.filter !== 'none' ||
      /\b(paint|layout|strict|content)\b/.test(s.contain) ||
      /\b(transform|perspective|filter)\b/.test(s.willChange);
    return holdsFixed ? doc.body : modal;
  };
  const mount = (...nodes: any[]) => {
    const parent = mountParent();
    for (const node of nodes) parent.appendChild(node);
    if (parent !== doc.body) {
      parent.addEventListener(
        'close',
        () => {
          for (const node of nodes) if (node.parentNode === parent) doc.body.appendChild(node);
        },
        { once: true },
      );
    }
  };
  mount(pickedOutline, outline, outlineLabel, panel);
}

/**
 * Tears down the anchors step, if one is showing: its panel, outlines and key
 * listener. It leaves `__piwiAnchorState` unset: a caller still waiting on it
 * answers it, or stops waiting. Safe to call more than once.
 */
export function removeAnchorPicker(): void {
  const g = globalThis as any;
  const cleanup = g.__piwiAnchorCleanup;
  if (typeof cleanup === 'function') cleanup();
  delete g.__piwiAnchorCleanup;
}
