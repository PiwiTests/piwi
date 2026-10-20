import type { BugPhrases, BugState, BugStepValue, BugSubject, NounGender, RoleNoun } from './bug-phrases';
import { markdownCode } from './markdown-code';
import { keyCombo } from './key-combo';

/** ARIA roles in the words of a German interface, with their gender. None of them changes its ending by case. */
const ROLES: Readonly<Record<string, RoleNoun>> = {
  alert: { noun: 'Warnmeldung', gender: 'feminine' },
  alertdialog: { noun: 'Dialog', gender: 'masculine' },
  article: { noun: 'Artikel', gender: 'masculine' },
  banner: { noun: 'Kopfbereich', gender: 'masculine' },
  button: { noun: 'Button', gender: 'masculine' },
  cell: { noun: 'Tabellenzelle', gender: 'feminine' },
  checkbox: { noun: 'Kontrollkästchen', gender: 'neuter' },
  columnheader: { noun: 'Spaltenüberschrift', gender: 'feminine' },
  combobox: { noun: 'Auswahlliste', gender: 'feminine' },
  contentinfo: { noun: 'Fußbereich', gender: 'masculine' },
  dialog: { noun: 'Dialog', gender: 'masculine' },
  form: { noun: 'Formular', gender: 'neuter' },
  generic: { noun: 'Element', gender: 'neuter' },
  grid: { noun: 'Tabelle', gender: 'feminine' },
  gridcell: { noun: 'Tabellenzelle', gender: 'feminine' },
  heading: { noun: 'Überschrift', gender: 'feminine' },
  img: { noun: 'Bild', gender: 'neuter' },
  link: { noun: 'Link', gender: 'masculine' },
  list: { noun: 'Liste', gender: 'feminine' },
  listbox: { noun: 'Liste', gender: 'feminine' },
  listitem: { noun: 'Listeneintrag', gender: 'masculine' },
  main: { noun: 'Hauptinhalt', gender: 'masculine' },
  menu: { noun: 'Menü', gender: 'neuter' },
  menubar: { noun: 'Menüleiste', gender: 'feminine' },
  menuitem: { noun: 'Menüeintrag', gender: 'masculine' },
  menuitemcheckbox: { noun: 'Menüeintrag', gender: 'masculine' },
  menuitemradio: { noun: 'Menüeintrag', gender: 'masculine' },
  navigation: { noun: 'Navigation', gender: 'feminine' },
  option: { noun: 'Option', gender: 'feminine' },
  paragraph: { noun: 'Absatz', gender: 'masculine' },
  progressbar: { noun: 'Fortschrittsbalken', gender: 'masculine' },
  radio: { noun: 'Optionsfeld', gender: 'neuter' },
  radiogroup: { noun: 'Gruppe von Optionsfeldern', gender: 'feminine' },
  region: { noun: 'Abschnitt', gender: 'masculine' },
  row: { noun: 'Tabellenzeile', gender: 'feminine' },
  rowheader: { noun: 'Zeilenüberschrift', gender: 'feminine' },
  search: { noun: 'Suchbereich', gender: 'masculine' },
  searchbox: { noun: 'Suchfeld', gender: 'neuter' },
  slider: { noun: 'Schieberegler', gender: 'masculine' },
  spinbutton: { noun: 'Zahlenfeld', gender: 'neuter' },
  status: { noun: 'Statusmeldung', gender: 'feminine' },
  switch: { noun: 'Schalter', gender: 'masculine' },
  tab: { noun: 'Tab', gender: 'masculine' },
  table: { noun: 'Tabelle', gender: 'feminine' },
  tablist: { noun: 'Tab-Leiste', gender: 'feminine' },
  tabpanel: { noun: 'Tab-Inhalt', gender: 'masculine' },
  textbox: { noun: 'Textfeld', gender: 'neuter' },
  toolbar: { noun: 'Symbolleiste', gender: 'feminine' },
  tooltip: { noun: 'Tooltip', gender: 'masculine' },
  tree: { noun: 'Baumansicht', gender: 'feminine' },
  treeitem: { noun: 'Baumeintrag', gender: 'masculine' },
};

const ELEMENT: RoleNoun = { noun: 'Element', gender: 'neuter' };

/** The case a noun phrase takes: the subject, after `auf` or `in` + accusative, after `in` + dative. */
type Case = 'nominative' | 'accusative' | 'dative';

const DEFINITE: Record<Case, Record<NounGender, string>> = {
  nominative: { masculine: 'der', feminine: 'die', neuter: 'das' },
  accusative: { masculine: 'den', feminine: 'die', neuter: 'das' },
  dative: { masculine: 'dem', feminine: 'der', neuter: 'dem' },
};

const INDEFINITE: Record<Case, Record<NounGender, string>> = {
  nominative: { masculine: 'ein', feminine: 'eine', neuter: 'ein' },
  accusative: { masculine: 'einen', feminine: 'eine', neuter: 'ein' },
  dative: { masculine: 'einem', feminine: 'einer', neuter: 'einem' },
};

