/**
 * The strings a change removes or renames, read from a unified diff: the
 * anchors Playwright locators find elements by. A lexical scanner reads each
 * changed line, with no parser, so one pass covers JSX, Vue, Svelte, Angular,
 * Razor and plain HTML:
 *
 * - quoted literals (`'…'`, `"…"`, and template literals without `${}`);
 * - the values of the attributes locators read (`aria-label="Pay"`,
 *   `:title="'Pay'"`, `[placeholder]="'Email'"`, `name: 'email'`, the test id
 *   attributes);
 * - text between tags (`>Pay now<`), or a markup line that is only text;
 * - translation values, from a changed line of a locale file, or from a
 *   template whose translation key changed (`t('checkout.pay')`).
 *
 * A token on a removed line with no equal token on an added line of the same
 * hunk is removed. When a removed and an added token of the same kind are the
 * only such pair in the hunk, the change renamed one into the other.
 */

// ── Unified diff ─────────────────────────────────────────────────────────────

/** One changed line: its number in the old file (removed) or the new file (added). */
interface DiffLine {
  line: number;
  text: string;
}

export interface DiffHunk {
  /** First line of the hunk in the old file. */
  oldStart: number;
  /** First line of the hunk in the new file. */
  newStart: number;
  removed: DiffLine[];
  added: DiffLine[];
}

export interface DiffFile {
  /** The file's path after the change (its old path when it was deleted), without `a/` or `b/`. */
  path: string;
  /** The file's path before the change, when it was renamed. */
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  hunks: DiffHunk[];
  /** The git blob id of the file before the change, as the `index` line gives it (abbreviated without `--full-index`). */
  oldBlob?: string;
  /** The git blob id of the file after the change, as the `index` line gives it. */
  newBlob?: string;
}

const RENAME_FROM = `rename from `;
const RENAME_TO = 'rename to ';
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: |$)/i;

/** A blob id of an `index` line, none for the all-zero id of a side that does not exist. */
function blobOf(id: string): string | undefined {
  return /^0+$/.test(id) ? undefined : id.toLowerCase();
}

function stripPrefix(path: string): string {
  const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * Parse the output of `git diff` (any `--unified` context) into files and
 * hunks. Context lines are skipped; binary files have no hunks.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const current = (): DiffFile => {
    if (!file) {
      file = { path: '', status: 'modified', hunks: [] };
      files.push(file);
    }
    return file;
  };
  for (const line of text.split(/\r?\n/)) {
    if (hunk) {
      if (line.startsWith('-') && oldLeft > 0) {
        hunk.removed.push({ line: oldLine++, text: line.slice(1) });
        oldLeft--;
      } else if (line.startsWith('+') && newLeft > 0) {
        hunk.added.push({ line: newLine++, text: line.slice(1) });
        newLeft--;
      } else if ((line.startsWith(' ') || line === '') && oldLeft > 0 && newLeft > 0) {
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      } else if (!line.startsWith('\\')) hunk = null;
      if (hunk && oldLeft === 0 && newLeft === 0) hunk = null;
      if (hunk || !line.startsWith('@@')) continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { oldStart: oldLine, newStart: newLine, removed: [], added: [] };
      current().hunks.push(hunk);
      if (oldLeft === 0 && newLeft === 0) hunk = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      file = { path: m ? stripPrefix(m[2]!) : '', status: 'modified', hunks: [] };
      files.push(file);
    } else if (line.startsWith('--- ')) {
      const f = file && !file.hunks.length ? file : ((file = null), current());
      const old = line.slice(4).trim();
      if (old === '/dev/null') f.status = 'added';
      else if (!f.path) f.path = stripPrefix(old);
    } else if (line.startsWith('+++ ')) {
      const next = line.slice(4).trim();
      if (next === '/dev/null') current().status = 'deleted';
      else current().path = stripPrefix(next);
    } else if (line.startsWith(RENAME_FROM)) {
      current().oldPath = line.slice(RENAME_FROM.length);
      current().status = 'renamed';
    } else if (line.startsWith(RENAME_TO)) current().path = line.slice(RENAME_TO.length);
    else if (INDEX_LINE.test(line)) {
      const [, oldId, newId] = INDEX_LINE.exec(line)!;
      const f = current();
      const oldBlob = blobOf(oldId!);
      const newBlob = blobOf(newId!);
      if (oldBlob) f.oldBlob = oldBlob;
      if (newBlob) f.newBlob = newBlob;
    } else if (line.startsWith('new file mode')) current().status = 'added';
    else if (line.startsWith('deleted file mode')) current().status = 'deleted';
  }
  return files.filter((f) => f.path);
}

