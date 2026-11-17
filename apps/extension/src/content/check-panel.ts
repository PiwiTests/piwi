import { highlightLocator } from '@piwitests/picker-dom';
import {
  VALUE_MATCHERS,
  type AssertionMatcher,
  type RecordedTarget,
  type StepAssertion,
} from '@piwitests/core/recording';
import { suggestAssertions } from './assertion-suggest.js';
import { DomModel } from './engine-aria.js';
import { isSensitiveField } from './sensitive-fields.js';
import {
  exclusive,
  input,
  openRecordDialog,
  outlineAround,
  pickElement,
  stateWord,
  takeBugScreenshot,
  type BugRecorderHooks,
} from './bug-panel.js';
import { HUD_HOST_ID, hideSurfaces } from './record-ui.js';
import { setBugEvidenceFields } from '../shared/bug-storage.js';
import { IDE_BUILD } from '../shared/ide-build.js';
import { t, tNodes, type MessageKey } from '../shared/i18n.js';
import { urlView } from '../shared/step-view.js';

/**
 * A recording's checks: an element's text, value, name or state, or the page's
 * address, added to the recording as an `assert` step that the test writes as
 * `await expect(…)`. Each dialog starts from what the page shows now. Keeping
 * it records a check that passes; changing it records something wrong, which
 * keeps what the page showed (`actual`) and makes the recording a bug report.
 * The IDE bundle records checks only: what the page showed is never kept there.
 */

/** What `record-panel.ts` lends this module to record a check. */
type CheckHooks = BugRecorderHooks;

interface CheckChoice {
  matcher: AssertionMatcher;
  label: MessageKey;
  /** What the page shows now: the value a value matcher starts from, or the state word of the element now. */
  shown: string | null;
  /** A state the element is not in: choosing it says the page is wrong. */
  wrong: boolean;
}

/** A value longer than this is not offered first: a whole block's text makes a brittle check. */
const SHORT_TEXT = 80;

/**
 * What can be checked about an element, as it is now: its value (never for a
 * field that holds a secret), its text, its accessible name, the states it is
 * in, and, outside the IDE bundle, the states it should be in instead. The
 * first choice is the most telling: a field's value, else a short text, else
 * that it is visible.
 */
function checkChoices(element: Element): CheckChoice[] {
  const suggestion = suggestAssertions(element);
  const values: CheckChoice[] = [];
  if (!isSensitiveField(element)) {
    for (const c of suggestion.candidates) {
      if (c.detail == null) continue;
      if (c.method === 'toHaveValue')
        values.push({ matcher: c.method, label: 'record_checkValue', shown: c.detail, wrong: false });
      if (c.method === 'toHaveText')
        values.push({ matcher: c.method, label: 'record_checkText', shown: c.detail, wrong: false });
      if (c.method === 'toHaveAccessibleName')
        values.push({ matcher: c.method, label: 'record_checkName', shown: c.detail, wrong: false });
    }
  }
  const model = new DomModel();
  const visible = model.isVisible(element);
  const disabled = model.disabled(element);
  const visibility = visible ? 'visible' : 'hidden';
  const usability = disabled ? 'disabled' : 'enabled';
  const states: CheckChoice[] = [
    visible
      ? { matcher: 'toBeVisible', label: 'record_checkVisible', shown: visibility, wrong: false }
      : { matcher: 'toBeHidden', label: 'record_checkHidden', shown: visibility, wrong: false },
    disabled
      ? { matcher: 'toBeDisabled', label: 'record_checkDisabled', shown: usability, wrong: false }
      : { matcher: 'toBeEnabled', label: 'record_checkEnabled', shown: usability, wrong: false },
  ];
  const wrongStates: CheckChoice[] = IDE_BUILD
    ? []
    : [
        visible
          ? { matcher: 'toBeHidden', label: 'bug_shouldBeHidden', shown: visibility, wrong: true }
          : { matcher: 'toBeVisible', label: 'bug_shouldBeVisible', shown: visibility, wrong: true },
        disabled
          ? { matcher: 'toBeEnabled', label: 'bug_shouldBeEnabled', shown: usability, wrong: true }
          : { matcher: 'toBeDisabled', label: 'bug_shouldBeDisabled', shown: usability, wrong: true },
      ];
  const first =
    values.find((c) => c.matcher === 'toHaveValue') ??
    values.find((c) => c.matcher === 'toHaveText' && c.shown!.length <= SHORT_TEXT);
  const passing = first
    ? [first, ...values.filter((c) => c !== first), ...states]
    : [states[0]!, ...values, ...states.slice(1)];
  return [...passing, ...wrongStates];
}

/**
 * The line under a dialog's fields that says what Add will record: a check
 * that passes, or, outside the IDE bundle, something wrong, with the note
 * field that goes with it.
 */
function verdictLine(form: HTMLFormElement, field: (label: string, control: HTMLElement) => void) {
  const line = document.createElement('div');
  line.className = 'verdict';
  line.setAttribute('aria-live', 'polite');
  form.appendChild(line);
  const note = input('', t('bug_notePlaceholder'));
  if (!IDE_BUILD) field(t('bug_note'), note);
  const noteLabel = note.previousElementSibling as HTMLElement | null;
  return {
    show(wrong: boolean): void {
      if (IDE_BUILD) {
        line.hidden = true;
        return;
      }
      line.classList.toggle('wrong', wrong);
      line.textContent = wrong ? t('record_checkWrong') : t('record_checkPasses');
      note.hidden = !wrong;
      if (noteLabel) noteLabel.hidden = !wrong;
    },
    note(): string | null {
      return note.value.trim() || null;
    },
  };
}

