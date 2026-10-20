import { bugPhrases, type BugPhrases } from '@piwitests/core/bug-phrases';
import type { CodegenWarning } from '@piwitests/core/codegen';
import type { LocatorStability, LocatorStabilityRuleId } from '@piwitests/core/locator-stability';
import { t, uiLanguage, type MessageKey } from './i18n.js';

/**
 * What `@piwitests/core` writes, in the interface language: the bug report's
 * sentences through core's phrasebook, and the texts core keeps in English for
 * the dashboard and the CLI (stability rules, converter warnings, action
 * labels) through the catalogs, by their code.
 */

/** Core's phrasebook for the interface language, English where core has none. */
export function interfacePhrases(): BugPhrases {
  return bugPhrases(uiLanguage());
}

const STABILITY_LABELS: Record<LocatorStabilityRuleId, MessageKey> = {
  position: 'stability_position',
  'css-class': 'stability_cssClass',
  'css-structure': 'stability_cssStructure',
  xpath: 'stability_xpath',
  'generated-id': 'stability_generatedId',
  'style-attribute': 'stability_styleAttribute',
  'long-text': 'stability_longText',
  'data-text': 'stability_dataText',
  'deep-chain': 'stability_deepChain',
};

/** The rules a chain breaks, by label, each once: `position · CSS class`. */
export function stabilityText(stability: LocatorStability, separator = ' · '): string {
  return stabilityRulesText(
    stability.findings.map((finding) => finding.rule),
    separator,
  );
}

/** `stabilityText` for rules already listed by id. */
export function stabilityRulesText(rules: readonly LocatorStabilityRuleId[], separator = ' · '): string {
  const labels: string[] = [];
  for (const rule of rules) {
    const label = t(STABILITY_LABELS[rule]);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(separator);
}

/** A converter warning, worded from its code. */
export function codegenWarningText(warning: CodegenWarning): string {
  switch (warning.code) {
    case 'no-locator':
      return t('codegen_noLocator');
    case 'brittle-locator':
      return t('codegen_brittleLocator', { locator: warning.detail ?? '' });
    case 'redacted-value':
      return t('codegen_redactedValue', { variable: warning.detail ?? '' });
    case 'incomplete-assertion':
      return warning.detail ? t('codegen_missingExpected', { matcher: warning.detail }) : t('codegen_emptyAssertion');
    case 'file-needed':
      return t('codegen_fileNeeded', { files: warning.detail ?? '' });
    case 'manual-step':
      return t('codegen_manualStep', { step: warning.step + 1, description: warning.detail ?? '' });
  }
}

const ACTION_LABELS: Record<string, MessageKey> = {
  click: 'common_actionClick',
  dblclick: 'common_actionDblclick',
  fill: 'common_actionFill',
  selectOption: 'common_actionSelectOption',
  check: 'common_actionCheck',
  uncheck: 'common_actionUncheck',
  hover: 'common_actionHover',
  tap: 'common_actionTap',
  focus: 'common_actionFocus',
  blur: 'common_actionBlur',
  press: 'common_actionPress',
  type: 'common_actionType',
  setInputFiles: 'common_actionSetInputFiles',
  dragTo: 'common_actionDragTo',
  drop: 'common_actionDrop',
  dispatchEvent: 'common_actionDispatchEvent',
  scrollIntoViewIfNeeded: 'common_actionScrollIntoView',
  waitFor: 'common_actionWaitFor',
  count: 'common_actionCount',
  evaluate: 'common_actionEvaluate',
  expect: 'common_actionExpect',
  other: 'common_actionOther',
};

/** A stored action key (`selectOption`, `expect.not.toBeVisible`, …) as a label; an unknown key stays as it is. */
export function actionLabel(action: string): string {
  if (action.startsWith('expect.')) {
    const rest = action.slice('expect.'.length);
    return rest.startsWith('not.')
      ? t('common_actionExpectNot', { matcher: rest.slice('not.'.length) })
      : t('common_actionExpectMatcher', { matcher: rest });
  }
  const key = ACTION_LABELS[action];
  return key ? t(key) : action;
}
