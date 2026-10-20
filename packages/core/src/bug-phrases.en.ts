import type { BugPhrases, BugState, BugStepValue, BugSubject, RoleNoun } from './bug-phrases';
import { keyCombo } from './key-combo';
import { markdownCode } from './markdown-code';

/**
 * ARIA roles in the words a person uses for them: `textbox` is a "text field",
 * `combobox` a "dropdown".
 */
const ROLES: Readonly<Record<string, RoleNoun>> = {
  alert: { noun: 'alert message' },
  alertdialog: { noun: 'dialog' },
  article: { noun: 'article' },
  banner: { noun: 'header' },
  button: { noun: 'button' },
  cell: { noun: 'table cell' },
  checkbox: { noun: 'checkbox' },
  columnheader: { noun: 'column header' },
  combobox: { noun: 'dropdown' },
  contentinfo: { noun: 'footer' },
  dialog: { noun: 'dialog' },
  form: { noun: 'form' },
  generic: { noun: 'element' },
  grid: { noun: 'table' },
  gridcell: { noun: 'table cell' },
  heading: { noun: 'heading' },
  img: { noun: 'image' },
  link: { noun: 'link' },
  list: { noun: 'list' },
  listbox: { noun: 'list' },
  listitem: { noun: 'list item' },
  main: { noun: 'main content' },
  menu: { noun: 'menu' },
  menubar: { noun: 'menu bar' },
  menuitem: { noun: 'menu item' },
  menuitemcheckbox: { noun: 'menu item' },
  menuitemradio: { noun: 'menu item' },
  navigation: { noun: 'navigation' },
  option: { noun: 'option' },
  paragraph: { noun: 'paragraph' },
  progressbar: { noun: 'progress bar' },
  radio: { noun: 'radio button' },
  radiogroup: { noun: 'group of radio buttons' },
  region: { noun: 'section' },
  row: { noun: 'table row' },
  rowheader: { noun: 'row header' },
  search: { noun: 'search area' },
  searchbox: { noun: 'search field' },
  slider: { noun: 'slider' },
  spinbutton: { noun: 'number field' },
  status: { noun: 'status message' },
  switch: { noun: 'switch' },
  tab: { noun: 'tab' },
  table: { noun: 'table' },
  tablist: { noun: 'list of tabs' },
  tabpanel: { noun: 'tab panel' },
  textbox: { noun: 'text field' },
  toolbar: { noun: 'toolbar' },
  tooltip: { noun: 'tooltip' },
  tree: { noun: 'tree' },
  treeitem: { noun: 'tree item' },
};

const noun = (role: string): string => ROLES[role]?.noun ?? role;
const quote = (text: string): string => `"${text}"`;

/** Keys by the names keyboards print on them; any other key keeps Playwright's name. */
const KEYS: Readonly<Record<string, string>> = { ControlOrMeta: 'Ctrl', Control: 'Ctrl' };

const key = (name: string): string => keyCombo(name, (part) => KEYS[part] ?? part);

function subject(s: BugSubject): string {
  switch (s.kind) {
    case 'page':
      return 'the page';
    case 'named':
      return `${noun(s.role)} ${quote(s.name)}`;
    case 'name':
      return quote(s.name);
    case 'testId':
      return `the element with test id ${markdownCode(s.testId)}`;
    case 'text':
      return `${s.role ? noun(s.role) : s.tagName} ${quote(s.text)}`;
    case 'locator':
      return markdownCode(s.locator);
    case 'element':
      if (s.definite) return `the ${s.role ? noun(s.role) : s.tagName || 'element'}`;
      return s.role ? noun(s.role) : s.tagName || 'an element';
  }
}

const value = (v: BugStepValue): string => (v.kind === 'password' ? 'a password (not recorded)' : quote(v.text));

const STATES: Record<BugState, string> = {
  visible: 'visible',
  hidden: 'hidden',
  enabled: 'enabled',
  disabled: 'disabled',
  checked: 'checked',
};

