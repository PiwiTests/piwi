import { createRequire } from 'node:module';
import * as path from 'node:path';
import { findOwnPackageJson } from '../support/reporter-version.js';

/**
 * Keeps the capture fixtures out of the test's own record. The fixtures wrap
 * locators and read the page; Playwright attributes an API call to the first
 * stack frame outside its own packages and reports every call as a step, so
 * without these hooks a wrapped action points at the wrapper and every probe
 * is listed among the test's steps. Both hooks are Playwright internals,
 * feature-detected: on a Playwright without them the fixtures still capture,
 * and their calls show as ordinary steps.
 */

type SetBoxedStackPrefixes = (prefixes: string[]) => void;

/** Where each Playwright layout exports `setBoxedStackPrefixes`, newest first. */
const BOXED_PREFIX_EXPORTS: Array<[moduleId: string, pick: (mod: unknown) => unknown]> = [
  [
    'playwright-core/lib/coreBundle',
    (mod) => (mod as { utils?: Record<string, unknown> } | null)?.utils?.setBoxedStackPrefixes,
  ],
  ['playwright-core/lib/utils', (mod) => (mod as Record<string, unknown> | null)?.setBoxedStackPrefixes],
];

/** The hook that sets Playwright's boxed prefixes, and the prefixes set through it. */
type Boxing = { set: SetBoxedStackPrefixes; prefixes: string[] };

/** Resolved on first use; null when this Playwright offers no hook. */
let boxing: Boxing | null | undefined;

/** Resolved on first use; null when `playwright` cannot be found from here. */
let resolvedPlaywrightPackageJson: string | null | undefined;

/**
 * The `package.json` of the `playwright` package the test runner uses, resolved
 * through @playwright/test → playwright, the same path Playwright's own
 * `require('playwright-core/…')` takes, so a module loaded from there is the
 * instance the runner holds. Null when the layout is not one this can follow.
 */
export function resolvePlaywrightPackageJson(): string | null {
  if (resolvedPlaywrightPackageJson !== undefined) return resolvedPlaywrightPackageJson;
  try {
    const testPackageJson = createRequire(__filename).resolve('@playwright/test/package.json');
    resolvedPlaywrightPackageJson = createRequire(testPackageJson).resolve('playwright/package.json');
  } catch {
    resolvedPlaywrightPackageJson = null;
  }
  return resolvedPlaywrightPackageJson;
}

/** Find the hook, with Playwright's own package and this package's `dist/` as the first prefixes. */
function resolveBoxing(): Boxing | null {
  try {
    const root = findOwnPackageJson(__dirname)?.root;
    if (!root) return null;
    const playwrightPackageJson = resolvePlaywrightPackageJson();
    if (!playwrightPackageJson) return null;
    const requireFromPlaywright = createRequire(playwrightPackageJson);
    for (const [moduleId, pick] of BOXED_PREFIX_EXPORTS) {
      let set: unknown;
      try {
        set = pick(requireFromPlaywright(moduleId));
      } catch {
        continue;
      }
      if (typeof set !== 'function') continue;
      return {
        set: set as SetBoxedStackPrefixes,
        prefixes: [path.dirname(playwrightPackageJson), path.join(root, 'dist') + path.sep],
      };
    }
  } catch {
    // An install layout the lookup does not know: keep Playwright's defaults.
  }
  return null;
}

/**
 * Register this package's `dist/` directory as a boxed stack prefix — the list
 * Playwright filters its own frames with — so a wrapped action's step location
 * and error stack name the test's line instead of the wrapper. `extraPrefixes`
 * adds more: a fixtures file of your own that wraps locators the same way.
 * Playwright's own package stays in the list. A missing hook or an unexpected
 * layout leaves Playwright's defaults untouched.
 */
export function boxCaptureFrames(extraPrefixes: readonly string[] = []): void {
  const first = boxing === undefined;
  if (first) boxing = resolveBoxing();
  if (!boxing) return;
  const added = extraPrefixes.filter((prefix) => !boxing!.prefixes.includes(prefix));
  if (!first && added.length === 0) return;
  boxing.prefixes.push(...added);
  try {
    boxing.set([...boxing.prefixes]);
  } catch {
    // The hook refused the list: keep Playwright's defaults.
  }
}

/**
 * Call a Playwright method on its own receiver. Playwright names an API call
 * after the method frame the call enters, so the call keeps its real name
 * (`locator.fill: Timeout …`); a call through `Function.prototype.apply` is
 * named `apply`.
 */
export function callMethod(target: object, prop: string | symbol, args: unknown[]): unknown {
  return (target as Record<string | symbol, (...a: unknown[]) => unknown>)[prop]!(...args);
}

type ApiCallOwner = {
  _wrapApiCall?: (run: () => Promise<unknown>, options: { internal: boolean; title?: string }) => Promise<unknown>;
};

/**
 * Run a page read as an internal Playwright call: every API call made inside
 * `run` is kept out of the test's steps and the trace. `owner` is the page (or
 * any Playwright channel object) the reads go through; without the hook the
 * read simply runs.
 */
export function internalCall<T>(owner: unknown, run: () => Promise<T>): Promise<T> {
  const wrap = (owner as ApiCallOwner | null | undefined)?._wrapApiCall;
  if (typeof wrap !== 'function') return run();
  return wrap.call(owner, run, { internal: true, title: 'Piwi capture' }) as Promise<T>;
}
