import type { BugPhrases, BugState, BugStepValue, BugSubject, RoleNoun } from './bug-phrases';
import { markdownCode } from './markdown-code';
import { keyCombo } from './key-combo';

/** ARIA roles in the words of a Spanish interface, with their gender. One Spanish for Spain and Latin America. */
const ROLES: Readonly<Record<string, RoleNoun>> = {
  alert: { noun: 'mensaje de alerta', gender: 'masculine' },
  alertdialog: { noun: 'cuadro de diálogo', gender: 'masculine' },
  article: { noun: 'artículo', gender: 'masculine' },
  banner: { noun: 'encabezado', gender: 'masculine' },
  button: { noun: 'botón', gender: 'masculine' },
  cell: { noun: 'celda de tabla', gender: 'feminine' },
  checkbox: { noun: 'casilla de verificación', gender: 'feminine' },
  columnheader: { noun: 'encabezado de columna', gender: 'masculine' },
  combobox: { noun: 'lista desplegable', gender: 'feminine' },
  contentinfo: { noun: 'pie de página', gender: 'masculine' },
  dialog: { noun: 'cuadro de diálogo', gender: 'masculine' },
  form: { noun: 'formulario', gender: 'masculine' },
  generic: { noun: 'elemento', gender: 'masculine' },
  grid: { noun: 'tabla', gender: 'feminine' },
  gridcell: { noun: 'celda de tabla', gender: 'feminine' },
  heading: { noun: 'título', gender: 'masculine' },
  img: { noun: 'imagen', gender: 'feminine' },
  link: { noun: 'enlace', gender: 'masculine' },
  list: { noun: 'lista', gender: 'feminine' },
  listbox: { noun: 'lista', gender: 'feminine' },
  listitem: { noun: 'elemento de lista', gender: 'masculine' },
  main: { noun: 'contenido principal', gender: 'masculine' },
  menu: { noun: 'menú', gender: 'masculine' },
  menubar: { noun: 'barra de menús', gender: 'feminine' },
  menuitem: { noun: 'elemento de menú', gender: 'masculine' },
  menuitemcheckbox: { noun: 'elemento de menú', gender: 'masculine' },
  menuitemradio: { noun: 'elemento de menú', gender: 'masculine' },
  navigation: { noun: 'navegación', gender: 'feminine' },
  option: { noun: 'opción', gender: 'feminine' },
  paragraph: { noun: 'párrafo', gender: 'masculine' },
  progressbar: { noun: 'barra de progreso', gender: 'feminine' },
  radio: { noun: 'botón de opción', gender: 'masculine' },
  radiogroup: { noun: 'grupo de botones de opción', gender: 'masculine' },
  region: { noun: 'sección', gender: 'feminine' },
  row: { noun: 'fila de tabla', gender: 'feminine' },
  rowheader: { noun: 'encabezado de fila', gender: 'masculine' },
  search: { noun: 'zona de búsqueda', gender: 'feminine' },
  searchbox: { noun: 'campo de búsqueda', gender: 'masculine' },
  slider: { noun: 'control deslizante', gender: 'masculine' },
  spinbutton: { noun: 'campo numérico', gender: 'masculine' },
  status: { noun: 'mensaje de estado', gender: 'masculine' },
  switch: { noun: 'interruptor', gender: 'masculine' },
  tab: { noun: 'pestaña', gender: 'feminine' },
  table: { noun: 'tabla', gender: 'feminine' },
  tablist: { noun: 'lista de pestañas', gender: 'feminine' },
  tabpanel: { noun: 'panel de pestaña', gender: 'masculine' },
  textbox: { noun: 'campo de texto', gender: 'masculine' },
  toolbar: { noun: 'barra de herramientas', gender: 'feminine' },
  tooltip: { noun: 'descripción emergente', gender: 'feminine' },
  tree: { noun: 'árbol', gender: 'masculine' },
  treeitem: { noun: 'elemento de árbol', gender: 'masculine' },
};

const ELEMENT: RoleNoun = { noun: 'elemento', gender: 'masculine' };
/** In "Marcar la casilla «Acepto»", a checkbox is a "casilla". */
const BOX: RoleNoun = { noun: 'casilla', gender: 'feminine' };

const roleNoun = (role: string | null): RoleNoun =>
  role ? (ROLES[role] ?? { noun: role, gender: 'masculine' }) : ELEMENT;

/** `el botón`, `la casilla`: the definite article, from the noun's gender. */
const definite = (n: RoleNoun): string => `${n.gender === 'feminine' ? 'la' : 'el'} ${n.noun}`;

