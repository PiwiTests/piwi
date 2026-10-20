import type { BugPhrases, BugState, BugStepValue, BugSubject, RoleNoun } from './bug-phrases';
import { markdownCode } from './markdown-code';
import { keyCombo } from './key-combo';

/** Before a colon. */
const NBSP = ' ';
/** Inside « », before ; ! ? and between a number and its unit. */
const NNBSP = ' ';

/** ARIA roles in the words of a French interface, with their gender. */
const ROLES: Readonly<Record<string, RoleNoun>> = {
  alert: { noun: 'message d’alerte', gender: 'masculine' },
  alertdialog: { noun: 'boîte de dialogue', gender: 'feminine' },
  article: { noun: 'article', gender: 'masculine' },
  banner: { noun: 'en-tête', gender: 'masculine' },
  button: { noun: 'bouton', gender: 'masculine' },
  cell: { noun: 'cellule de tableau', gender: 'feminine' },
  checkbox: { noun: 'case à cocher', gender: 'feminine' },
  columnheader: { noun: 'en-tête de colonne', gender: 'masculine' },
  combobox: { noun: 'liste déroulante', gender: 'feminine' },
  contentinfo: { noun: 'pied de page', gender: 'masculine' },
  dialog: { noun: 'boîte de dialogue', gender: 'feminine' },
  form: { noun: 'formulaire', gender: 'masculine' },
  generic: { noun: 'élément', gender: 'masculine' },
  grid: { noun: 'tableau', gender: 'masculine' },
  gridcell: { noun: 'cellule de tableau', gender: 'feminine' },
  heading: { noun: 'titre', gender: 'masculine' },
  img: { noun: 'image', gender: 'feminine' },
  link: { noun: 'lien', gender: 'masculine' },
  list: { noun: 'liste', gender: 'feminine' },
  listbox: { noun: 'liste', gender: 'feminine' },
  listitem: { noun: 'élément de liste', gender: 'masculine' },
  main: { noun: 'contenu principal', gender: 'masculine' },
  menu: { noun: 'menu', gender: 'masculine' },
  menubar: { noun: 'barre de menus', gender: 'feminine' },
  menuitem: { noun: 'élément de menu', gender: 'masculine' },
  menuitemcheckbox: { noun: 'élément de menu', gender: 'masculine' },
  menuitemradio: { noun: 'élément de menu', gender: 'masculine' },
  navigation: { noun: 'navigation', gender: 'feminine' },
  option: { noun: 'option', gender: 'feminine' },
  paragraph: { noun: 'paragraphe', gender: 'masculine' },
  progressbar: { noun: 'barre de progression', gender: 'feminine' },
  radio: { noun: 'bouton radio', gender: 'masculine' },
  radiogroup: { noun: 'groupe de boutons radio', gender: 'masculine' },
  region: { noun: 'section', gender: 'feminine' },
  row: { noun: 'ligne de tableau', gender: 'feminine' },
  rowheader: { noun: 'en-tête de ligne', gender: 'masculine' },
  search: { noun: 'zone de recherche', gender: 'feminine' },
  searchbox: { noun: 'champ de recherche', gender: 'masculine' },
  slider: { noun: 'curseur', gender: 'masculine' },
  spinbutton: { noun: 'champ numérique', gender: 'masculine' },
  status: { noun: 'message d’état', gender: 'masculine' },
  switch: { noun: 'interrupteur', gender: 'masculine' },
  tab: { noun: 'onglet', gender: 'masculine' },
  table: { noun: 'tableau', gender: 'masculine' },
  tablist: { noun: 'liste d’onglets', gender: 'feminine' },
  tabpanel: { noun: 'panneau d’onglet', gender: 'masculine' },
  textbox: { noun: 'champ de texte', gender: 'masculine' },
  toolbar: { noun: 'barre d’outils', gender: 'feminine' },
  tooltip: { noun: 'info-bulle', gender: 'feminine' },
  tree: { noun: 'arborescence', gender: 'feminine' },
  treeitem: { noun: 'élément d’arborescence', gender: 'masculine' },
};

const ELEMENT: RoleNoun = { noun: 'élément', gender: 'masculine' };
/** In "Cocher la case « J’accepte »", a checkbox is a "case". */
const BOX: RoleNoun = { noun: 'case', gender: 'feminine' };

const roleNoun = (role: string | null): RoleNoun =>
  role ? (ROLES[role] ?? { noun: role, gender: 'masculine' }) : ELEMENT;

