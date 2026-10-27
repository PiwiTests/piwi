/**
 * The budgets the two failure pages are held to, and the arguments of the
 * script that measures them (`npm run app:measure`). Pure: no Node import and
 * no browser, so the measurement script and its unit test share every rule.
 *
 * A budget is set at one viewport, 1280×800, and read from one measured result
 * (the object `measurePage` returns, plus its route): the text styles of the
 * situation block, the controls of the navbar and the situation block, the
 * distance between the Next step's button and the change it copies, and the
 * solid primary buttons above the fold.
 *
 * The controls budget counts what the page opens on, not what the fold cuts:
 * the blocks under the situation block (the evidence card's tabs, the
 * timeline's toolbar, the affected tests, the history strip) belong on the
 * first screen when the block leaves room for them, so their controls above
 * the fold are reported, not budgeted.
 */

/** The viewport the budgets are set at; any other viewport is reported without verdicts. */
export const BUDGET_VIEWPORT = { width: 1280, height: 800 };

/**
 * The routes measured by default: executions with a diagnosed patch (#37), a
 * broken locator (#13), a cluster without a ticket (#87), a pass on retry
 * (#768) and a test that did not run (#748), then four clusters.
 */
export const DEFAULT_ROUTES = [
  '/test-run-cases/37',
  '/test-run-cases/13',
  '/test-run-cases/87',
  '/test-run-cases/768',
  '/test-run-cases/748',
  '/failure-clusters/10',
  '/failure-clusters/2',
  '/failure-clusters/5',
  '/failure-clusters/1',
];

/**
 * The port of the server the script boots when it is not given `--url`: off
 * 3000 (the dev server) and off 3050 (the screenshot harness's), so a
 * measurement and a screenshot run can go side by side.
 */
export const DEFAULT_MEASURE_PORT = 3060;

/**
 * The Next actions that copy something, by the id the button carries
 * (`data-next-action`). A `budgeted` action copies a code change (an apply
 * command, a locator), which the page shows in the situation block itself; a
 * `reported` one copies a command whose distance is printed without a verdict.
 * Every `copy-…` primary of `shared/next-step.ts` is listed here, which a unit
 * test checks.
 */
export const NEXT_STEP_COPIES = {
  'copy-git-apply': 'budgeted',
  'copy-locator': 'budgeted',
  'copy-recipe': 'reported',
  'copy-flake-command': 'reported',
};

