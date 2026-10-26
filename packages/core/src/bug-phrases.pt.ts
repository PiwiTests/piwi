import type { BugPhrases, BugState, BugStepValue, BugSubject, RoleNoun } from './bug-phrases';
import type { ManualCheckValues } from './recording';
import { markdownCode } from './markdown-code';
import { keyCombo } from './key-combo';

/** ARIA roles in the words of a Brazilian Portuguese interface, with their gender. */
const ROLES: Readonly<Record<string, RoleNoun>> = {
  alert: { noun: 'mensagem de alerta', gender: 'feminine' },
  alertdialog: { noun: 'caixa de diálogo', gender: 'feminine' },
  article: { noun: 'artigo', gender: 'masculine' },
  banner: { noun: 'cabeçalho', gender: 'masculine' },
  button: { noun: 'botão', gender: 'masculine' },
  cell: { noun: 'célula de tabela', gender: 'feminine' },
  checkbox: { noun: 'caixa de seleção', gender: 'feminine' },
  columnheader: { noun: 'cabeçalho de coluna', gender: 'masculine' },
  combobox: { noun: 'lista suspensa', gender: 'feminine' },
  contentinfo: { noun: 'rodapé', gender: 'masculine' },
  dialog: { noun: 'caixa de diálogo', gender: 'feminine' },
  form: { noun: 'formulário', gender: 'masculine' },
  generic: { noun: 'elemento', gender: 'masculine' },
  grid: { noun: 'tabela', gender: 'feminine' },
  gridcell: { noun: 'célula de tabela', gender: 'feminine' },
  heading: { noun: 'título', gender: 'masculine' },
  img: { noun: 'imagem', gender: 'feminine' },
  link: { noun: 'link', gender: 'masculine' },
  list: { noun: 'lista', gender: 'feminine' },
  listbox: { noun: 'lista', gender: 'feminine' },
  listitem: { noun: 'item de lista', gender: 'masculine' },
  main: { noun: 'conteúdo principal', gender: 'masculine' },
  menu: { noun: 'menu', gender: 'masculine' },
  menubar: { noun: 'barra de menus', gender: 'feminine' },
  menuitem: { noun: 'item de menu', gender: 'masculine' },
  menuitemcheckbox: { noun: 'item de menu', gender: 'masculine' },
  menuitemradio: { noun: 'item de menu', gender: 'masculine' },
  navigation: { noun: 'navegação', gender: 'feminine' },
  option: { noun: 'opção', gender: 'feminine' },
  paragraph: { noun: 'parágrafo', gender: 'masculine' },
  progressbar: { noun: 'barra de progresso', gender: 'feminine' },
  radio: { noun: 'botão de opção', gender: 'masculine' },
  radiogroup: { noun: 'grupo de botões de opção', gender: 'masculine' },
  region: { noun: 'seção', gender: 'feminine' },
  row: { noun: 'linha de tabela', gender: 'feminine' },
  rowheader: { noun: 'cabeçalho de linha', gender: 'masculine' },
  search: { noun: 'área de pesquisa', gender: 'feminine' },
  searchbox: { noun: 'campo de pesquisa', gender: 'masculine' },
  slider: { noun: 'controle deslizante', gender: 'masculine' },
  spinbutton: { noun: 'campo numérico', gender: 'masculine' },
  status: { noun: 'mensagem de status', gender: 'feminine' },
  switch: { noun: 'interruptor', gender: 'masculine' },
  tab: { noun: 'aba', gender: 'feminine' },
  table: { noun: 'tabela', gender: 'feminine' },
  tablist: { noun: 'lista de abas', gender: 'feminine' },
  tabpanel: { noun: 'painel de aba', gender: 'masculine' },
  textbox: { noun: 'campo de texto', gender: 'masculine' },
  toolbar: { noun: 'barra de ferramentas', gender: 'feminine' },
  tooltip: { noun: 'dica', gender: 'feminine' },
  tree: { noun: 'árvore', gender: 'feminine' },
  treeitem: { noun: 'item de árvore', gender: 'masculine' },
};

const ELEMENT: RoleNoun = { noun: 'elemento', gender: 'masculine' };
const PAGE: RoleNoun = { noun: 'página', gender: 'feminine' };

const roleNoun = (role: string | null): RoleNoun =>
  role ? (ROLES[role] ?? { noun: role, gender: 'masculine' }) : ELEMENT;

