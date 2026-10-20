import { describe, test, expect } from 'vitest';
import { BUG_PHRASES } from '../src/bug-phrases';
import {
  describeExpectation,
  describeExpectationInParts,
  describeStepInParts,
  describeStepInWords,
  type StepPart,
} from '../src/bug-report';
import { ASSERTION_MATCHERS, type RecordedStep, type RecordedTarget, type StepAction } from '../src/recording';

const english = BUG_PHRASES.en!;
const french = BUG_PHRASES.fr!;
const german = BUG_PHRASES.de!;

function target(overrides: Partial<RecordedTarget>): RecordedTarget {
  return { tagName: 'div', role: null, accessibleName: null, testId: null, text: null, alternatives: [], ...overrides };
}

function step(action: StepAction, overrides: Partial<RecordedStep> = {}): RecordedStep {
  return {
    action,
    target: null,
    value: null,
    redacted: false,
    pageUrl: 'https://shop.test/',
    timestamp: 1,
    ...overrides,
  };
}

const coupon = target({ tagName: 'input', role: 'textbox', accessibleName: 'Coupon' });
const apply = target({
  tagName: 'button',
  role: 'button',
  accessibleName: 'Apply',
  alternatives: [{ locator: `getByRole('button', { name: 'Apply' })`, method: 'getByRole', score: 90 }],
});

/** The parts other than the phrasebook's words, as `kind:text`. */
function marked(parts: StepPart[]): string[] {
  return parts.filter((part) => part.kind !== 'text').map((part) => `${part.kind}:${part.text}`);
}

/** The parts joined back into the sentence, code in its Markdown marks again. */
function joined(parts: StepPart[]): string {
  return parts
    .map((part) =>
      part.kind === 'url' || part.kind === 'locator' || part.kind === 'code' ? `\`${part.text}\`` : part.text,
    )
    .join('');
}

/** One step of each kind, and an assertion with each matcher. */
const STEPS: RecordedStep[] = [
  step('goto', { value: 'https://shop.test/cart?x=1' }),
  step('click', { target: apply }),
  step('dblclick', { target: target({ testId: 'cart-total' }) }),
  step('hover', { target: target({ tagName: 'p', text: 'Free shipping' }) }),
  step('fill', { target: coupon, value: 'SPRING10' }),
  step('fill', { target: coupon, value: 'secret', redacted: true }),
  step('selectOption', { target: target({ role: 'combobox', accessibleName: 'Country' }), value: 'France' }),
  step('check', { target: target({ role: 'checkbox', accessibleName: 'Gift' }) }),
  step('uncheck', {
    target: target({ alternatives: [{ locator: `locator('#gift')`, method: 'locator', score: 10 }] }),
  }),
  step('press', { value: 'ControlOrMeta+a' }),
  step('press', { target: coupon, value: 'Enter' }),
  step('setInputFiles', { target: target({ role: 'button', accessibleName: 'Upload' }), value: 'a.png\nb.pdf' }),
  step('dragTo', { target: apply, dropTarget: target({ role: 'region', accessibleName: 'Drop' }) }),
  step('manual', { manual: { description: 'Scan the QR code', location: null, call: null } }),
  ...ASSERTION_MATCHERS.map((matcher) =>
    step('assert', {
      target: apply,
      assertion: {
        matcher,
        expected: matcher === 'toHaveCount' ? '3' : matcher === 'toHaveURL' ? '/thanks' : 'Total: 42',
        actual: null,
        negated: false,
        note: null,
      },
    }),
  ),
];

describe('describeStepInParts', () => {
  test('in every language, the parts joined are the sentence', () => {
    for (const phrases of Object.values(BUG_PHRASES)) {
      for (const s of STEPS)
        expect(joined(describeStepInParts(s, phrases)), phrases.language).toBe(describeStepInWords(s, phrases));
    }
  });

  test('in every language, an expectation’s parts joined are the expectation, in lower case where the language allows', () => {
    for (const phrases of Object.values(BUG_PHRASES)) {
      for (const s of STEPS.filter((each) => each.action === 'assert')) {
        expect(joined(describeExpectationInParts(s, phrases)), phrases.language).toBe(describeExpectation(s, phrases));
      }
    }
    const text = STEPS.find((each) => each.assertion?.matcher === 'toHaveText')!;
    expect(marked(describeExpectationInParts(text, english))).toEqual([
      `locator:getByRole('button', { name: 'Apply' })`,
      'value:"Total: 42"',
    ]);
  });

  test('tells the name of the field from the value typed, in the order each language puts them', () => {
    const fill = step('fill', { target: coupon, value: 'SPRING10' });
    expect(describeStepInParts(fill, english)).toEqual([
      { kind: 'text', text: 'Fill text field ' },
      { kind: 'name', text: '"Coupon"' },
      { kind: 'text', text: ' with ' },
      { kind: 'value', text: '"SPRING10"' },
    ]);
    expect(marked(describeStepInParts(fill, french))).toEqual(['value:« SPRING10 »', 'name:« Coupon »']);
  });

  test('marks the key pressed as the language writes it, never a letter of the words around it', () => {
    expect(describeStepInParts(step('press', { value: 'p' }), english)).toEqual([
      { kind: 'text', text: 'Press ' },
      { kind: 'key', text: 'P' },
    ]);
    expect(marked(describeStepInParts(step('press', { value: 'ControlOrMeta+a' }), german))).toEqual(['key:Strg+A']);
  });

  test('keeps an address inside a name in that name', () => {
    const drag = step('dragTo', {
      target: target({ tagName: 'a', role: 'link', accessibleName: 'https://a.test/x' }),
      dropTarget: target({ role: 'region', accessibleName: 'Drop' }),
    });
    expect(marked(describeStepInParts(drag, english))).toEqual(['name:"https://a.test/x"', 'name:"Drop"']);
  });

  test('gives addresses, locators and test ids as code, and a password as words', () => {
    expect(marked(describeStepInParts(STEPS[0]!, english))).toEqual(['url:https://shop.test/cart?x=1']);
    expect(marked(describeStepInParts(STEPS[2]!, english))).toEqual(['code:cart-total']);
    expect(marked(describeStepInParts(STEPS[8]!, english))).toEqual([`locator:locator('#gift')`]);
    expect(describeStepInParts(STEPS[5]!, english)).toEqual([
      { kind: 'text', text: 'Fill text field ' },
      { kind: 'name', text: '"Coupon"' },
      { kind: 'text', text: ' with a password (not recorded)' },
    ]);
    expect(marked(describeStepInParts(STEPS[11]!, english))).toEqual([
      'value:"a.png"',
      'value:"b.pdf"',
      'name:"Upload"',
    ]);
    expect(marked(describeStepInParts(STEPS[13]!, english))).toEqual(['words:Scan the QR code']);
  });

  test('keeps a page text as it is, where the sentence escapes it for Markdown', () => {
    const click = step('click', { target: target({ role: 'button', accessibleName: 'a <b>  icon' }) });
    expect(describeStepInWords(click, english)).toBe('Click button "a &lt;b>  icon"');
    expect(marked(describeStepInParts(click, english))).toEqual(['name:"a <b>  icon"']);
  });
});