/** A zoom factor as a percentage, such as `125%`. */
const percent = (zoom: number): string => `${Math.round(zoom * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const ofTotal = (shown: number, total: number | null): string => `${shown}${total != null ? ` of ${total}` : ''}`;

export const ENGLISH_BUG_PHRASES: BugPhrases = {
  language: 'en',
  roles: ROLES,
  quote,
  code: markdownCode,
  capitalize: (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
  steps: {
    goto: (url) => `Go to ${markdownCode(url)}`,
    click: (s) => `Click ${subject(s)}`,
    hover: (s) => `Hover over ${subject(s)}`,
    fill: (s, v) => `Fill ${subject(s)} with ${value(v)}`,
    check: (s) => `Check ${subject(s)}`,
    uncheck: (s) => `Uncheck ${subject(s)}`,
    selectOption: (s, v) => `Select ${value(v)} in ${subject(s)}`,
    press: (name, s) => (s ? `Press ${key(name)} in ${subject(s)}` : `Press ${key(name)}`),
    dblclick: (s) => `Double-click ${subject(s)}`,
    setInputFiles: (s, files) =>
      files.length === 0
        ? `Clear the files of ${subject(s)}`
        : `Choose the ${files.length === 1 ? 'file' : 'files'} ${files.map(quote).join(', ')} in ${subject(s)}`,
    dragTo: (s, target) => `Drag ${subject(s)} onto ${subject(target)}`,
    manual: (description) => `By hand: ${description}`,
  },
  expectation(s, e, negated) {
    const should = negated ? 'should not' : 'should';
    switch (e.matcher) {
      case 'text':
        return `${subject(s)} ${should} read ${quote(e.expected)}`;
      case 'value':
        return `${subject(s)} ${should} have the value ${quote(e.expected)}`;
      case 'name':
        return `${subject(s)} ${should} be named ${quote(e.expected)}`;
      case 'url':
        return `the page ${should} be ${markdownCode(e.expected)}`;
      case 'contains':
        return `${subject(s)} ${should} contain ${quote(e.expected)}`;
      case 'count':
        return `${subject(s)} ${should} match ${plural(e.count, 'element')}`;
      case 'state':
        return `${subject(s)} ${should} be ${STATES[e.state]}`;
    }
  },
  evidence: (c) =>
    [
      c.screenshots > 0 ? plural(c.screenshots, 'screenshot') : 'no screenshot',
      ...(c.stepShots > 0 ? [plural(c.stepShots, 'step screenshot')] : []),
      ...(c.consoleErrors > 0 ? [plural(c.consoleErrors, 'console error')] : []),
      ...(c.consoleWarnings > 0 ? [plural(c.consoleWarnings, 'console warning')] : []),
      ...(c.failedRequests > 0 ? [plural(c.failedRequests, 'failed request')] : []),
      ...(c.outline ? ['page outline'] : []),
    ].join(' · '),
  report: {
    untitled: 'Reported bug',
    titleOnPage: (pageKey) => `Bug on ${pageKey}`,
    pageLabel: '**Page**',
    pathOn: (path, origin) => `${path} on ${origin}`,
    stepsHeading: 'Steps to reproduce',
    noSteps: 'No steps were recorded.',
    actual: (v) => `Actual: ${v}`,
    note: (text) => `Note: ${text}`,
    viewport: (size, zoom) => `Viewport from this step: ${size}${zoom != null ? `, at ${percent(zoom)} zoom` : ''}`,
    failedInRun: 'The test failed at this step in the test run',
    expectedHeading: 'Expected and actual',
    nothingMarked: 'Nothing was marked as wrong.',
    expectedLine: (step, expectation, actual) =>
      `Step ${step}: ${expectation}.${actual != null ? ` It shows ${actual}.` : ''}`,
    evidenceHeading: 'Evidence',
    screenshotsHeading: 'Screenshots',
    screenshotAfterStep: (step) => `after step ${step}`,
    screenshotAtFinish: 'when the report was finished',
    screenshotByHand: 'taken by hand',
    noScreenshot: (reason) => `No screenshot: ${reason}`,
    consoleHeading: (shown, total) => `Console (${ofTotal(shown, total)})`,
    consoleLine: (e) => {
      const origin = e.source === 'console' ? '' : e.source === 'error' ? ' uncaught' : ' unhandled rejection';
      return `${e.level}${origin} on ${e.page} at ${e.time}: ${e.message}`;
    },
    requestsHeading: (shown, total) => `Failed requests (${ofTotal(shown, total)})`,
    requestLine: (r) => `${r.request} → ${r.status > 0 ? String(r.status) : 'no answer'}, on ${r.page} at ${r.time}`,
    outlineHeading: 'Page outline',
    outlineNote: 'Built by Piwi Picker from the page; the YAML form of an ARIA snapshot, not Playwright’s own.',
    notReplayedHeading: 'Not replayed',
    notReplayedNote: 'Calls of the test that these steps leave out, so neither Replay nor the spec performs them:',
    notReplayedLine: (e) => `${e.call}${e.location ? ` at ${e.location}` : ''}: ${e.reason}`,
  },
};