/**
 * The dialog for a picked element: what to check, what the page shows, and the
 * value expected for a value check. It names the element by the locator the
 * recording found for it (`target`), the project's test id attribute included.
 */
function checkElementDialog(element: Element, target: RecordedTarget): Promise<StepAssertion | null> {
  const choices = checkChoices(element);
  const locator = target.alternatives[0]?.locator ?? null;
  return openRecordDialog<StepAssertion>(
    t('record_checkElement'),
    ({ form, field, say }) => {
      if (locator) {
        const sub = document.createElement('div');
        sub.className = 'sub';
        const code = document.createElement('span');
        code.className = 'piwi-loc';
        code.innerHTML = highlightLocator(locator);
        sub.append(...tNodes('record_checkOn', { locator: code }));
        form.appendChild(sub);
      }
      const select = document.createElement('select');
      choices.forEach((c, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = t(c.label);
        select.appendChild(option);
      });
      field(t('record_checkWhat'), select);
      const shown = document.createElement('div');
      shown.className = 'actual';
      field(t('bug_pageShows'), shown);
      const expected = input();
      field(t('record_checkExpected'), expected);
      const expectedLabel = expected.previousElementSibling as HTMLElement;
      const verdict = verdictLine(form, field);
      const choice = (): CheckChoice => choices[Number(select.value)]!;
      const isWrong = (): boolean => {
        const c = choice();
        if (IDE_BUILD) return false;
        return VALUE_MATCHERS.has(c.matcher) ? expected.value !== c.shown : c.wrong;
      };
      const show = () => {
        const c = choice();
        const takesValue = VALUE_MATCHERS.has(c.matcher);
        expected.hidden = !takesValue;
        expectedLabel.hidden = !takesValue;
        expected.value = takesValue ? (c.shown ?? '') : '';
        shown.textContent = takesValue ? (c.shown ?? '') : stateWord(c.shown ?? '');
        verdict.show(isWrong());
        say('');
      };
      select.addEventListener('change', show);
      expected.addEventListener('input', () => verdict.show(isWrong()));
      show();
      return {
        focus: VALUE_MATCHERS.has(choices[0]!.matcher) ? expected : select,
        submit: () => {
          if (!locator) {
            say(t('record_checkNoLocator'));
            return null;
          }
          const c = choice();
          const takesValue = VALUE_MATCHERS.has(c.matcher);
          const wrong = isWrong();
          return {
            matcher: c.matcher,
            expected: takesValue ? expected.value : null,
            actual: wrong ? c.shown : null,
            negated: false,
            note: wrong ? verdict.note() : null,
          };
        },
      };
    },
    t('record_checkAdd'),
    'check-circle',
  );
}

/** The dialog for the page's address, starting from the one it is on. */
function checkAddressDialog(): Promise<StepAssertion | null> {
  const here = `${location.pathname}${location.search}${location.hash}`;
  return openRecordDialog<StepAssertion>(
    t('record_checkAddress'),
    ({ form, field, say }) => {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.append(...tNodes('bug_youAreOn', { path: urlView(here) }));
      form.appendChild(sub);
      const expected = input(here);
      field(t('record_checkAddressLabel'), expected);
      const verdict = verdictLine(form, field);
      const isWrong = (): boolean => {
        if (IDE_BUILD) return false;
        const value = expected.value.trim();
        return value !== '' && value !== here && value !== location.href;
      };
      expected.addEventListener('input', () => {
        verdict.show(isWrong());
        say('');
      });
      verdict.show(false);
      return {
        focus: expected,
        submit: () => {
          const value = expected.value.trim();
          if (!value) {
            say(t('record_checkAddressEmpty'));
            return null;
          }
          const wrong = isWrong();
          return {
            matcher: 'toHaveURL',
            expected: value,
            actual: wrong ? here : null,
            negated: false,
            note: wrong ? verdict.note() : null,
          };
        },
      };
    },
    t('record_checkAdd'),
    'check-circle',
  );
}

/** Keeps what a report needs around something wrong: the outline around it and a screenshot of the page. */
async function keepWrongEvidence(element: Element | null, step: number | null): Promise<void> {
  await setBugEvidenceFields({ outline: outlineAround(element) }).catch(() => undefined);
  await takeBugScreenshot('marked', step);
}

/** Pick an element and record a check of it. Nothing is recorded while the pick and the dialog are open. */
export function runCheckElementFlow(hooks: CheckHooks): Promise<void> {
  return exclusive(async () => {
    hooks.setPaused(true);
    // Out of the way while picking, so the bar itself cannot be picked.
    let showHud = hideSurfaces([HUD_HOST_ID]);
    try {
      const element = await pickElement();
      showHud();
      showHud = () => undefined;
      if (!element) return;
      const target = hooks.targetFor(element);
      const assertion = await checkElementDialog(element, target);
      if (!assertion) return;
      const step = await hooks.addAssert(target, assertion);
      if (assertion.actual != null) await keepWrongEvidence(element, step);
    } finally {
      showHud();
      hooks.setPaused(false);
    }
  });
}

/** Record a check of the page's address. */
export function runCheckAddressFlow(hooks: CheckHooks): Promise<void> {
  return exclusive(async () => {
    hooks.setPaused(true);
    try {
      const assertion = await checkAddressDialog();
      if (!assertion) return;
      const step = await hooks.addAssert(null, assertion);
      if (assertion.actual != null) await keepWrongEvidence(null, step);
    } finally {
      hooks.setPaused(false);
    }
  });
}