/** Spanish quotes, with no space inside. */
const quote = (text: string): string => `«${text}»`;

/** The subject as a noun phrase with its article, and the gender an adjective about it takes. */
function subject(s: BugSubject, nounFor: (role: string | null) => RoleNoun = roleNoun): [string, RoleNoun] {
  switch (s.kind) {
    case 'page':
      return ['la página', { noun: 'página', gender: 'feminine' }];
    case 'named': {
      const n = nounFor(s.role);
      return [`${definite(n)} ${quote(s.name)}`, n];
    }
    case 'name':
      return [quote(s.name), ELEMENT];
    case 'testId':
      return [`el elemento con el test id ${markdownCode(s.testId)}`, ELEMENT];
    case 'text': {
      const n = nounFor(s.role);
      return [`${definite(n)} ${quote(s.text)}`, n];
    }
    case 'locator':
      return [`el elemento ${markdownCode(s.locator)}`, ELEMENT];
    case 'element': {
      if (s.role) {
        const n = nounFor(s.role);
        return [definite(n), n];
      }
      if (s.tagName) return [`el elemento ${markdownCode(s.tagName)}`, ELEMENT];
      return [s.definite ? 'el elemento' : 'un elemento', ELEMENT];
    }
  }
}

const phrase = (s: BugSubject): string => subject(s)[0];

/** For check and uncheck: "la casilla «Acepto»" rather than "la casilla de verificación". */
const checkable = (s: BugSubject): string => subject(s, (role) => (role === 'checkbox' ? BOX : roleNoun(role)))[0];

/**
 * Keys by the names Spanish keyboards print on them, in Spain and in Latin
 * America alike; any other key (Enter, Tab, Esc) keeps Playwright's name.
 */
const KEYS: Readonly<Record<string, string>> = {
  ControlOrMeta: 'Ctrl',
  Backspace: 'Retroceso',
  Delete: 'Supr',
  Space: 'Espacio',
  ArrowUp: 'Flecha arriba',
  ArrowDown: 'Flecha abajo',
  ArrowLeft: 'Flecha izquierda',
  ArrowRight: 'Flecha derecha',
  PageUp: 'Re Pág',
  PageDown: 'Av Pág',
  Home: 'Inicio',
  End: 'Fin',
};

const key = (name: string): string => keyCombo(name, (part) => KEYS[part] ?? part);

const value = (v: BugStepValue): string => (v.kind === 'password' ? 'una contraseña (no grabada)' : quote(v.text));

const STATES: Record<BugState, [masculine: string, feminine: string]> = {
  visible: ['visible', 'visible'],
  hidden: ['oculto', 'oculta'],
  enabled: ['habilitado', 'habilitada'],
  disabled: ['deshabilitado', 'deshabilitada'],
  checked: ['marcado', 'marcada'],
};