/** `execution` for `/test-run-cases/…`, `cluster` for `/failure-clusters/…`, otherwise null. */
export function pageKind(route) {
  const path = String(route).split(/[?#]/)[0];
  if (path.startsWith('/test-run-cases/')) return 'execution';
  if (path.startsWith('/failure-clusters/')) return 'cluster';
  return null;
}

/**
 * Every budget: the pages it applies to, how it reads its value from a
 * measured result, and the highest value that passes.
 */
export const DETAIL_PAGE_BUDGETS = [
  {
    id: 'text-styles',
    label: 'text styles',
    pages: ['execution'],
    read: (result) => result.distinctTextStyles,
    max: 15,
    missing: 'no situation block',
  },
  {
    id: 'text-styles',
    label: 'text styles',
    pages: ['cluster'],
    read: (result) => result.distinctTextStyles,
    max: 13,
    missing: 'no situation block',
  },
  {
    id: 'navbar-block-controls',
    label: 'controls in the navbar and block',
    pages: ['execution', 'cluster'],
    read: (result) => (result.blockControls == null ? null : result.navbarControls + result.blockControls),
    max: 25,
    missing: 'no situation block',
  },
  {
    id: 'next-content-distance',
    label: 'next-step content',
    pages: ['execution', 'cluster'],
    read: (result) => result.nextStep?.distance ?? null,
    max: 0,
  },
  {
    id: 'solid-primary-above-fold',
    label: 'solid primary buttons',
    pages: ['execution', 'cluster'],
    read: (result) => result.solidPrimaryAboveFold,
    max: 1,
  },
];

const AT_VIEWPORT = `budgets are set at ${BUDGET_VIEWPORT.width}×${BUDGET_VIEWPORT.height}`;

/** How far below the Next button the copied content sits, in words. */
export function distanceText(distance) {
  if (distance == null) return 'not on the page';
  if (distance === 0) return 'in the block';
  return `${distance.toLocaleString('en-US').replace(/,/g, ' ')} px below`;
}

function verdictOf(value, max) {
  return value <= max ? 'pass' : 'fail';
}

function evaluateDistance(budget, result) {
  const base = { id: budget.id, label: budget.label, max: budget.max };
  const next = result.nextStep;
  if (!next) return { ...base, value: null, verdict: 'n/a', note: 'no next step' };
  const copies = NEXT_STEP_COPIES[next.action];
  if (!copies) return { ...base, value: null, verdict: 'n/a', note: `${next.action ?? 'its action'} copies nothing` };
  const value = budget.read(result);
  if (copies === 'reported') return { ...base, value, verdict: 'n/a', note: `${next.action} is reported only` };
  if (value == null) return { ...base, value, verdict: 'fail', note: 'not on the page' };
  return { ...base, value, verdict: verdictOf(value, budget.max), note: distanceText(value) };
}

/**
 * The verdict of every budget that applies to a measured result:
 * `[{ id, label, value, max, verdict: 'pass' | 'fail' | 'n/a', note }]`.
 * A route that is not a failure page has none; a route that answered an error
 * fails as a whole, since the seeded ids it names have moved.
 */
export function evaluateBudgets(result, viewport) {
  const kind = pageKind(result.route);
  if (!kind) return [];
  if (result.httpStatus != null && result.httpStatus >= 400) {
    return [
      {
        id: 'route',
        label: 'route',
        value: result.httpStatus,
        max: null,
        verdict: 'fail',
        note: `the route answered ${result.httpStatus}`,
      },
    ];
  }
  const atBudgetViewport = viewport.width === BUDGET_VIEWPORT.width && viewport.height === BUDGET_VIEWPORT.height;
  return DETAIL_PAGE_BUDGETS.filter((budget) => budget.pages.includes(kind)).map((budget) => {
    const base = { id: budget.id, label: budget.label, max: budget.max };
    if (!atBudgetViewport) return { ...base, value: budget.read(result) ?? null, verdict: 'n/a', note: AT_VIEWPORT };
    if (budget.id === 'next-content-distance') return evaluateDistance(budget, result);
    const value = budget.read(result);
    if (value == null) return { ...base, value: null, verdict: 'n/a', note: budget.missing ?? 'not measured' };
    return { ...base, value, verdict: verdictOf(value, budget.max), note: null };
  });
}

/** One verdict as the report prints it: `✗ controls in the navbar and block 27 > 25`, `✓ text styles 14 ≤ 15`. */
export function budgetText(budget) {
  const mark = budget.verdict === 'pass' ? '✓' : budget.verdict === 'fail' ? '✗' : '·';
  if (budget.id === 'route') return `${mark} ${budget.note}`;
  if (budget.id === 'next-content-distance') {
    if (budget.verdict === 'n/a') return `${mark} ${budget.label} n/a (${budget.note})`;
    return `${mark} ${budget.label} ${budget.note}`;
  }
  if (budget.verdict === 'n/a') return `${mark} ${budget.label} ${budget.value ?? '—'} (${budget.note})`;
  return `${mark} ${budget.label} ${budget.value} ${budget.verdict === 'pass' ? '≤' : '>'} ${budget.max}`;
}

/**
 * The script's flags. Throws on an unknown flag, a route that is not an
 * absolute path, a viewport or port that is not a positive integer, or both a
 * server to drive (`--url`) and a build to boot (`--build`).
 */
export function parseMeasureArgs(argv) {
  const flags = {
    url: null,
    build: null,
    routes: DEFAULT_ROUTES,
    width: BUDGET_VIEWPORT.width,
    height: BUDGET_VIEWPORT.height,
    port: DEFAULT_MEASURE_PORT,
    json: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') flags.url = String(argv[++i] ?? '');
    else if (arg === '--build') flags.build = String(argv[++i] ?? '');
    else if (arg === '--routes')
      flags.routes = String(argv[++i] ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    else if (arg === '--width') flags.width = Number(argv[++i]);
    else if (arg === '--height') flags.height = Number(argv[++i]);
    else if (arg === '--port') flags.port = Number(argv[++i]);
    else if (arg === '--json') flags.json = true;
    else if (arg === '--check') flags.check = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  for (const [flag, value] of [
    ['--width', flags.width],
    ['--height', flags.height],
    ['--port', flags.port],
  ]) {
    if (!(Number.isInteger(value) && value > 0)) throw new Error(`${flag} needs a positive integer`);
  }
  if (flags.url !== null && !/^https?:\/\//.test(flags.url)) throw new Error('--url needs an http(s) URL');
  if (flags.build !== null && !flags.build) throw new Error('--build needs the directory of a build (.output)');
  if (flags.url !== null && flags.build !== null) throw new Error('--url and --build cannot be used together');
  if (!flags.routes.length) throw new Error('--routes needs at least one path');
  for (const route of flags.routes) {
    if (!route.startsWith('/')) throw new Error(`--routes needs absolute paths, got "${route}"`);
  }
  return flags;
}
