/**
 * The inputs of the change-time detectors (`detectNewErrorPath`,
 * `detectIntentWithoutTest`, `detectNewControl`), read from a pull request's
 * patches and title. Pure: the server's change coverage feeds them the diff, the
 * route and page nodes, the statuses observed and the project's tests.
 */

/** The added lines of a unified-diff patch, without their `+`. */
export function addedLines(patch: string): string[] {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

/** Words on a line that say it answers with a status or throws. */
const ERROR_CONTEXT =
  /status|createError|throw|HttpException|HTTPException|abort\(|reply\.code|Results\.|Problem\(|StatusCode/i;

/** ASP.NET Core's named results and the status each answers with. */
const NAMED_RESULTS: Record<string, number> = {
  BadRequest: 400,
  Unauthorized: 401,
  Forbid: 403,
  NotFound: 404,
  Conflict: 409,
  UnprocessableEntity: 422,
  ValidationProblem: 400,
};
const NAMED_RESULT = new RegExp(`\\b(${Object.keys(NAMED_RESULTS).join('|')})\\(`, 'g');

/**
 * The error statuses (400 to 599) a patch's added lines answer with or throw:
 * a number on a line that sets a status or throws (`createError({ statusCode: 409 })`,
 * `res.status(422)`, `setResponseStatus(event, 403)`), or an ASP.NET Core named
 * result (`Results.Conflict()`). Sorted, each once.
 */
export function addedErrorStatuses(patch: string): number[] {
  const found = new Set<number>();
  for (const line of addedLines(patch)) {
    for (const m of line.matchAll(NAMED_RESULT)) found.add(NAMED_RESULTS[m[1]!]!);
    if (!ERROR_CONTEXT.test(line)) continue;
    for (const m of line.matchAll(/\b([45]\d\d)\b/g)) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** Words too common in a change's title to say what it is about. */
const STOP_WORDS = new Set(
  (
    'about above after again also allow allows always and another any are around because been before being ' +
    'between both bump can cannot change changed changes chore could does done down during each else ensure ' +
    'every feat feature first fix fixed fixes for from have here into just keep last like make makes many more ' +
    'most move must need never new none not now only other over refactor remove removed rename should show ' +
    'since some still such support than that the their them then there these they this those through to too ' +
    'under until update updated updates use used uses using very via want was were what when where which while ' +
    'will with without would wrong your'
  ).split(' '),
);

/**
 * The words a change's title is about: lower case, without its conventional
 * prefix (`fix(api):`), its ticket ids and common words, four letters at least,
 * each once.
 */
export function intentWords(title: string): string[] {
  const text = title
    .replace(/^\s*\w+(\([^)]*\))?!?:\s*/, '')
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, ' ')
    .replace(/#\d+/g, ' ')
    .toLowerCase();
  const words = text.split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/**
 * Whether a test mentions the change: one test's title, tags or feature holds at
 * least half of the title's words (one at least). A title with no word to match
 * reads as matched, since nothing says it is not.
 */
export function intentMatchedByTests(words: readonly string[], testTexts: readonly string[]): boolean {
  if (words.length === 0) return true;
  const needed = Math.ceil(words.length / 2);
  return testTexts.some((text) => {
    const tokens = new Set(text.toLowerCase().split(/[^a-z]+/));
    return words.filter((w) => tokens.has(w)).length >= needed;
  });
}

/** Template tags that render a control, and the role each names. */
const CONTROL_TAGS: Record<string, string> = {
  button: 'button',
  ubutton: 'button',
  input: 'textbox',
  uinput: 'textbox',
  textarea: 'textbox',
  utextarea: 'textbox',
  select: 'combobox',
  uselect: 'combobox',
  uselectmenu: 'combobox',
  ucheckbox: 'checkbox',
  uswitch: 'switch',
};
const CONTROL_TAG = new RegExp(`<(${Object.keys(CONTROL_TAGS).join('|')})\\b([^>]*)>?([^<]*)`, 'gi');
const NAME_ATTRIBUTE = /(?:^|\s)(?:aria-label|label|placeholder|name|title)\s*=\s*"([^"{}]+)"/i;

/**
 * The controls a template patch adds: a button, field, select or switch on an
 * added line, named by its static `aria-label`, `label`, `placeholder`, `name`
 * or `title` (never a bound `:label`), else its text. A control with no name it can read is left out. Each
 * once, as `role "name"`.
 */
export function addedControls(patch: string): string[] {
  const found = new Set<string>();
  for (const line of addedLines(patch)) {
    for (const m of line.matchAll(CONTROL_TAG)) {
      const role = CONTROL_TAGS[m[1]!.toLowerCase()]!;
      const name = (NAME_ATTRIBUTE.exec(m[2] ?? '')?.[1] ?? m[3] ?? '').trim();
      if (!name || /[{}]/.test(name)) continue;
      found.add(`${role} "${name}"`);
    }
  }
  return [...found];
}