/** A file from a provider's per-file `patch` (hunks with no `diff --git` header), as `parseUnifiedDiff` would give it. */
export function diffFileFromPatch(path: string, patch: string, status: DiffFile['status'] = 'modified'): DiffFile {
  const [parsed] = parseUnifiedDiff(`--- a/${path}\n+++ b/${path}\n${patch}`);
  return { path, status, hunks: parsed?.hunks ?? [] };
}

// ── Anchors ──────────────────────────────────────────────────────────────────

type DiffAnchorKind = 'attribute' | 'text' | 'literal' | 'translation';

/** A string a change removed, or renamed into another. */
export interface DiffAnchor {
  /** The changed file, as the diff names it. */
  file: string;
  /** Where the change is in the new file: the added line of a rename, the hunk's position for a removal. */
  line: number;
  /** The removed line in the old file. */
  oldLine: number;
  kind: DiffAnchorKind;
  /** The attribute an `attribute` anchor was the value of. */
  attribute?: string;
  /** The translation key of a `translation` anchor, when known. */
  key?: string;
  before: string;
  /** The string that replaced it, for a one-to-one rename. */
  after?: string;
}

/** Looks up a translation key's value on one side of the change. */
type TranslationLookup = (key: string, side: 'old' | 'new') => string | undefined;

export interface DiffAnchorOptions {
  /** The attributes `getByTestId` reads (Playwright's `testIdAttribute`); `data-testid` by default. */
  testIdAttributes?: string[];
  /** Files skipped entirely, such as the Playwright test directory and the files locators are called from. */
  isTestFile?: (path: string) => boolean;
  /** Globs naming translation files; {@link DEFAULT_TRANSLATION_GLOBS} by default. */
  translationGlobs?: string[];
  /** Resolves the keys of translation calls (`t('checkout.pay')`) whose key a change replaced. */
  translations?: TranslationLookup;
  /**
   * Reads a whole file on one side of the change, so a changed line of a
   * translation file is reported with its full key path (`checkout.coupon.apply`)
   * rather than its last segment.
   */
  readFile?: (path: string, side: 'old' | 'new') => string | undefined;
}

/** Where translation files live unless configured otherwise. */
const DEFAULT_TRANSLATION_GLOBS: readonly string[] = ['**/{locales,locale,i18n,lang,translations}/**', '**/*.resx'];

/** The attributes locators read, besides the test id attributes. */
const ANCHOR_ATTRIBUTES: readonly string[] = [
  'id',
  'name',
  'aria-label',
  'placeholder',
  'alt',
  'title',
  'role',
  'value',
  'label',
];

const TRANSLATION_EXTENSIONS = /\.(json|ya?ml|properties|po|resx)$/i;
const MARKUP_FILE = /\.(vue|svelte|html?|cshtml|razor|hbs|handlebars|jsx|tsx|astro|njk|liquid|erb|php)$/i;
const MIN_LENGTH = 2;
const MAX_LENGTH = 200;

function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1]!
    .split(',')
    .flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as an anchored regex over a POSIX path. */
function pathGlobToRegExp(glob: string): RegExp {
  const parts = expandBraces(glob).map((g) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!;
      if (c === '*') {
        if (g[i + 1] === '*') {
          i++;
          if (g[i + 1] === '/') {
            i++;
            re += '(?:.*/)?';
          } else re += '.*';
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
      else re += c;
    }
    return re;
  });
  return new RegExp(`^(?:${parts.join('|')})$`);
}

