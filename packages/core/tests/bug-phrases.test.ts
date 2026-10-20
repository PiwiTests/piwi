import { describe, test, expect } from 'vitest';
import { BUG_PHRASES, bugPhrases, type BugPhrases } from '../src/bug-phrases';
import {
  BUG_REPORT_VERSION,
  describeExpectation,
  describeStepInWords,
  emptyBugEvidence,
  renderBugMarkdown,
  summarizeEvidence,
  type BugReport,
} from '../src/bug-report';
import {
  ASSERTION_MATCHERS,
  type AssertionMatcher,
  type RecordedStep,
  type RecordedTarget,
  type StepAction,
} from '../src/recording';

const NBSP = ' ';
const NNBSP = ' ';
const english = BUG_PHRASES.en!;
const french = BUG_PHRASES.fr!;

function target(overrides: Partial<RecordedTarget>): RecordedTarget {
  return { tagName: 'div', role: null, accessibleName: null, testId: null, text: null, alternatives: [], ...overrides };
}

function step(action: StepAction, overrides: Partial<RecordedStep> = {}): RecordedStep {
  return {
    action,
    target: null,
    value: null,
    redacted: false,
    pageUrl: 'https://shop.test/cart',
    timestamp: 1,
    ...overrides,
  };
}

function assertion(matcher: AssertionMatcher, negated = false, expected: string | null = null): Partial<RecordedStep> {
  return { assertion: { matcher, expected, actual: null, negated, note: null } };
}

const button = target({ tagName: 'button', role: 'button', accessibleName: 'Apply coupon' });
const coupon = target({ tagName: 'input', role: 'textbox', accessibleName: 'Coupon' });
const country = target({ tagName: 'select', role: 'combobox', accessibleName: 'Country' });
const agree = target({ tagName: 'input', role: 'checkbox', accessibleName: 'I agree' });
const total = target({ tagName: 'p', testId: 'cart-total', text: 'Total: 40' });
const row = target({ tagName: 'tr', role: 'row', accessibleName: 'Invoice 42' });
const logo = target({ tagName: 'img', role: 'img', accessibleName: 'Acme' });

/** Every action and every matcher, negated or not: each template of a phrasebook. */
function everyTemplate(): RecordedStep[] {
  return [
    step('goto', { value: 'https://shop.test/cart' }),
    step('click', { target: button }),
    step('fill', { target: coupon, value: 'SPRING10' }),
    step('fill', { target: target({ tagName: 'input', role: 'textbox', accessibleName: 'Password' }), redacted: true }),
    step('check', { target: agree }),
    step('uncheck', { target: agree }),
    step('selectOption', { target: country, value: 'France' }),
    step('press', { target: coupon, value: 'Enter' }),
    step('press', { value: 'Escape' }),
    step('assertVisible', { target: logo }),
    ...ASSERTION_MATCHERS.flatMap((matcher) =>
      [false, true].map((negated) =>
        step('assert', {
          target: matcher === 'toHaveURL' ? null : matcher === 'toBeHidden' ? logo : total,
          ...assertion(matcher, negated, matcher === 'toHaveURL' ? '/checkout' : 'Total: 42'),
        }),
      ),
    ),
    step('hover', { target: row }),
    step('dblclick', { target: row }),
    step('setInputFiles', { target: coupon, value: 'invoice.pdf' }),
    step('setInputFiles', { target: coupon, value: 'a.png\nb.png' }),
    step('setInputFiles', { target: coupon, value: '' }),
    step('dragTo', { target: row, dropTarget: button }),
    step('manual', { manual: { description: 'Accept the cookie banner', location: null, call: null } }),
  ];
}