const quote = (text: string): string => `“${text}”`;

type Article = 'definite' | 'indefinite' | null;

/**
 * A subject as Portuguese needs it: the article apart from the rest, since a
 * preposition contracts with it (`em` + `o` = `no`), and the gender its
 * adjectives agree with.
 */
interface Phrase {
  article: Article;
  words: string;
  noun: RoleNoun;
}

function subject(s: BugSubject): Phrase {
  switch (s.kind) {
    case 'page':
      return { article: 'definite', words: 'página', noun: PAGE };
    case 'named': {
      const n = roleNoun(s.role);
      return { article: 'definite', words: `${n.noun} ${quote(s.name)}`, noun: n };
    }
    case 'name':
      return { article: null, words: quote(s.name), noun: ELEMENT };
    case 'testId':
      return { article: 'definite', words: `elemento com o test id ${markdownCode(s.testId)}`, noun: ELEMENT };
    case 'text': {
      const n = roleNoun(s.role);
      return { article: 'definite', words: `${n.noun} ${quote(s.text)}`, noun: n };
    }
    case 'locator':
      return { article: 'definite', words: `elemento ${markdownCode(s.locator)}`, noun: ELEMENT };
    case 'element': {
      const article = s.definite ? 'definite' : 'indefinite';
      if (s.role) {
        const n = roleNoun(s.role);
        return { article, words: n.noun, noun: n };
      }
      if (s.tagName) return { article, words: `elemento ${markdownCode(s.tagName)}`, noun: ELEMENT };
      return { article, words: 'elemento', noun: ELEMENT };
    }
  }
}

const feminine = (p: Phrase): boolean => p.noun.gender === 'feminine';

/** `o botão`, `a caixa de seleção`, `um elemento`. */
function bare(p: Phrase): string {
  if (p.article === 'definite') return `${feminine(p) ? 'a' : 'o'} ${p.words}`;
  if (p.article === 'indefinite') return `${feminine(p) ? 'uma' : 'um'} ${p.words}`;
  return p.words;
}

/** After `em`, which contracts with the definite article: `no botão`, `na lista`, `em um elemento`. */
function inside(p: Phrase): string {
  if (p.article === 'definite') return `${feminine(p) ? 'na' : 'no'} ${p.words}`;
  return `em ${bare(p)}`;
}

