/**
 * The code made at a stopped test, rendered for its place: the check the person made with the check panel
 * (`assert`), a region's `toMatchAriaSnapshot` (`assert-region`) and a kept response as `page.route(…)` (`mock`),
 * each on a new line above the stopped statement (`placementBefore`), indented for it, on the page expression in scope
 * there (`this.page` in a page object), with the import lines it needs placed after the file's own. One generator for
 * each: `renderSpec` for the checks, the browser extension's `mockCode` for a mock (credentials hidden, no header
 * written, the body always inline). And the locator at a caret, as `piwi/locatorAtCaret` counts it. Pure: the text of
 * the file in, the code and its edits out.
 */
import { isPageExpression, renderSpec, safeLocator, type CodegenResult } from '@piwitests/core/codegen';
import { parseLeafLocatorCall } from '@piwitests/core/locator-chain';
import type { RecordedSession, RecordedStep } from '@piwitests/core/recording';
import type { KeptResponse } from '@piwitests/core/run-channel';
import { mockCode } from '../../../apps/extension/src/shared/mock-code.js';
import { locatorChainOnLine } from './analysis.js';
import type { FileEdit } from './protocol.js';
import { importBindings, importInsertion } from './recorder/imports.js';
import { declaredNamesAt, pageCandidates, placementBefore } from './recorder/page-candidates.js';
import { blockCode, blockImports } from './recorder/sessions.js';

/** What is written: the check's steps, a region and its snapshot, or the response to mock. */
export type StopCodeInput =
  | { action: 'assert'; session: RecordedSession }
  | { action: 'assert-region'; locator: string; snapshot: string }
  | { action: 'mock'; response: KeptResponse };

export interface StopCodeOptions {
  /** The canonical locators the project's tests already use, preferred among a check's alternatives. */
  preferLocators?: ReadonlySet<string>;
  /** The module `expect` is imported from when the file lacks it; what the file's text says by default. */
  expectModule?: string;
}

/** The code, where it goes, and the edits that write it. */
export interface RenderedStopCode {
  /** 0-based line of the stopped statement, which the block pushes down. */
  line: number;
  /** The block as written, indented. */
  code: string;
  /** The import lines, when the file lacks one, then the block. */
  edits: FileEdit[];
  warnings: string[];
}

/** The steps of a region's check: an `assert` step on the region's locator, with its snapshot. */
function regionSession(locator: string, snapshot: string): RecordedSession {
  const step: RecordedStep = {
    action: 'assert',
    target: {
      tagName: '',
      role: null,
      accessibleName: null,
      testId: null,
      text: null,
      alternatives: [{ locator, method: parseLeafLocatorCall(locator)?.method ?? 'locator', score: 100 }],
    },
    value: null,
    redacted: false,
    pageUrl: '',
    timestamp: 0,
    assertion: { matcher: 'toMatchAriaSnapshot', expected: snapshot, actual: null, negated: false, note: null },
  };
  return { steps: [step], startedAt: 0, startUrl: '' };
}

/** Where the code for a stop at the 0-based `line` goes, and the page expression in scope there; why none can. */
function stopPlace(
  text: string,
  line: number,
): { placement: ReturnType<typeof placementBefore>; page: string } | { refusal: string } {
  const placement = placementBefore(text, line);
  const at = pageCandidates(text, placement.line);
  if (at.context !== 'test' && at.context !== 'function') {
    return { refusal: 'The test is stopped outside a test or a function of this file: nothing can be written there.' };
  }
  return isPageExpression(at.default)
    ? { placement, page: at.default }
    : { refusal: `${at.default} is not an expression the code can run on.` };
}

/** Why no code can go above the 0-based `line` of a file whose text is `text`; null when some can. */
export function stopCodeRefusal(text: string, line: number): string | null {
  const place = stopPlace(text, line);
  return 'refusal' in place ? place.refusal : null;
}

/**
 * The code for a stop at the 0-based `line` of a file whose text is `text`, or why none can go there: a stop outside
 * a test or a function of the file, a region's locator Piwi cannot read, an empty check.
 */