/** An unknown role keeps its name and is neuter, like `das Element`. */
const roleNoun = (role: string | null): RoleNoun =>
  role ? (ROLES[role] ?? { noun: role, gender: 'neuter' }) : ELEMENT;

/** `der Button`, `den Button`, `dem Button`: the definite article in the case, from the noun's gender. */
const definite = (n: RoleNoun, c: Case): string => `${DEFINITE[c][n.gender ?? 'neuter']} ${n.noun}`;

const quote = (text: string): string => `„${text}“`;

/** The subject as a noun phrase in a case, with its article. */
function subject(s: BugSubject, c: Case): string {
  switch (s.kind) {
    case 'page':
      return `${DEFINITE[c].feminine} Seite`;
    case 'named':
      return `${definite(roleNoun(s.role), c)} ${quote(s.name)}`;
    case 'name':
      return quote(s.name);
    case 'testId':
      return `${definite(ELEMENT, c)} mit der Test-ID ${markdownCode(s.testId)}`;
    case 'text':
      return `${definite(roleNoun(s.role), c)} ${quote(s.text)}`;
    case 'locator':
      return `${definite(ELEMENT, c)} ${markdownCode(s.locator)}`;
    case 'element':
      if (s.role) return definite(roleNoun(s.role), c);
      if (s.tagName) return `${definite(ELEMENT, c)} ${markdownCode(s.tagName)}`;
      return s.definite ? definite(ELEMENT, c) : `${INDEFINITE[c].neuter} ${ELEMENT.noun}`;
  }
}

/** `in` with the dative, contracted with `dem` as German writes it: `im Textfeld`, `in der Auswahlliste`. */
function inDative(s: BugSubject): string {
  const phrase = subject(s, 'dative');
  return phrase.startsWith('dem ') ? `im ${phrase.slice(4)}` : `in ${phrase}`;
}

/** Keys by the names German keyboards print on them; any other key keeps Playwright's name. */
const KEYS: Readonly<Record<string, string>> = {
  ControlOrMeta: 'Strg',
  Escape: 'Esc',
  Backspace: 'Rücktaste',
  Delete: 'Entf',
  Insert: 'Einfg',
  Space: 'Leertaste',
  ArrowUp: 'Pfeil nach oben',
  ArrowDown: 'Pfeil nach unten',
  ArrowLeft: 'Pfeil nach links',
  ArrowRight: 'Pfeil nach rechts',
  PageUp: 'Bild auf',
  PageDown: 'Bild ab',
  Home: 'Pos1',
  End: 'Ende',
  Control: 'Strg',
  Shift: 'Umschalt',
};

const key = (name: string): string => keyCombo(name, (part) => KEYS[part] ?? part);

const value = (v: BugStepValue): string =>
  v.kind === 'password' ? 'ein Passwort (nicht aufgezeichnet)' : quote(v.text);

/** A predicate adjective after `sein` takes no ending in German. The words of the bug panel's states. */
const STATES: Record<BugState, string> = {
  visible: 'sichtbar',
  hidden: 'ausgeblendet',
  enabled: 'nutzbar',
  disabled: 'ausgegraut',
  checked: 'aktiviert',
};

const capitalize = (text: string): string => `${text.charAt(0).toLocaleUpperCase('de')}${text.slice(1)}`;