function report(steps: RecordedStep[]): BugReport {
  return {
    v: BUG_REPORT_VERSION,
    steps: { v: 1, title: '', note: null, steps } as unknown as BugReport['steps'],
    evidence: {
      ...emptyBugEvidence(),
      console: [
        { level: 'error', source: 'console', message: 'Coupon failed', page: '/cart', time: Date.UTC(2026, 8, 27, 14) },
        { level: 'error', source: 'error', message: 'x is undefined', page: '/cart', time: Date.UTC(2026, 8, 27, 14) },
        { level: 'error', source: 'rejection', message: 'boom', page: '/cart', time: Date.UTC(2026, 8, 27, 14) },
        { level: 'warn', source: 'console', message: 'slow', page: '/cart', time: Date.UTC(2026, 8, 27, 14) },
      ],
      consoleDropped: 2,
      requests: [{ method: 'POST', url: '/api/coupons', status: 500, page: '/cart', time: Date.UTC(2026, 8, 27, 14) }],
      requestsDropped: 0,
      screenshots: [
        { file: 'screenshots/1-marked.png', step: 3, moment: 'marked', takenAt: 1 },
        { file: 'screenshots/2-finish.png', step: null, moment: 'finish', takenAt: 2 },
        { file: 'screenshots/3-manual.png', step: null, moment: 'manual', takenAt: 3 },
      ],
      outline: '- button "Apply coupon"',
    },
    context: {
      origin: 'https://shop.test',
      pageKey: '/cart',
      path: '/cart',
      browser: 'Chrome 141',
      userAgent: null,
      viewport: { width: 1280, height: 720 },
      time: Date.UTC(2026, 8, 27, 14, 5),
      extensionVersion: '0.40.0',
    },
  };
}

describe('the phrasebooks', () => {
  test.each(Object.entries(BUG_PHRASES))('%s names every role English names', (_code, phrases) => {
    const missing = Object.keys(english.roles).filter((role) => !phrases.roles[role]);
    expect(missing).toEqual([]);
  });

  test.each(Object.entries(BUG_PHRASES))(
    '%s writes every action and every matcher, negated or not',
    (_code, phrases) => {
      const words = everyTemplate().map((s) => describeStepInWords(s, phrases));
      for (const text of words) expect(text.trim(), text).not.toBe('');
      // Each template says something different.
      expect(new Set(words).size).toBe(words.length);
    },
  );

  test('a language is matched on its primary subtag, English otherwise', () => {
    expect(bugPhrases('fr-CA')).toBe(french);
    expect(bugPhrases('fr')).toBe(french);
    expect(bugPhrases('ja')).toBe(english);
    expect(bugPhrases(null)).toBe(english);
  });
});

describe('English', () => {
  test('writes a hover as a person does it by hand', () => {
    expect(describeStepInWords(step('hover', { target: row }))).toBe('Hover over table row "Invoice 42"');
    expect(describeStepInWords(step('dblclick', { target: row }))).toBe('Double-click table row "Invoice 42"');
    expect(describeStepInWords(step('setInputFiles', { target: coupon, value: 'C:\\fakepath\\a.png\nb.png' }))).toBe(
      'Choose the files "a.png", "b.png" in text field "Coupon"',
    );
    expect(describeStepInWords(step('setInputFiles', { target: coupon, value: '' }))).toBe(
      'Clear the files of text field "Coupon"',
    );
    expect(describeStepInWords(step('dragTo', { target: row, dropTarget: button }))).toBe(
      'Drag table row "Invoice 42" onto button "Apply coupon"',
    );
  });
});