export function renderStopCode(
  text: string,
  line: number,
  input: StopCodeInput,
  options: StopCodeOptions = {},
): RenderedStopCode | { refusal: string } {
  const place = stopPlace(text, line);
  if ('refusal' in place) return place;
  const { placement, page } = place;
  let body: string;
  let rendered: Pick<CodegenResult, 'code' | 'imports'> | null = null;
  const warnings: string[] = [];
  if (input.action === 'mock') {
    const { response } = input;
    const mock = mockCode(
      {
        method: response.method,
        url: response.url,
        status: response.status,
        mimeType: response.type,
        body: response.body,
      },
      { page, maxInlineBody: Number.POSITIVE_INFINITY },
    );
    body = mock.code;
    if (mock.hidden > 0) {
      warnings.push(
        mock.hidden === 1
          ? 'A value named like a credential is written as <hidden>.'
          : `${mock.hidden} values named like credentials are written as <hidden>.`,
      );
    }
  } else {
    if (input.action === 'assert-region' && !safeLocator(input.locator)) {
      return { refusal: `The region's locator, ${input.locator}, is not one Piwi can write.` };
    }
    const session = input.action === 'assert' ? input.session : regionSession(input.locator, input.snapshot);
    if (!session.steps.some((step) => step.action === 'assert')) return { refusal: 'Nothing was checked.' };
    const result = renderSpec(session, {
      format: 'body',
      continuePage: true,
      bodyImports: 'none',
      declaredNames: declaredNamesAt(text, placement.line),
      locators: 'stable',
      page,
      ...(options.preferLocators ? { preferLocators: options.preferLocators } : {}),
    });
    rendered = result;
    body = blockCode(result.code, 'steps');
    warnings.push(...result.warnings.map((w) => w.message));
  }
  const code = body
    .split('\n')
    .map((part) => (part ? placement.indent + part : part))
    .join('\n');
  const bindings = importBindings(text);
  const importEdit = rendered
    ? importInsertion(text, blockImports(text, rendered, { expectModule: options.expectModule, bindings }), bindings)
    : null;
  const at0 = { line: placement.line, character: 0 };
  return {
    line: placement.line,
    code,
    edits: [...(importEdit ? [importEdit] : []), { range: { start: at0, end: at0 }, newText: `${code}\n` }],
    warnings,
  };
}

/** A call that locates on a line, whether or not its arguments are literals. */
const LOCATING_CALL =
  /(?<![\w$])(?:getBy(?:Role|TestId|Text|Label|Placeholder|AltText|Title)|locator|frameLocator)\s*\(/;

/** The member chain a locator chain starts from, right before it on its line: `page.`, `this.page.`, `adminPage.`. */
const RECEIVER = /((?:this|[A-Za-z_$][\w$]*)(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.\s*$/;

/**
 * The locator chain on the 0-based `line` of a file, the one `piwi/applyPick` replaces, and the page expression it
 * starts from, which must be one in scope there (`pageCandidates`); why not otherwise.
 */
export function caretLocator(text: string, line: number): { locator: string; page: string } | { refusal: string } {
  const lineText = text.split(/\r\n|\r|\n/)[line] ?? '';
  const held = locatorChainOnLine(lineText);
  if (!held) {
    return {
      refusal: LOCATING_CALL.test(lineText)
        ? 'The locator on this line is not one Piwi reads: its arguments must be literals.'
        : 'No locator on this line.',
    };
  }
  const receiver = RECEIVER.exec(lineText.slice(0, held.start))?.[1]?.replace(/[\s?]/g, '') ?? null;
  if (!receiver) return { refusal: 'The locator on this line does not start from a page: Piwi counts one that does.' };
  const pages = pageCandidates(text, line).candidates.map((c) => c.expression);
  if (!pages.includes(receiver)) {
    return { refusal: `${receiver} is not a page in scope on this line: Piwi counts a locator that starts from one.` };
  }
  return { locator: held.locator, page: receiver };
}