const number = (n: number): string => new Intl.NumberFormat('de-DE').format(n);
/** German puts only 1 in the singular. */
/** A zoom factor as a percentage, such as `125%`. */
const percent = (zoom: number): string => `${Math.round(zoom * 100)}\u00a0%`;
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n === 1 ? one : many}`;
const ofTotal = (shown: number, total: number | null): string =>
  `${number(shown)}${total != null ? ` von ${number(total)}` : ''}`;

export const GERMAN_BUG_PHRASES: BugPhrases = {
  language: 'de',
  roles: ROLES,
  quote,
  code: markdownCode,
  key,
  capitalize,
  steps: {
    goto: (url) => `${markdownCode(url)} öffnen`,
    click: (s) => capitalize(`auf ${subject(s, 'accusative')} klicken`),
    hover: (s) => capitalize(`mit der Maus über ${subject(s, 'accusative')} fahren`),
    fill: (s, v) => capitalize(`${value(v)} in ${subject(s, 'accusative')} eingeben`),
    check: (s) => capitalize(`${subject(s, 'accusative')} aktivieren`),
    uncheck: (s) => capitalize(`${subject(s, 'accusative')} deaktivieren`),
    selectOption: (s, v) => capitalize(`${value(v)} ${inDative(s)} auswählen`),
    press: (name, s) => (s ? `${key(name)} ${inDative(s)} drücken` : `${key(name)} drücken`),
    dblclick: (s) => capitalize(`auf ${subject(s, 'accusative')} doppelklicken`),
    setInputFiles: (s, files) =>
      files.length === 0
        ? capitalize(`${subject(s, 'accusative')} leeren`)
        : capitalize(
            `${files.length === 1 ? 'die Datei' : 'die Dateien'} ${files.map(quote).join(', ')} ${inDative(s)} auswählen`,
          ),
    dragTo: (s, target) => capitalize(`${subject(s, 'accusative')} auf ${subject(target, 'accusative')} ziehen`),
    manual: (description) => `Von Hand: ${description}`,
  },
  expectation(s, e, negated) {
    const should = negated ? 'sollte nicht' : 'sollte';
    const text = subject(s, 'nominative');
    switch (e.matcher) {
      case 'text':
        return `${text} ${should} ${quote(e.expected)} anzeigen`;
      case 'value':
        return `${text} ${should} den Wert ${quote(e.expected)} haben`;
      case 'name':
        return `${text} ${should} ${quote(e.expected)} heißen`;
      case 'url':
        return `die Seite ${should} ${markdownCode(e.expected)} sein`;
      case 'contains':
        return `${text} ${should} ${quote(e.expected)} enthalten`;
      case 'count':
        return `${text} ${should} ${plural(e.count, 'Element', 'Elemente')} finden`;
      case 'state':
        return `${text} ${should} ${STATES[e.state]} sein`;
    }
  },
  evidence: (c) =>
    [
      c.screenshots > 0 ? plural(c.screenshots, 'Screenshot', 'Screenshots') : 'kein Screenshot',
      ...(c.stepShots > 0 ? [plural(c.stepShots, 'Schritt-Screenshot', 'Schritt-Screenshots')] : []),
      ...(c.consoleErrors > 0 ? [plural(c.consoleErrors, 'Konsolenfehler', 'Konsolenfehler')] : []),
      ...(c.consoleWarnings > 0 ? [plural(c.consoleWarnings, 'Konsolenwarnung', 'Konsolenwarnungen')] : []),
      ...(c.failedRequests > 0
        ? [plural(c.failedRequests, 'fehlgeschlagene Anfrage', 'fehlgeschlagene Anfragen')]
        : []),
      ...(c.outline ? ['Seitenstruktur'] : []),
    ].join(' · '),
  report: {
    untitled: 'Gemeldeter Bug',
    titleOnPage: (pageKey) => `Bug auf ${pageKey}`,
    pageLabel: '**Seite**',
    pathOn: (path, origin) => `${path} auf ${origin}`,
    stepsHeading: 'Schritte zum Reproduzieren',
    noSteps: 'Es wurden keine Schritte aufgezeichnet.',
    actual: (v) => `Ergebnis: ${v}`,
    note: (text) => `Notiz: ${text}`,
    viewport: (size, zoom) => `Viewport ab diesem Schritt: ${size}${zoom != null ? `, Zoom ${percent(zoom)}` : ''}`,
    failedInRun: 'Hier ist der Test in dem Lauf fehlgeschlagen, aus dem dieser Bericht stammt',
    expectedHeading: 'Erwartet und tatsächlich',
    nothingMarked: 'Nichts wurde als Fehler markiert.',
    expectedLine: (step, expectation, actual) =>
      `Schritt ${step}: ${expectation}.${actual != null ? ` Ergebnis: ${actual}.` : ''}`,
    evidenceHeading: 'Belege',
    screenshotsHeading: 'Screenshots',
    screenshotAfterStep: (step) => `nach Schritt ${step}`,
    screenshotAtFinish: 'beim Abschluss des Berichts',
    screenshotByHand: 'von Hand aufgenommen',
    noScreenshot: (reason) => `Kein Screenshot: ${reason}`,
    consoleHeading: (shown, total) => `Konsole (${ofTotal(shown, total)})`,
    consoleLine: (e) => {
      const what =
        e.source === 'rejection'
          ? 'unbehandelte Promise-Ablehnung'
          : e.level === 'error'
            ? e.source === 'error'
              ? 'nicht abgefangener Fehler'
              : 'Fehler'
            : 'Warnung';
      return `${what} auf ${e.page} um ${e.time}: ${e.message}`;
    },
    requestsHeading: (shown, total) => `Fehlgeschlagene Anfragen (${ofTotal(shown, total)})`,
    requestLine: (r) =>
      `${r.request} → ${r.status > 0 ? String(r.status) : 'keine Antwort'}, auf ${r.page} um ${r.time}`,
    outlineHeading: 'Seitenstruktur',
    outlineNote:
      'Von Piwi Picker aus der Seite erstellt; die YAML-Form eines ARIA-Snapshots, nicht die von Playwright selbst.',
    notReplayedHeading: 'Nicht wiedergegeben',
    notReplayedNote: 'Aufrufe des Tests, die diese Schritte auslassen, sodass weder Replay noch der Test sie ausführt:',
    notReplayedLine: (e) => `${e.call}${e.location ? ` in ${e.location}` : ''}: ${e.reason}`,
  },
};