/** `le bouton`, `la case`, `l’image`: the definite article, elided before a vowel. */
function definite(n: RoleNoun): string {
  if (/^[aeiouyàâäéèêëîïôöùûü]/i.test(n.noun)) return `l’${n.noun}`;
  return `${n.gender === 'feminine' ? 'la' : 'le'} ${n.noun}`;
}

const quote = (text: string): string => `«${NNBSP}${text}${NNBSP}»`;

/** The subject as a noun phrase with its article, and the gender an adjective about it takes. */
function subject(s: BugSubject, nounFor: (role: string | null) => RoleNoun = roleNoun): [string, RoleNoun] {
  switch (s.kind) {
    case 'page':
      return ['la page', { noun: 'page', gender: 'feminine' }];
    case 'named': {
      const n = nounFor(s.role);
      return [`${definite(n)} ${quote(s.name)}`, n];
    }
    case 'name':
      return [quote(s.name), ELEMENT];
    case 'testId':
      return [`l’élément avec le test id ${markdownCode(s.testId)}`, ELEMENT];
    case 'text': {
      const n = nounFor(s.role);
      return [`${definite(n)} ${quote(s.text)}`, n];
    }
    case 'locator':
      return [`l’élément ${markdownCode(s.locator)}`, ELEMENT];
    case 'element': {
      if (s.role) {
        const n = nounFor(s.role);
        return [definite(n), n];
      }
      if (s.tagName) return [`l’élément ${markdownCode(s.tagName)}`, ELEMENT];
      return [s.definite ? 'l’élément' : 'un élément', ELEMENT];
    }
  }
}

const phrase = (s: BugSubject): string => subject(s)[0];

/** For check and uncheck: "la case « J’accepte »" rather than "la case à cocher". */
const checkable = (s: BugSubject): string => subject(s, (role) => (role === 'checkbox' ? BOX : roleNoun(role)))[0];

/** Keys by the names French keyboards print on them; any other key keeps Playwright's name. */
const KEYS: Readonly<Record<string, string>> = {
  ControlOrMeta: 'Ctrl',
  Enter: 'Entrée',
  Escape: 'Échap',
  Backspace: 'Retour arrière',
  Delete: 'Suppr',
  Space: 'Espace',
  ArrowUp: 'Flèche haut',
  ArrowDown: 'Flèche bas',
  ArrowLeft: 'Flèche gauche',
  ArrowRight: 'Flèche droite',
  PageUp: 'Page précédente',
  PageDown: 'Page suivante',
  Home: 'Début',
  End: 'Fin',
};

const key = (name: string): string => keyCombo(name, (part) => KEYS[part] ?? part);

const value = (v: BugStepValue): string => (v.kind === 'password' ? 'un mot de passe (non enregistré)' : quote(v.text));

const STATES: Record<BugState, [masculine: string, feminine: string]> = {
  visible: ['visible', 'visible'],
  hidden: ['masqué', 'masquée'],
  enabled: ['activé', 'activée'],
  disabled: ['désactivé', 'désactivée'],
  checked: ['coché', 'cochée'],
};