/** Keys by the names Brazilian (ABNT2) keyboards print on them; any other key keeps Playwright's name. */
const KEYS: Readonly<Record<string, string>> = {
  ControlOrMeta: 'Ctrl',
  Escape: 'Esc',
  Space: 'Espaço',
  ArrowUp: 'Seta para cima',
  ArrowDown: 'Seta para baixo',
  ArrowLeft: 'Seta para a esquerda',
  ArrowRight: 'Seta para a direita',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

const key = (name: string): string => keyCombo(name, (part) => KEYS[part] ?? part);

const value = (v: BugStepValue): string => (v.kind === 'password' ? 'uma senha (não gravada)' : quote(v.text));

const STATES: Record<BugState, [masculine: string, feminine: string]> = {
  visible: ['visível', 'visível'],
  hidden: ['oculto', 'oculta'],
  enabled: ['habilitado', 'habilitada'],
  disabled: ['desabilitado', 'desabilitada'],
  checked: ['marcado', 'marcada'],
};

const number = (n: number): string => new Intl.NumberFormat('pt-BR').format(n);

/** `; na execução, esperava X e recebeu Y`, as much as the run says. */
function inRun(c: ManualCheckValues): string {
  const parts = [c.expected ? `esperava ${c.expected}` : null, c.received ? `recebeu ${c.received}` : null].filter(
    Boolean,
  );
  return parts.length > 0 ? `; na execução, ${parts.join(' e ')}` : '';
}
/** Brazilian Portuguese puts 0 and 1 in the singular. */
/** A zoom factor as a percentage, such as `125%`. */
const percent = (zoom: number): string => `${Math.round(zoom * 100)}%`;
const plural = (n: number, one: string, many: string): string => `${number(n)} ${n < 2 ? one : many}`;
const ofTotal = (shown: number, total: number | null): string =>
  `${number(shown)}${total != null ? ` de ${number(total)}` : ''}`;

export const PORTUGUESE_BUG_PHRASES: BugPhrases = {
  language: 'pt-BR',
  roles: ROLES,
  quote,
  code: markdownCode,
  key,
  capitalize: (text) => `${text.charAt(0).toLocaleUpperCase('pt-BR')}${text.slice(1)}`,
  steps: {
    goto: (url) => `Abrir ${markdownCode(url)}`,
    click: (s) => `Clicar ${inside(subject(s))}`,
    hover: (s) => `Passar o mouse sobre ${bare(subject(s))}`,
    fill: (s, v) => `Digitar ${value(v)} ${inside(subject(s))}`,
    check: (s) => `Marcar ${bare(subject(s))}`,
    uncheck: (s) => `Desmarcar ${bare(subject(s))}`,
    selectOption: (s, v) => `Escolher ${value(v)} ${inside(subject(s))}`,
    press: (name, s) => (s ? `Pressionar ${key(name)} ${inside(subject(s))}` : `Pressionar ${key(name)}`),
    dblclick: (s) => `Clicar duas vezes ${inside(subject(s))}`,
    setInputFiles: (s, files) =>
      files.length === 0
        ? `Esvaziar ${bare(subject(s))}`
        : `Escolher ${files.length === 1 ? 'o arquivo' : 'os arquivos'} ${files.map(quote).join(', ')} ${inside(subject(s))}`,
    dragTo: (s, target) => `Arrastar ${bare(subject(s))} até ${bare(subject(target))}`,
    manual: (description) => `Manualmente: ${description}`,
  },
  manualInstructions: {
    goBack: () => 'Voltar à página anterior no navegador',
    goForward: () => 'Avançar para a próxima página no navegador',
    reload: () => 'Recarregar a página',
    gotoUnknown: () => 'Abrir a página que o teste abriu; a execução não guarda qual',
    setContent: () => `Abrir a página que o próprio teste escreve (${markdownCode('page.setContent')})`,
    keyboardType: () => 'Digitar no teclado o que o teste digitou; o valor está no código do teste',
    mouseAt: (i) =>
      `Fazer com o mouse o que o teste fez no ponto (${number(i.x)}, ${number(i.y)}) da página: ${i.call}`,
    mouseOrKeyboard: (i) => `Fazer com o mouse ou o teclado o que o teste fez: ${i.call}`,
    failedCall: (i) => `Fazer o que o teste fazia quando falhou: ${i.call}`,
    locatorCall: (i) => `Fazer em ${markdownCode(i.locator)} o que o teste fez: ${i.call}`,
    fillUnknown: (i) => `Preencher ${markdownCode(i.locator)} como o teste fez; a execução não guarda o valor`,
    fillPartial: (i) =>
      `Preencher ${markdownCode(i.locator)} como o teste fez; a execução guarda só uma parte do valor`,
    pressUnknown: (i) => `Pressionar em ${markdownCode(i.locator)} a tecla que o teste pressionou`,
    selectOptionUnknown: (i) =>
      `Escolher em ${markdownCode(i.locator)} a opção que o teste escolheu; a execução não guarda qual`,
    selectOptions: (i) =>
      `Escolher em ${markdownCode(i.locator)} ${i.options
        .map((o) => (typeof o === 'number' ? `a opção no índice ${number(o)}` : quote(o)))
        .join(' e ')}`,
    setInputFiles: (i) =>
      `Escolher em ${markdownCode(i.locator)} o arquivo que o teste escolheu; a execução não guarda o nome dele`,
    dragTo: (i) => `Arrastar ${markdownCode(i.locator)} até onde o teste o soltou; a execução não guarda onde`,
    drop: (i) => `Soltar sobre ${markdownCode(i.locator)} os arquivos ou dados que o teste soltou`,
    focus: (i) => `Colocar o foco em ${markdownCode(i.locator)}`,
    blur: (i) => `Tirar o foco de ${markdownCode(i.locator)}`,
    dispatchEvent: (i) => `Fazer em ${markdownCode(i.locator)} o que dispara o evento que o teste enviou`,
    scrollIntoViewIfNeeded: (i) => `Rolar a página até ${markdownCode(i.locator)}`,
    expectPoll: (i) => `Verificar o que o teste verificava repetidamente (${i.matcher})${inRun(i)}`,
    expectValue: (i) => `Verificar o que o teste verificou: ${i.what}${inRun(i)}`,
    expectLocator: (i) => `Verificar ${markdownCode(i.locator)} com ${i.matcher}${inRun(i)}`,
    expectURL: (i) => `Verificar o endereço da página (toHaveURL)${inRun(i)}`,
    leadingSteps: (i) =>
      `Fazer os primeiros ${number(i.count)} passos do teste, até onde começa o passo ${number(i.count + 1)}: um arquivo de passos contém no máximo ${number(i.limit)} passos`,
  },
  expectation(s, e, negated) {
    const should = negated ? 'não deveria' : 'deveria';
    const p = subject(s);
    const text = bare(p);
    switch (e.matcher) {
      case 'text':
        return `${text} ${should} mostrar ${quote(e.expected)}`;
      case 'value':
        return `${text} ${should} ter o valor ${quote(e.expected)}`;
      case 'name':
        return `${text} ${should} se chamar ${quote(e.expected)}`;
      case 'url':
        return `a página ${should} ser ${markdownCode(e.expected)}`;
      case 'contains':
        return `${text} ${should} conter ${quote(e.expected)}`;
      case 'count':
        return `${text} ${should} corresponder a ${plural(e.count, 'elemento', 'elementos')}`;
      case 'state':
        return `${text} ${should} estar ${STATES[e.state][feminine(p) ? 1 : 0]}`;
    }
  },
  evidence: (c) =>
    [
      c.screenshots > 0 ? plural(c.screenshots, 'captura de tela', 'capturas de tela') : 'nenhuma captura de tela',
      ...(c.stepShots > 0 ? [plural(c.stepShots, 'captura de passo', 'capturas de passos')] : []),
      ...(c.consoleErrors > 0 ? [plural(c.consoleErrors, 'erro de console', 'erros de console')] : []),
      ...(c.consoleWarnings > 0 ? [plural(c.consoleWarnings, 'aviso de console', 'avisos de console')] : []),
      ...(c.failedRequests > 0 ? [plural(c.failedRequests, 'requisição com falha', 'requisições com falha')] : []),
      ...(c.outline ? ['estrutura da página'] : []),
    ].join(' · '),
  report: {
    untitled: 'Bug relatado',
    titleOnPage: (pageKey) => `Bug em ${pageKey}`,
    pageLabel: '**Página**',
    pathOn: (path, origin) => `${path} em ${origin}`,
    stepsHeading: 'Passos para reproduzir',
    noSteps: 'Nenhum passo foi gravado.',
    actual: (v) => `Resultado: ${v}`,
    note: (text) => `Observação: ${text}`,
    viewport: (size, zoom) =>
      `Janela a partir deste passo: ${size}${zoom != null ? `, com zoom de ${percent(zoom)}` : ''}`,
    failedInRun: 'O teste falhou aqui na execução da qual este relatório foi gerado',
    expectedHeading: 'Esperado e obtido',
    nothingMarked: 'Nada foi marcado como errado.',
    expectedLine: (step, expectation, actual) =>
      `Passo ${step}: ${expectation}.${actual != null ? ` Resultado: ${actual}.` : ''}`,
    evidenceHeading: 'Evidências',
    screenshotsHeading: 'Capturas de tela',
    screenshotAfterStep: (step) => `depois do passo ${step}`,
    screenshotAtFinish: 'ao concluir o relatório',
    screenshotByHand: 'feita manualmente',
    noScreenshot: (reason) => `Sem captura de tela: ${reason}`,
    consoleHeading: (shown, total) => `Console (${ofTotal(shown, total)})`,
    consoleLine: (e) => {
      const what =
        e.source === 'rejection'
          ? 'promise rejeitada sem tratamento'
          : e.level === 'error'
            ? e.source === 'error'
              ? 'erro não capturado'
              : 'erro'
            : 'aviso';
      return `${what} em ${e.page} às ${e.time}: ${e.message}`;
    },
    requestsHeading: (shown, total) => `Requisições com falha (${ofTotal(shown, total)})`,
    requestLine: (r) => `${r.request} → ${r.status > 0 ? String(r.status) : 'sem resposta'}, em ${r.page} às ${r.time}`,
    outlineHeading: 'Estrutura da página',
    outlineNote:
      'Gerada pelo Piwi Picker a partir da página; a forma YAML de um snapshot ARIA, não a do próprio Playwright.',
    notReplayedHeading: 'Não reproduzido',
    notReplayedNote:
      'Chamadas do teste que estes passos deixam de fora, então nem o Replay nem o teste gerado as executam:',
    notReplayedLine: (e) => `${e.call}${e.location ? ` em ${e.location}` : ''}: ${e.reason}`,
  },
};
