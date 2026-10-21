import { highlightLocator } from '@piwitests/picker-dom';
import {
  VALUE_MATCHERS,
  type AssertionMatcher,
  type RecordedTarget,
  type StepAssertion,
} from '@piwitests/core/recording';
import { suggestAssertions } from './assertion-suggest.js';
import { DomModel } from './engine-aria.js';
import { exclusive, input, openRecordDialog, pickElement, type BugRecorderHooks } from './bug-panel.js';
import { HUD_HOST_ID, hideSurfaces } from './record-ui.js';
import { t, tNodes, type MessageKey } from '../shared/i18n.js';

/**
 * A test recording's checks: an element's text, value, name or state, or the
 * page's address, as the page shows them now, added to the recording as an
 * `assert` step that the spec writes as `await expect(…)`. The bug report's
 * dialogs say what is wrong instead (`bug-panel.ts`); these say what is right.
 */

/** What `record-panel.ts` lends this module to record a check: the bug report's hooks. */
type CheckHooks = BugRecorderHooks;

interface CheckChoice {
  matcher: AssertionMatcher;
  label: MessageKey;
  /** What the page shows now: the expected value a value matcher starts from. */
  value: string | null;
}

/** A value longer than this is not offered first: a whole block's text makes a brittle check. */
const SHORT_TEXT = 80;

/**
 * What can be checked about an element, as it is now: its value (never for a
 * field that holds a secret), its text, its accessible name, and the states it
 * is in. The first choice is the most telling: a field's value, else a short
 * text, else that it is visible.
 */
function checkChoices(element: Element): CheckChoice[] {
  const suggestion = suggestAssertions(element);
  const values: CheckChoice[] = [];
  for (const c of suggestion.candidates) {
    if (c.detail == null) continue;
    if (c.method === 'toHaveValue') values.push({ matcher: c.method, label: 'record_checkValue', value: c.detail });
    if (c.method === 'toHaveText') values.push({ matcher: c.method, label: 'record_checkText', value: c.detail });
    if (c.method === 'toHaveAccessibleName')
      values.push({ matcher: c.method, label: 'record_checkName', value: c.detail });
  }
  const model = new DomModel();
  const states: CheckChoice[] = [
    model.isVisible(element)
      ? { matcher: 'toBeVisible', label: 'record_checkVisible', value: null }
      : { matcher: 'toBeHidden', label: 'record_checkHidden', value: null },
    model.disabled(element)
      ? { matcher: 'toBeDisabled', label: 'record_checkDisabled', value: null }
      : { matcher: 'toBeEnabled', label: 'record_checkEnabled', value: null },
  ];
  const first =
    values.find((c) => c.matcher === 'toHaveValue') ??
    values.find((c) => c.matcher === 'toHaveText' && c.value!.length <= SHORT_TEXT);
  const choices = first
    ? [first, ...values.filter((c) => c !== first), ...states]
    : [states[0]!, ...values, ...states.slice(1)];
  return choices;
}

/**
 * The dialog for a picked element: what to check, and the value expected for a value check. It names the element by
 * the locator the recording found for it (`target`), the project's test id attribute included.
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
      const expected = input();
      field(t('record_checkExpected'), expected);
      const expectedLabel = expected.previousElementSibling as HTMLElement;
      const show = () => {
        const choice = choices[Number(select.value)]!;
        const takesValue = VALUE_MATCHERS.has(choice.matcher);
        expected.hidden = !takesValue;
        expectedLabel.hidden = !takesValue;
        expected.value = choice.value ?? '';
        say('');
      };
      select.addEventListener('change', show);
      show();
      return {
        focus: select,
        submit: () => {
          if (!locator) {
            say(t('record_checkNoLocator'));
            return null;
          }
          const choice = choices[Number(select.value)]!;
          const takesValue = VALUE_MATCHERS.has(choice.matcher);
          return {
            matcher: choice.matcher,
            expected: takesValue ? expected.value : null,
            actual: null,
            negated: false,
            note: null,
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
  return openRecordDialog<StepAssertion>(
    t('record_checkAddress'),
    ({ field, say }) => {
      const expected = input(`${location.pathname}${location.search}`);
      field(t('record_checkAddressLabel'), expected);
      return {
        focus: expected,
        submit: () => {
          const value = expected.value.trim();
          if (!value) {
            say(t('record_checkAddressEmpty'));
            return null;
          }
          return { matcher: 'toHaveURL', expected: value, actual: null, negated: false, note: null };
        },
      };
    },
    t('record_checkAdd'),
    'check-circle',
  );
}

/** Pick an element and record a check of what it shows now. Nothing is recorded while the pick and the dialog are open. */
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
      if (assertion) await hooks.addAssert(target, assertion);
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
      if (assertion) await hooks.addAssert(null, assertion);
    } finally {
      hooks.setPaused(false);
    }
  });
}