const number = (n: number): string => new Intl.NumberFormat('fr-FR').format(n);
/** French puts 0 and 1 in the singular. */
/** A zoom factor as a percentage, such as `125%`. */
const percent = (zoom: number): string => `${Math.round(zoom * 100)}${NNBSP}%`;
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n < 2 ? one : many}`;
const ofTotal = (shown: number, total: number | null): string =>
  `${number(shown)}${total != null ? ` sur ${number(total)}` : ''}`;

export const FRENCH_BUG_PHRASES: BugPhrases = {
  language: 'fr',
  roles: ROLES,
  quote,
  code: markdownCode,
  capitalize: (text) => `${text.charAt(0).toLocaleUpperCase('fr')}${text.slice(1)}`,
  steps: {
    goto: (url) => `Ouvrir ${markdownCode(url)}`,
    click: (s) => `Cliquer sur ${phrase(s)}`,
    hover: (s) => `Survoler ${phrase(s)}`,
    fill: (s, v) => `Saisir ${value(v)} dans ${phrase(s)}`,
    check: (s) => `Cocher ${checkable(s)}`,
    uncheck: (s) => `Décocher ${checkable(s)}`,
    selectOption: (s, v) => `Choisir ${value(v)} dans ${phrase(s)}`,
    press: (name, s) => (s ? `Appuyer sur ${key(name)} dans ${phrase(s)}` : `Appuyer sur ${key(name)}`),
    dblclick: (s) => `Double-cliquer sur ${phrase(s)}`,
    setInputFiles: (s, files) =>
      files.length === 0
        ? `Vider ${phrase(s)}`
        : `Choisir ${files.length === 1 ? 'le fichier' : 'les fichiers'} ${files.map(quote).join(', ')} dans ${phrase(s)}`,
    dragTo: (s, target) => `Glisser ${phrase(s)} sur ${phrase(target)}`,
    manual: (description) => `À la main${NBSP}: ${description}`,
  },
  expectation(s, e, negated) {
    const should = negated ? 'ne devrait pas' : 'devrait';
    const [text, n] = subject(s);
    switch (e.matcher) {
      case 'text':
        return `${text} ${should} afficher ${quote(e.expected)}`;
      case 'value':
        return `${text} ${should} avoir la valeur ${quote(e.expected)}`;
      case 'name':
        return `${text} ${should} s’appeler ${quote(e.expected)}`;
      case 'url':
        return `la page ${should} être ${markdownCode(e.expected)}`;
      case 'contains':
        return `${text} ${should} contenir ${quote(e.expected)}`;
      case 'count':
        return `${text} ${should} correspondre à ${plural(e.count, 'élément', 'éléments')}`;
      case 'state':
        return `${text} ${should} être ${STATES[e.state][n.gender === 'feminine' ? 1 : 0]}`;
    }
  },
  evidence: (c) =>
    [
      c.screenshots > 0 ? plural(c.screenshots, 'capture d’écran', 'captures d’écran') : 'aucune capture d’écran',
      ...(c.stepShots > 0 ? [plural(c.stepShots, 'capture d’étape', 'captures d’étapes')] : []),
      ...(c.consoleErrors > 0 ? [plural(c.consoleErrors, 'erreur de console', 'erreurs de console')] : []),
      ...(c.consoleWarnings > 0
        ? [plural(c.consoleWarnings, 'avertissement de console', 'avertissements de console')]
        : []),
      ...(c.failedRequests > 0 ? [plural(c.failedRequests, 'requête en échec', 'requêtes en échec')] : []),
      ...(c.outline ? ['plan de la page'] : []),
    ].join(' · '),
  report: {
    untitled: 'Bug signalé',
    titleOnPage: (pageKey) => `Bug sur ${pageKey}`,
    pageLabel: '**Page**',
    pathOn: (path, origin) => `${path} sur ${origin}`,
    stepsHeading: 'Étapes pour reproduire',
    noSteps: 'Aucune étape n’a été enregistrée.',
    actual: (v) => `Résultat${NBSP}: ${v}`,
    note: (text) => `Note${NBSP}: ${text}`,
    viewport: (size, zoom) =>
      `Fenêtre à partir de cette étape${NBSP}: ${size}${zoom != null ? `, zoom à ${percent(zoom)}` : ''}`,
    failedInRun: 'Le test a échoué ici dans l’exécution dont ce rapport est tiré',
    expectedHeading: 'Attendu et constaté',
    nothingMarked: 'Rien n’a été marqué comme incorrect.',
    expectedLine: (step, expectation, actual) =>
      `Étape ${step}${NBSP}: ${expectation}.${actual != null ? ` Résultat${NBSP}: ${actual}.` : ''}`,
    evidenceHeading: 'Éléments recueillis',
    screenshotsHeading: 'Captures d’écran',
    screenshotAfterStep: (step) => `après l’étape ${step}`,
    screenshotAtFinish: 'à la fin du rapport',
    screenshotByHand: 'prise à la main',
    noScreenshot: (reason) => `Aucune capture d’écran${NBSP}: ${reason}`,
    consoleHeading: (shown, total) => `Console (${ofTotal(shown, total)})`,
    consoleLine: (e) => {
      const what =
        e.source === 'rejection'
          ? 'promesse rejetée non gérée'
          : e.level === 'error'
            ? e.source === 'error'
              ? 'erreur non interceptée'
              : 'erreur'
            : 'avertissement';
      return `${what} sur ${e.page} à ${e.time}${NBSP}: ${e.message}`;
    },
    requestsHeading: (shown, total) => `Requêtes en échec (${ofTotal(shown, total)})`,
    requestLine: (r) =>
      `${r.request} → ${r.status > 0 ? String(r.status) : 'pas de réponse'}, sur ${r.page} à ${r.time}`,
    outlineHeading: 'Plan de la page',
    outlineNote: `Construit par Piwi Picker à partir de la page${NNBSP}; la forme YAML d’un instantané ARIA, pas celui de Playwright.`,
    notReplayedHeading: 'Non rejoué',
    notReplayedNote: `Appels du test que ces étapes laissent de côté${NBSP}: ni Replay ni le test généré ne les exécutent.`,
    notReplayedLine: (e) => `${e.call}${e.location ? ` à ${e.location}` : ''}${NBSP}: ${e.reason}`,
  },
};