describe('French', () => {
  const words = (s: RecordedStep, phrases: BugPhrases = french) => describeStepInWords(s, phrases);
  const q = (text: string) => `«${NNBSP}${text}${NNBSP}»`;

  test('writes the steps the French way, page texts kept as they are', () => {
    expect(words(step('goto', { value: '/cart' }))).toBe('Ouvrir `/cart`');
    expect(words(step('click', { target: button }))).toBe(`Cliquer sur le bouton ${q('Apply coupon')}`);
    expect(words(step('fill', { target: coupon, value: 'SPRING10' }))).toBe(
      `Saisir ${q('SPRING10')} dans le champ de texte ${q('Coupon')}`,
    );
    expect(words(step('selectOption', { target: country, value: 'France' }))).toBe(
      `Choisir ${q('France')} dans la liste déroulante ${q('Country')}`,
    );
    expect(words(step('check', { target: agree }))).toBe(`Cocher la case ${q('I agree')}`);
    expect(words(step('dblclick', { target: row }))).toBe(`Double-cliquer sur la ligne de tableau ${q('Invoice 42')}`);
    expect(words(step('setInputFiles', { target: coupon, value: 'facture.pdf' }))).toBe(
      `Choisir le fichier ${q('facture.pdf')} dans le champ de texte ${q('Coupon')}`,
    );
    expect(words(step('dragTo', { target: row, dropTarget: button }))).toBe(
      `Glisser la ligne de tableau ${q('Invoice 42')} sur le bouton ${q('Apply coupon')}`,
    );
    expect(words(step('hover', { target: row }))).toBe(`Survoler la ligne de tableau ${q('Invoice 42')}`);
    expect(words(step('fill', { target: coupon, redacted: true }))).toBe(
      `Saisir un mot de passe (non enregistré) dans le champ de texte ${q('Coupon')}`,
    );
  });

  test('states what should happen, the article and the adjective agreeing with the noun', () => {
    expect(words(step('assert', { target: total, ...assertion('toHaveText', false, 'Total: 42') }))).toBe(
      `L’élément avec le test id \`cart-total\` devrait afficher ${q('Total: 42')}`,
    );
    expect(describeExpectation(step('assert', { target: logo, ...assertion('toBeHidden') }), french)).toBe(
      `l’image ${q('Acme')} devrait être masquée`,
    );
    expect(describeExpectation(step('assert', { target: button, ...assertion('toBeDisabled', true) }), french)).toBe(
      `le bouton ${q('Apply coupon')} ne devrait pas être désactivé`,
    );
    expect(describeExpectation(step('assert', assertion('toHaveURL', false, '/checkout')), french)).toBe(
      'la page devrait être `/checkout`',
    );
  });

  test('counts the evidence with French plurals: 0 and 1 in the singular', () => {
    const evidence = report([]).evidence;
    expect(summarizeEvidence(evidence, french)).toBe(
      '3 captures d’écran · 3 erreurs de console · 1 avertissement de console · 1 requête en échec · plan de la page',
    );
    expect(summarizeEvidence(emptyBugEvidence(), french)).toBe('aucune capture d’écran');
  });

  test('writes a whole report in French, with no English template left', () => {
    const markdown = renderBugMarkdown(report(everyTemplate()), french);
    expect(markdown).toContain('# Bug sur /cart');
    expect(markdown).toContain('## Étapes pour reproduire');
    expect(markdown).toContain(`## Attendu et constaté`);
    expect(markdown).toContain(
      `- Étape 11${NBSP}: l’élément avec le test id \`cart-total\` devrait afficher ${q('Total: 42')}.`,
    );
    expect(markdown).toContain('**Page** `/cart` sur https://shop.test · Chrome 141 · 1280×720 · 2026-09-27 14:05 UTC');
    expect(markdown).toContain('### Console (4 sur 6)');
    expect(markdown).toContain(`- erreur non interceptée sur \`/cart\` à 14:00:00${NBSP}: \`x is undefined\``);
    expect(markdown).toContain('- `POST /api/coupons` → 500, sur `/cart` à 14:00:00');
    expect(markdown).toContain('- `screenshots/1-marked.png`, après l’étape 4');
    expect(markdown).toContain('### Plan de la page');
    for (const english of [' should ', 'Click ', 'Fill ', 'Step ', 'Evidence', 'Screenshots', ' on `', ' at ']) {
      expect(markdown, english).not.toContain(english);
    }
    // Our colons take a no-break space; page texts and code keep theirs.
    const ours = markdown
      .replace(/«[^»]*»/g, '«»')
      .replace(/`[^`\n]*`/g, '``')
      .replace(/```[\s\S]*?```/g, '');
    for (const colon of ours.matchAll(/(.):(?=\s)/g))
      expect(colon[1], ours.slice(colon.index - 20, colon.index + 2)).toBe(NBSP);
  });

  test('the English report is the one every other language is compared with', () => {
    const markdown = renderBugMarkdown(report(everyTemplate()));
    expect(markdown).toContain('# Bug on /cart');
    expect(markdown).toContain('- Step 11: the element with test id `cart-total` should read "Total: 42".');
    expect(markdown).toContain('### Console (4 of 6)');
  });
});