const number = (n: number): string => new Intl.NumberFormat('es').format(n);
/** Spanish puts only 1 in the singular. */
/** A zoom factor as a percentage, such as `125%`. */
const percent = (zoom: number): string => `${Math.round(zoom * 100)}\u00a0%`;
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n === 1 ? one : many}`;
const ofTotal = (shown: number, total: number | null): string =>
  `${number(shown)}${total != null ? ` de ${number(total)}` : ''}`;

export const SPANISH_BUG_PHRASES: BugPhrases = {
  language: 'es',
  roles: ROLES,
  quote,
  code: markdownCode,
  capitalize: (text) => `${text.charAt(0).toLocaleUpperCase('es')}${text.slice(1)}`,
  steps: {
    goto: (url) => `Abrir ${markdownCode(url)}`,
    click: (s) => `Hacer clic en ${phrase(s)}`,
    hover: (s) => `Pasar el cursor sobre ${phrase(s)}`,
    fill: (s, v) => `Escribir ${value(v)} en ${phrase(s)}`,
    check: (s) => `Marcar ${checkable(s)}`,
    uncheck: (s) => `Desmarcar ${checkable(s)}`,
    selectOption: (s, v) => `Elegir ${value(v)} en ${phrase(s)}`,
    press: (name, s) => (s ? `Presionar ${key(name)} en ${phrase(s)}` : `Presionar ${key(name)}`),
    dblclick: (s) => `Hacer doble clic en ${phrase(s)}`,
    setInputFiles: (s, files) =>
      files.length === 0
        ? `Vaciar ${phrase(s)}`
        : `Elegir ${files.length === 1 ? 'el archivo' : 'los archivos'} ${files.map(quote).join(', ')} en ${phrase(s)}`,
    dragTo: (s, target) => `Arrastrar ${phrase(s)} hasta ${phrase(target)}`,
    manual: (description) => `A mano: ${description}`,
  },
  expectation(s, e, negated) {
    const should = negated ? 'no debería' : 'debería';
    const [text, n] = subject(s);
    switch (e.matcher) {
      case 'text':
        return `${text} ${should} mostrar ${quote(e.expected)}`;
      case 'value':
        return `${text} ${should} tener el valor ${quote(e.expected)}`;
      case 'name':
        return `${text} ${should} llamarse ${quote(e.expected)}`;
      case 'url':
        return `la página ${should} ser ${markdownCode(e.expected)}`;
      case 'contains':
        return `${text} ${should} contener ${quote(e.expected)}`;
      case 'count':
        return `${text} ${should} corresponder a ${plural(e.count, 'elemento', 'elementos')}`;
      case 'state':
        return `${text} ${should} estar ${STATES[e.state][n.gender === 'feminine' ? 1 : 0]}`;
    }
  },
  evidence: (c) =>
    [
      c.screenshots > 0
        ? plural(c.screenshots, 'captura de pantalla', 'capturas de pantalla')
        : 'ninguna captura de pantalla',
      ...(c.stepShots > 0 ? [plural(c.stepShots, 'captura de paso', 'capturas de pasos')] : []),
      ...(c.consoleErrors > 0 ? [plural(c.consoleErrors, 'error de consola', 'errores de consola')] : []),
      ...(c.consoleWarnings > 0
        ? [plural(c.consoleWarnings, 'advertencia de consola', 'advertencias de consola')]
        : []),
      ...(c.failedRequests > 0 ? [plural(c.failedRequests, 'solicitud fallida', 'solicitudes fallidas')] : []),
      ...(c.outline ? ['esquema de la página'] : []),
    ].join(' · '),
  report: {
    untitled: 'Bug notificado',
    titleOnPage: (pageKey) => `Bug en ${pageKey}`,
    pageLabel: '**Página**',
    pathOn: (path, origin) => `${path} en ${origin}`,
    stepsHeading: 'Pasos para reproducirlo',
    noSteps: 'No se grabó ningún paso.',
    actual: (v) => `Resultado: ${v}`,
    note: (text) => `Nota: ${text}`,
    viewport: (size, zoom) => `Ventana desde este paso: ${size}${zoom != null ? `, con zoom al ${percent(zoom)}` : ''}`,
    failedInRun: 'El test falló aquí en la ejecución de la que sale este informe',
    expectedHeading: 'Resultado esperado y obtenido',
    nothingMarked: 'No se marcó nada como incorrecto.',
    expectedLine: (step, expectation, actual) =>
      `Paso ${step}: ${expectation}.${actual != null ? ` Resultado: ${actual}.` : ''}`,
    evidenceHeading: 'Datos recogidos',
    screenshotsHeading: 'Capturas de pantalla',
    screenshotAfterStep: (step) => `después del paso ${step}`,
    screenshotAtFinish: 'al terminar el informe',
    screenshotByHand: 'hecha a mano',
    noScreenshot: (reason) => `Sin captura de pantalla: ${reason}`,
    consoleHeading: (shown, total) => `Consola (${ofTotal(shown, total)})`,
    consoleLine: (e) => {
      const what =
        e.source === 'rejection'
          ? 'promesa rechazada no gestionada'
          : e.level === 'error'
            ? e.source === 'error'
              ? 'error no capturado'
              : 'error'
            : 'advertencia';
      return `${what} en ${e.page} a las ${e.time}: ${e.message}`;
    },
    requestsHeading: (shown, total) => `Solicitudes fallidas (${ofTotal(shown, total)})`,
    requestLine: (r) =>
      `${r.request} → ${r.status > 0 ? String(r.status) : 'sin respuesta'}, en ${r.page} a las ${r.time}`,
    outlineHeading: 'Esquema de la página',
    outlineNote:
      'Creado por Piwi Picker a partir de la página; la forma YAML de una instantánea ARIA, no la de Playwright.',
    notReplayedHeading: 'No reproducido',
    notReplayedNote:
      'Llamadas del test que estos pasos dejan fuera, así que ni Replay ni el test generado las ejecutan:',
    notReplayedLine: (e) => `${e.call}${e.location ? ` en ${e.location}` : ''}: ${e.reason}`,
  },
};