/** Whether a path is a translation file under the given globs. */
export function isTranslationFile(path: string, globs: readonly string[] = DEFAULT_TRANSLATION_GLOBS): boolean {
  const posix = path.replace(/\\/g, '/');
  if (!TRANSLATION_EXTENSIONS.test(posix)) return false;
  return globs.some((g) => pathGlobToRegExp(g).test(posix));
}

function keepable(value: string): boolean {
  const v = value.trim();
  if (v.length < MIN_LENGTH || v.length > MAX_LENGTH) return false;
  if (/^[-+]?[\d.,]+$/.test(v)) return false;
  return /\p{L}/u.test(v);
}

interface Token {
  kind: DiffAnchorKind;
  /** Tokens pair into renames only within the same group. */
  group: string;
  value: string;
  attribute?: string;
  key?: string;
  line: number;
}

interface Span {
  start: number;
  end: number;
}

/** A quoted literal starting at `start` (a quote character); null when it does not close on the line. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start]!;
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i++;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') return null;
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Attribute values of the given attributes on a line, in every binding syntax the scanner knows. */
function attributeTokens(text: string, attributes: string[], line: number, spans: Span[]): Token[] {
  const tokens: Token[] = [];
  const names = attributes.map(escapeRegExp).join('|');
  // name="v", name='v', :name="'v'", v-bind:name="'v'", [name]="'v'", [attr.name]="'v'", name={'v'}, name: 'v', "name": "v"
  const re = new RegExp(
    `(?<![\\w-])(?:v-bind:|:|\\[(?:attr\\.)?)?(["']?)(${names})\\1\\]?\\s*(=|:)\\s*(\\{\\s*)?(["'\`])`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const bound = m[0].startsWith(':') || m[0].startsWith('v-bind:') || m[0].startsWith('[');
    const quoteAt = m.index + m[0].length - 1;
    const outer = readQuoted(text, quoteAt);
    if (!outer) continue;
    let value = outer.value;
    if (bound) {
      const inner = /^\s*(['"`])(.*)\1\s*$/.exec(value);
      if (!inner) continue;
      value = inner[2]!;
    }
    spans.push({ start: m.index, end: outer.end });
    re.lastIndex = outer.end;
    if (!keepable(value) || value.includes('${')) continue;
    const attribute = m[2]!;
    tokens.push({ kind: 'attribute', group: `attribute:${attribute}`, value, attribute, line });
  }
  return tokens;
}

/** A key passed to a translation call: `t('k')`, `$t('k')`, `i18n.t('k')`, `translate('k')`, `Localizer["k"]`. */
const TRANSLATION_CALL =
  /(?:(?<![\w$.])(?:\$?t|i18n\.t|translate|formatMessage)\s*\(\s*(?:\{\s*id\s*:\s*)?(['"`])([\w.:-]+)\1|\b\w*[Ll]ocalizer\s*\[\s*"([\w.:-]+)"\s*\])/g;

function translationRefTokens(
  text: string,
  line: number,
  side: 'old' | 'new',
  lookup: TranslationLookup | undefined,
  spans: Span[],
): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TRANSLATION_CALL)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    const key = m[2] ?? m[3]!;
    const value = lookup?.(key, side);
    if (value === undefined || !keepable(value)) continue;
    tokens.push({ kind: 'translation', group: 'translation-ref', value, key, line });
  }
  return tokens;
}

function inSpans(spans: Span[], at: number): boolean {
  return spans.some((s) => at >= s.start && at < s.end);
}

const NON_TEXT_LITERAL =
  /^(?:\.{0,2}\/|[a-z][\w+.-]*:\/\/|#[\w-]+$|@\/|~\/)|\.(?:m?[jt]sx?|vue|svelte|css|scss|json|png|svg|jpe?g)$/i;

/** Quoted literals on a line outside the spans already read, minus imports, paths and translation keys. */
function literalTokens(text: string, line: number, spans: Span[], markup: boolean): Token[] {
  const tokens: Token[] = [];
  if (/^\s*(?:import\b|export\s+\*|\/\/|\*|\/\*|#include|using\s)/.test(text)) return tokens;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    const lit = readQuoted(text, i);
    if (!lit) {
      if (ch === "'") continue; // an apostrophe in prose
      break;
    }
    const start = i;
    i = lit.end - 1;
    if (inSpans(spans, start)) continue;
    const before = text.slice(0, start);
    // In markup, a quoted value after `attr=` belongs to an attribute locators do not read.
    if (markup && /[\w:@.[\]-]=\s*$/.test(before)) continue;
    if (/\b(?:from|require|import)\s*\(?\s*$/.test(before)) continue;
    const value = lit.value;
    if (!keepable(value) || NON_TEXT_LITERAL.test(value)) continue;
    if (/^[\w-]+(?:\.[\w-]+)+$/.test(value) && !/\s/.test(value)) continue;
    tokens.push({ kind: 'literal', group: 'literal', value, line });
  }
  return tokens;
}

const CODE_LINE =
  /^(?:import|export|const|let|var|function|return|if|else|for|while|switch|case|default|class|interface|type|await|async|new|throw|try|catch|public|private|protected|static|using|namespace|@\w+\s*\()\b/;

function textSegment(raw: string, line: number): Token | null {
  const value = raw
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!keepable(value)) return null;
  if (/[{}]|@[\w(]|<%|%>/.test(value)) return null;
  return { kind: 'text', group: 'text', value, line };
}

/** Text between tags on a line, or the whole line when it is bare text inside markup. */
function textTokens(text: string, line: number, markup: boolean): Token[] {
  const tokens: Token[] = [];
  if (!markup) return tokens;
  const trimmed = text.trim();
  if (!trimmed) return tokens;
  if (!/[<>]/.test(trimmed)) {
    if (CODE_LINE.test(trimmed) || /[;=(){}[\]"'`]|^\/\/|^\*|^\/\*|^<!--|[,:]$/.test(trimmed)) return tokens;
    const token = textSegment(trimmed, line);
    return token ? [token] : tokens;
  }
  for (const m of text.matchAll(/>([^<>]+)</g)) {
    const token = textSegment(m[1]!, line);
    if (token) tokens.push(token);
  }
  // Text opening a line and closed by a tag (`Pay now</button>`), or after a tag and running to the end.
  const lead = /^\s*([^<>]+)<\//.exec(text);
  if (lead && !/[=;(){}]/.test(lead[1]!)) {
    const token = textSegment(lead[1]!, line);
    if (token) tokens.push(token);
  }
  const tail = />([^<>]+)$/.exec(text);
  if (tail && !/[=;(){}"']/.test(tail[1]!)) {
    const token = textSegment(tail[1]!, line);
    if (token) tokens.push(token);
  }
  return tokens;
}

// ── Translation files ────────────────────────────────────────────────────────

/** One entry of a translation file. */
export interface TranslationEntry {
  /** Full key path: `checkout.coupon.apply`; a `.po` entry's `msgid`; a `.resx` entry's `name`. */
  key: string;
  value: string;
  /** 1-based line of the value. */
  line: number;
}

function unquoteYaml(raw: string): string {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return v.replace(/\s+#.*$/, '');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The entries of a translation file, by line, for JSON (nested objects),
 * YAML (nested mappings), Java `.properties`, gettext `.po` and .NET `.resx`.
 * The reader is line based: one value per line, as translation files are
 * written; a value spread over several lines is skipped.
 */
export function parseTranslationFile(path: string, content: string): TranslationEntry[] {
  const lines = content.split(/\r?\n/);
  const out: TranslationEntry[] = [];
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === 'json') {
    const stack: Array<{ key: string | number; array: boolean; next: number }> = [];
    const path = (key: string | number) => [...stack.map((f) => f.key), key].join('.');
    lines.forEach((text, i) => {
      const t = text.trim();
      const top = stack[stack.length - 1];
      const pair = /^"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/.exec(t);
      if (pair) {
        const key = JSON.parse(`"${pair[1]}"`) as string;
        const rest = pair[2]!;
        const str = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
        if (str) out.push({ key: path(key), value: JSON.parse(`"${str[1]}"`), line: i + 1 });
        else if (/^[[{]\s*$/.test(rest)) stack.push({ key, array: rest.startsWith('['), next: 0 });
        return;
      }
      if (top?.array) {
        const str = /^"((?:[^"\\]|\\.)*)"\s*,?$/.exec(t);
        if (str) {
          out.push({ key: path(top.next++), value: JSON.parse(`"${str[1]}"`), line: i + 1 });
          return;
        }
        if (/^[[{]\s*$/.test(t)) {
          stack.push({ key: top.next++, array: t === '[', next: 0 });
          return;
        }
      }
      if (/^[\]}]/.test(t)) stack.pop();
    });
    return out;
  }
  if (ext === 'yaml' || ext === 'yml') {
    const stack: Array<{ indent: number; key: string }> = [];
    lines.forEach((text, i) => {
      const m = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*?))\s*:(?:\s+(.*))?$/.exec(text);
      if (!m) return;
      const indent = m[1]!.length;
      const key = (m[2] ?? m[3] ?? m[4]!).trim();
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const raw = m[5]?.trim();
      if (!raw || raw.startsWith('#') || raw === '|' || raw === '>') {
        stack.push({ indent, key });
        return;
      }
      out.push({ key: [...stack.map((s) => s.key), key].join('.'), value: unquoteYaml(raw), line: i + 1 });
    });
    return out;
  }
  if (ext === 'properties') {
    lines.forEach((text, i) => {
      const m = /^\s*([^#!\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(text);
      if (m && !m[2]!.endsWith('\\')) out.push({ key: m[1]!, value: m[2]!, line: i + 1 });
    });
    return out;
  }
  if (ext === 'po') {
    let msgid: string | null = null;
    lines.forEach((text, i) => {
      const id = /^msgid\s+"(.*)"\s*$/.exec(text);
      if (id) {
        msgid = id[1]!.replace(/\\"/g, '"');
        return;
      }
      const str = /^msgstr(?:\[\d+\])?\s+"(.*)"\s*$/.exec(text);
      if (str && msgid) out.push({ key: msgid, value: str[1]!.replace(/\\"/g, '"'), line: i + 1 });
    });
    return out;
  }
  if (ext === 'resx') {
    let name: string | null = null;
    lines.forEach((text, i) => {
      const data = /<data\s+name="([^"]+)"/.exec(text);
      if (data) name = decodeXml(data[1]!);
      const value = /<value>(.*)<\/value>/.exec(text);
      if (value && name) {
        out.push({ key: name, value: decodeXml(value[1]!), line: i + 1 });
        name = null;
      }
    });
    return out;
  }
  return out;
}

/** The key and value a changed line of a translation file holds, read from the line alone. */
function translationLineToken(path: string, text: string, line: number): Token | null {
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  let key: string | undefined;
  let value: string | undefined;
  if (ext === 'json') {
    const pair = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (pair) {
      key = JSON.parse(`"${pair[1]}"`);
      value = JSON.parse(`"${pair[2]}"`);
    } else {
      const item = /^\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/.exec(text);
      if (item) value = JSON.parse(`"${item[1]}"`);
    }
  } else if (ext === 'yaml' || ext === 'yml') {
    const m = /^\s*(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*?))\s*:\s+(.+)$/.exec(text);
    if (m) {
      key = (m[1] ?? m[2] ?? m[3]!).trim();
      value = unquoteYaml(m[4]!);
    }
  } else if (ext === 'properties') {
    const m = /^\s*([^#!\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(text);
    if (m) {
      key = m[1]!;
      value = m[2]!;
    }
  } else if (ext === 'po') {
    const m = /^msg(id|str(?:\[\d+\])?)\s+"(.*)"\s*$/.exec(text);
    if (m) {
      value = m[2]!.replace(/\\"/g, '"');
      if (m[1] === 'id') key = value;
    }
  } else if (ext === 'resx') {
    const m = /<value>(.*)<\/value>/.exec(text);
    if (m) value = decodeXml(m[1]!);
  }
  if (value === undefined || !keepable(value)) return null;
  return { kind: 'translation', group: `translation:${key ?? ''}`, value, key, line };
}

// ── Extraction ───────────────────────────────────────────────────────────────

function lineTokens(
  path: string,
  text: string,
  line: number,
  side: 'old' | 'new',
  attributes: string[],
  options: DiffAnchorOptions,
): Token[] {
  const spans: Span[] = [];
  const markup = MARKUP_FILE.test(path);
  return [
    ...attributeTokens(text, attributes, line, spans),
    ...translationRefTokens(text, line, side, options.translations, spans),
    ...literalTokens(text, line, spans, markup),
    ...textTokens(text, line, markup),
  ];
}

/** Full key paths by line, when the whole file can be read. */
function keysByLine(path: string, side: 'old' | 'new', options: DiffAnchorOptions): Map<number, string> | null {
  const content = options.readFile?.(path, side);
  if (content === undefined) return null;
  return new Map(parseTranslationFile(path, content).map((e) => [e.line, e.key]));
}

function tokenId(t: Token): string {
  return `${t.group}\u0000${t.value}`;
}

/** Removed tokens with no equal added token, and the reverse, with one-to-one renames paired. */
function hunkAnchors(file: string, hunk: DiffHunk, removed: Token[], added: Token[]): DiffAnchor[] {
  const addedLeft = new Map<string, Token[]>();
  for (const t of added) addedLeft.set(tokenId(t), [...(addedLeft.get(tokenId(t)) ?? []), t]);
  const gone: Token[] = [];
  for (const t of removed) {
    const same = addedLeft.get(tokenId(t));
    if (same?.length) same.shift();
    else gone.push(t);
  }
  const fresh = [...addedLeft.values()].flat();
  const anchors: DiffAnchor[] = [];
  const seen = new Set<string>();
  for (const t of gone) {
    const peers = gone.filter((g) => g.group === t.group);
    const replacements = fresh.filter((a) => a.group === t.group);
    const rename = peers.length === 1 && replacements.length === 1 ? replacements[0]! : undefined;
    const anchor: DiffAnchor = {
      file,
      line: rename ? rename.line : Math.max(1, hunk.newStart),
      oldLine: t.line,
      kind: t.kind,
      before: t.value,
    };
    if (t.attribute) anchor.attribute = t.attribute;
    if (t.key) anchor.key = t.key;
    if (rename) anchor.after = rename.value;
    const id = `${anchor.kind}\u0000${anchor.attribute ?? ''}\u0000${anchor.key ?? ''}\u0000${anchor.before}\u0000${anchor.after ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    anchors.push(anchor);
  }
  return anchors;
}

/**
 * The strings each changed file removes or renames. Test files, deleted
 * translation-free lines with no string, strings under two or over 200
 * characters, and pure numbers are left out.
 */
export function extractDiffAnchors(files: DiffFile[], options: DiffAnchorOptions = {}): DiffAnchor[] {
  const attributes = [...new Set([...(options.testIdAttributes ?? ['data-testid']), ...ANCHOR_ATTRIBUTES])];
  const globs = options.translationGlobs ?? DEFAULT_TRANSLATION_GLOBS;
  const anchors: DiffAnchor[] = [];
  for (const file of files) {
    if (options.isTestFile?.(file.path)) continue;
    const translation = isTranslationFile(file.path, globs);
    let oldKeys: Map<number, string> | null | undefined;
    let newKeys: Map<number, string> | null | undefined;
    for (const hunk of file.hunks) {
      let removed: Token[];
      let added: Token[];
      if (translation) {
        oldKeys ??= keysByLine(file.oldPath ?? file.path, 'old', options);
        newKeys ??= keysByLine(file.path, 'new', options);
        const read = (lines: DiffLine[], keys: Map<number, string> | null) =>
          lines.flatMap((l) => {
            const token = translationLineToken(file.path, l.text, l.line);
            if (!token) return [];
            const full = keys?.get(l.line);
            if (full) {
              token.key = full;
              token.group = `translation:${full}`;
            }
            return [token];
          });
        removed = read(hunk.removed, oldKeys);
        added = read(hunk.added, newKeys);
      } else {
        removed = hunk.removed.flatMap((l) => lineTokens(file.path, l.text, l.line, 'old', attributes, options));
        added = hunk.added.flatMap((l) => lineTokens(file.path, l.text, l.line, 'new', attributes, options));
      }
      anchors.push(...hunkAnchors(file.path, hunk, removed, added));
    }
  }
  return anchors;
}
