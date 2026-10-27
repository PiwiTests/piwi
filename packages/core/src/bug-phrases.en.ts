import type { BugPhrases, BugState, BugStepValue, BugSubject, RoleNoun } from './bug-phrases';
import type { ManualCheckValues } from './recording';
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

/** `; in the run it expected X and received Y`, as much as the run says. */
function inRun(c: ManualCheckValues): string {
  const parts = [c.expected ? `expected ${c.expected}` : null, c.received ? `received ${c.received}` : null].filter(
    Boolean,
  );
  return parts.length > 0 ? `; in the run it ${parts.join(' and ')}` : '';
}

export const ENGLISH_BUG_PHRASES: BugPhrases = {
  language: 'en',
  roles: ROLES,
  quote,
  code: markdownCode,
  key,
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
  manualInstructions: {
    goBack: () => 'Go back to the previous page in the browser',
    goForward: () => 'Go forward to the next page in the browser',
    reload: () => 'Reload the page',
    gotoUnknown: () => 'Open the page the test opened; the run does not keep which',
    setContent: () => `Open the page the test writes itself (${markdownCode('page.setContent')})`,
    keyboardType: () => 'Type on the keyboard what the test typed; the run keeps it in the test’s source',
    mouseAt: (i) => `Do with the mouse what the test did at the point (${i.x}, ${i.y}) of the page: ${i.call}`,
    mouseOrKeyboard: (i) => `Do what the test did with the mouse or the keyboard: ${i.call}`,
    failedCall: (i) => `Do what the test did when it failed: ${i.call}`,
    locatorCall: (i) => `Do what the test did on ${markdownCode(i.locator)}: ${i.call}`,
    fillUnknown: (i) => `Fill ${markdownCode(i.locator)} as the test did; the run does not keep the value`,
    fillPartial: (i) => `Fill ${markdownCode(i.locator)} as the test did; the run keeps only part of the value`,
    pressUnknown: (i) => `Press in ${markdownCode(i.locator)} the key the test pressed`,
    selectOptionUnknown: (i) =>
      `Choose in ${markdownCode(i.locator)} the option the test chose; the run does not keep which`,
    selectOptions: (i) =>
      `Choose in ${markdownCode(i.locator)} ${i.options
        .map((o) => (typeof o === 'number' ? `the option at index ${o}` : quote(o)))
        .join(' and ')}`,
    setInputFiles: (i) =>
      `Choose in ${markdownCode(i.locator)} the file the test chose; the run does not keep its name`,
    dragTo: (i) => `Drag ${markdownCode(i.locator)} to where the test dropped it; the run does not keep where`,
    drop: (i) => `Drop onto ${markdownCode(i.locator)} the files or data the test dropped`,
    focus: (i) => `Put the focus on ${markdownCode(i.locator)}`,
    blur: (i) => `Move the focus away from ${markdownCode(i.locator)}`,
    dispatchEvent: (i) => `Do on ${markdownCode(i.locator)} what fires the event the test dispatched`,
    scrollIntoViewIfNeeded: (i) => `Scroll ${markdownCode(i.locator)} into view`,
    expectPoll: (i) => `Check what the test checked again and again (${i.matcher})${inRun(i)}`,
    expectValue: (i) => `Check what the test checked: ${i.what}${inRun(i)}`,
    expectLocator: (i) => `Check ${markdownCode(i.locator)} with ${i.matcher}${inRun(i)}`,
    expectURL: (i) => `Check the page’s address (toHaveURL)${inRun(i)}`,
    leadingSteps: (i) =>
      `Do the first ${i.count} steps of the test by hand, up to where step ${i.count + 1} starts: a steps file holds ${i.limit} steps`,
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
