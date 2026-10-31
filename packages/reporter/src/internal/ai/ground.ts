/**
 * Ground a model-chosen element on the live page. The model names an element by
 * role + name and copies its `[ref=…]` marker from the AI-mode ARIA snapshot;
 * the ref addresses the exact element it read (`page.getByRef`, Playwright 1.64+,
 * or the `aria-ref=` selector it wraps). The committed locator is the role + name
 * one when it matches that element alone. When it matches that element among
 * others, or the element has no name, the committed locator is Playwright's own
 * `normalize()` of the ref, when that is a chain of semantic builder calls
 * (`getByRole('dialog', { name: 'Edit' }).getByRole('button', { name: 'Save' })`)
 * matching that element alone. Otherwise, and when the role + name does not match
 * the referenced element at all, the role + name locator stands as compiled.
 */
import type { Locator, Page } from '@playwright/test';
import type { ElementFingerprint } from '@piwitests/core';
import { tryParseLocatorChain, type LocatorArg as ChainArg, type LocatorCall } from '@piwitests/core/locator-chain';
import { locatorOfRef } from '../capture/aria-ref.js';
import { LOCATOR_METHODS } from '../capture/locator-healing.js';
import type { LocatorArg, StructuredLocator } from './artifact.js';
import { compileFromCandidate, type CompiledLocator } from './compile.js';
import { buildLocator } from './interpreter.js';
import { maskValues, type ParamValues } from './params.js';

/** The slice of a resolved element grounding reads. */
export interface GroundableElement {
  role: string;
  name?: string;
  level?: number;
  ref?: string;
}

/** The builders a grounded chain may use: every allowlisted one but the CSS/XPath `locator()`. */
const GROUNDED_METHODS = new Set(LOCATOR_METHODS.filter((method) => method !== 'locator'));

/** The element an aria ref names, or null when it names no single element on the page. */
export async function refLocator(page: Page, ref: string): Promise<Locator | null> {
  if (!/^[a-z0-9]+$/i.test(ref)) return null;
  try {
    const target = locatorOfRef(page, ref);
    return (await target.count()) === 1 ? target : null;
  } catch {
    return null;
  }
}

/** Whether `candidate` matches exactly one element, the one `target` names. */
async function matchesOnly(candidate: Locator, target: Locator): Promise<boolean> {
  try {
    return (await candidate.count()) === 1 && (await candidate.and(target).count()) === 1;
  } catch {
    return false;
  }
}

/** Whether `candidate` matches, among others or alone, the element `target` names. */
async function includes(candidate: Locator, target: Locator): Promise<boolean> {
  try {
    return (await candidate.and(target).count()) === 1;
  } catch {
    return false;
  }
}

/**
 * A parsed argument as artifact data, param values masked unless `mask` is
 * false; undefined for a regex or a nested locator.
 */
function plainArg(arg: ChainArg, params: ParamValues, mask = true): LocatorArg | undefined {
  switch (arg.type) {
    case 'string':
      return mask ? maskValues(arg.value, params) : arg.value;
    case 'number':
    case 'boolean':
      return arg.value;
    case 'object': {
      const out: Record<string, LocatorArg> = {};
      for (const [key, value] of arg.entries) {
        const plain = plainArg(value, params, mask);
        if (plain === undefined) return undefined;
        out[key] = plain;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * A parsed locator chain as a structured locator, or null when a call is not
 * a semantic builder (`first()`, `nth()`, `filter()`, a CSS `locator()`) or
 * carries an argument the artifact cannot hold. A test id is kept verbatim: it
 * is an identifier, not text a param value shows up in.
 */
export function chainToStructured(calls: LocatorCall[], params: ParamValues = {}): StructuredLocator | null {
  const links: StructuredLocator[] = [];
  for (const call of calls) {
    if (!GROUNDED_METHODS.has(call.method)) return null;
    const args: LocatorArg[] = [];
    for (const arg of call.args) {
      const plain = plainArg(arg, params, call.method !== 'getByTestId');
      if (plain === undefined) return null;
      args.push(plain);
    }
    links.push({ method: call.method, args });
  }
  const [head, ...chain] = links;
  if (!head) return null;
  return chain.length > 0 ? { ...head, chain } : head;
}

/** Playwright's normalized locator for `target`, as a structured locator, or null. */
async function normalizedLocator(target: Locator, params: ParamValues): Promise<StructuredLocator | null> {
  if (typeof target.normalize !== 'function') return null;
  try {
    const chain = tryParseLocatorChain(String(await target.normalize()));
    return chain ? chainToStructured(chain.calls, params) : null;
  } catch {
    return null;
  }
}

/**
 * Compile a model-chosen element into a committed locator, grounded on the
 * element its ref names (see the module comment). Returns null when neither the
 * role + name nor the ref yields a locator.
 */
export async function groundElement(
  page: Page,
  element: GroundableElement,
  params: ParamValues,
): Promise<CompiledLocator | null> {
  const compiled = compileFromCandidate({
    role: element.role,
    name: element.name ?? null,
    level: element.level ?? null,
  });
  const target = element.ref ? await refLocator(page, element.ref) : null;
  if (!target) return compiled;
  if (compiled) {
    const byName = buildLocator(page, compiled.locator, params);
    if (await matchesOnly(byName, target)) return compiled;
    if (!(await includes(byName, target))) return compiled;
  }

  const normalized = await normalizedLocator(target, params);
  if (!normalized || !(await matchesOnly(buildLocator(page, normalized, params), target))) return compiled;
  const fingerprint: ElementFingerprint = compiled?.fingerprint ?? { role: element.role, name: element.name ?? null };
  if (!compiled && element.level != null) fingerprint.level = element.level;
  return { locator: normalized, fingerprint, score: compiled?.score ?? 0 };
}
