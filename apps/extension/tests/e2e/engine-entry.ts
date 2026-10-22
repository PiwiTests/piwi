import { parseLocatorChain } from '@piwitests/core/locator-chain';
import { createLocatorEngine } from '../../src/content/locator-engine.js';
import { DomModel } from '../../src/content/engine-aria.js';
import { buildOutline } from '../../src/content/bug-outline.js';
import { checkLocators, createPageEngine, rankElement } from '../../src/content/verified-locators.js';

interface EngineResult {
  ids?: Array<string | null>;
  error?: string;
}

/**
 * Test-only entry: evaluates many locator expressions with one engine (one
 * evaluation pass, shared caches and prefixes, as the coverage overlay runs
 * it) and answers each with the `data-eid` of the elements found; `strict`
 * resolves frame owners as an action does.
 */
(globalThis as unknown as Record<string, unknown>).__piwiEngineQueryAll = (
  expressions: string[],
  testIdAttributes?: string[],
  strict?: boolean,
): EngineResult[] => {
  const engine = createLocatorEngine(document, { testIdAttributes, strict });
  return expressions.map((expression) => {
    try {
      return { ids: engine.queryAll(parseLocatorChain(expression)).map((element) => element.getAttribute('data-eid')) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
};

/** Test-only: the bug report's outline of the element matching `selector`, or of the body. */
(globalThis as unknown as Record<string, unknown>).__piwiBuildOutline = (
  selector?: string,
  maxLines?: number,
): string => buildOutline(selector ? document.querySelector(selector)! : document.body, { maxLines });

/** Test-only: the accessible name Playwright computes for an element, as the tools name it. */
(globalThis as unknown as Record<string, unknown>).__piwiAccessibleName = (element: Element): string | null =>
  new DomModel().normalizedAccessibleName(element, false) || null;

/**
 * Test-only: the role the ranking gives the element matching `selector`, and
 * its top locator checked against the page, counted with an engine of the page
 * as a scan does, or by the probe as a single pick does.
 */
(globalThis as unknown as Record<string, unknown>).__piwiRankTop = (
  selector: string,
  withEngine: boolean,
): { role: string | null; locator: string | null } => {
  const element = document.querySelector(selector)!;
  const engine = withEngine ? createPageEngine(document) : undefined;
  const { role, ranked } = rankElement(element, { engine });
  const [top] = checkLocators(element, ranked, { engine, limit: 1 });
  return { role, locator: top?.locator ?? null };
};

/**
 * Test-only: `checkLocators` on the given candidates for the element matching `selector`, with an engine reading
 * `testIdAttributes`; `narrowedBy` is there for a narrowed locator only.
 */
(globalThis as unknown as Record<string, unknown>).__piwiCheckLocators = (
  selector: string,
  locators: string[],
  testIdAttributes?: string[],
): Array<{ locator: string; verdict: string; narrowedBy?: string }> => {
  const element = document.querySelector(selector)!;
  const ranked = locators.map((locator, i) => ({ locator, method: 'getByRole', args: {}, score: 90 - i }));
  return checkLocators(element, ranked, { engine: createPageEngine(document, testIdAttributes) }).map(
    ({ locator, verdict, narrowedBy }) => ({ locator, verdict, ...(narrowedBy ? { narrowedBy } : {}) }),
  );
};
