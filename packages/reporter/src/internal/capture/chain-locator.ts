import type { Frame, Locator, Page } from '@playwright/test';
import { tryParseLocatorChain, type LocatorArg, type LocatorChain } from '@piwitests/core/locator-chain';
import { callMethod } from './quiet-capture.js';

/**
 * A locator chain's source (`getByRole('form').getByLabel('Country')`, as `@piwitests/core/locator-chain` reads it)
 * built against a page or one of its frames, through the fixed list of calls that grammar takes, with literal arguments alone: a nested
 * chain (`filter({ has: getByRole('combobox') })`, `or(…)`) is built from the page too. Nothing in it is evaluated.
 * Building a locator makes no call to the browser.
 */

/** A chain's argument as Playwright takes it. */
function argValue(page: Page | Frame, arg: LocatorArg): unknown {
  switch (arg.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return arg.value;
    case 'regex':
      return new RegExp(arg.source, arg.flags);
    case 'object':
      return Object.fromEntries(arg.entries.map(([key, value]) => [key, argValue(page, value)]));
    case 'chain':
      return chainOn(page, arg.chain);
  }
}

/** A parsed chain on `page`. Throws when Playwright refuses one of its calls. */
export function chainOn(page: Page | Frame, chain: LocatorChain): Locator {
  let current: unknown = page;
  for (const call of chain.calls) {
    if (typeof (current as Record<string, unknown>)[call.method] !== 'function') {
      throw new Error(`${call.method}() cannot be called there.`);
    }
    current = callMethod(
      current as object,
      call.method,
      call.args.map((arg) => argValue(page, arg)),
    );
  }
  if (!current || typeof (current as Partial<Locator>).count !== 'function') {
    throw new Error('The chain does not end on a locator.');
  }
  return current as Locator;
}

/** A chain's source on `page`; null when it does not parse, or does not end on a locator. */
export function locatorOn(page: Page | Frame, source: string): Locator | null {
  const chain = tryParseLocatorChain(source);
  if (!chain?.calls.length) return null;
  try {
    return chainOn(page, chain);
  } catch {
    return null;
  }
}
