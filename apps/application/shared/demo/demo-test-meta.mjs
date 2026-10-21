/**
 * Deterministic test tags, `piwi:` ownership metadata and AI-step usage
 * manifests for the demo seed and the run simulator.
 *
 * Both the seed generator (`scripts/generate-demo-seed.mjs`) and the in-browser
 * run simulator (`app/demo/simulator.ts`) derive a test's tags/owner/AI-usage
 * from the same rules, so a simulated run declares exactly what the seeded runs
 * declared and the liveness tab aggregates across both. Pure plain-JS module
 * (runs under Node for the generator and in the browser for the simulator).
 */

/** SHA-256 hex via WebCrypto — available in Node and the browser. */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Test tags and `piwi:` ownership for the demo, derived from the spec's path so
 * the assignment is deterministic and reads like a real suite: a team owns a
 * directory, smoke tests are the first case in each file, and the checkout flow
 * carries the priority that makes the CI gate's `--require-tag` example real.
 */
const DEMO_OWNERS = [
  { match: /\/checkout\//, owner: '@checkout-team', feature: 'Checkout' },
  { match: /\/api\//, owner: '@platform-team', feature: 'API' },
  { match: /\/ui\//, owner: '@design-systems', feature: 'Design system' },
  { match: /\/auth\//, owner: '@identity-team', feature: 'Identity' },
  { match: /\/admin\/login\./, owner: '@identity-team', feature: 'Sign-in' },
  { match: /\/admin\/users\./, owner: '@admin-team', feature: 'Users' },
  { match: /\/admin\/reports\./, owner: '@insights-team', feature: 'Reports' },
  { match: /\/admin\/settings\./, owner: '@admin-team', feature: 'Settings' },
];

export function demoTestMeta(filePath, index) {
  const match = DEMO_OWNERS.find((entry) => entry.match.test(`/${filePath}`));
  if (!match) return null;
  const meta = { owner: match.owner, feature: match.feature };
  // Only the first case of a checkout spec is critical — a suite where
  // everything is critical teaches nothing about filtering.
  if (match.owner === '@checkout-team') meta.priority = index === 0 ? 'critical' : 'high';
  else if (index === 0) meta.priority = 'medium';
  return meta;
}

/** The checkout specs' numbers in the demo's test management tool, for their external IDs. */
const DEMO_EXTERNAL_ID_FILES = new Map([
  ['address.spec.ts', 1],
  ['cart.spec.ts', 2],
  ['checkout.spec.ts', 3],
]);

/**
 * The external ID (`piwi:id`) a demo test has in the demo's test management tool, so the ID chip and the `id:` search
 * have something to show: the checkout specs' tests only, `CHK-<spec><case>` (`CHK-301`), unique per project.
 * Deterministic and path-derived, like `demoTags`, so a simulated run declares the IDs the seed stored.
 */
export function demoExternalId(filePath, index) {
  const match = /\/checkout\/([^/]+)$/.exec(`/${filePath}`);
  const spec = match ? DEMO_EXTERNAL_ID_FILES.get(match[1]) : undefined;
  return spec === undefined ? null : `CHK-${spec}${String(index + 1).padStart(2, '0')}`;
}

export function demoTags(filePath, index) {
  const tags = [];
  if (index === 0) tags.push('smoke');
  if (/\/checkout\//.test(`/${filePath}`)) tags.push('critical');
  if (/\/api\//.test(`/${filePath}`)) tags.push('api');
  if (index % 3 === 0) tags.push('regression');
  return tags;
}

/**
 * Lock names the demo assigns so the timeline's lock lanes and the Locks table
 * have something to draw. Payment writes serialize on a shared `database`; the
 * external payment providers and the API suite serialize on a shared
 * `external-api` sandbox. Deterministic and path-derived, like `demoTags`, so a
 * simulated run declares the same locks the seed did.
 */
export function demoLocks(filePath, index) {
  const p = `/${filePath}`;
  const locks = [];
  if (/\/checkout\/checkout\.spec\.ts$/.test(p)) locks.push('database');
  if (/\/api\//.test(p)) locks.push('external-api');
  // PayPal and Apple Pay also reach the external payment provider.
  if (/\/checkout\/checkout\.spec\.ts$/.test(p) && (index === 1 || index === 2)) locks.push('external-api');
  return locks;
}

const aiUsageSlug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';

/**
 * Tests whose failing locator reads like something an AI step would have been
 * authored from — a semantic, name-based locator. Keyed by spec + test title,
 * the value pairs the natural-language prompt with the EXACT locator the story's
 * failure is about, so the failing locator and the intent actually join up: the
 * healing panel then shows "Compiled from prompt …" on those failures and the
 * diagnosis `aiSteps` section carries a genuinely relevant intent.
 *
 * The showcase is `checkout-email-renamed` (cluster 2): a renamed label is the
 * textbook case for reasoning about intent rather than the broken selector.
 * Structural locators from other stories (`.modal.is-open`, bare `getByRole`)
 * are deliberately absent — an AI step compiles to a named element, so pinning
 * an intent on those would misrepresent the feature.
 */
const AI_STEP_STORY_INTENTS = new Map(
  [
    {
      file: 'tests/checkout/checkout.spec.ts',
      title: 'should complete checkout with Apple Pay',
      template: 'the email address field',
      locator: "getByLabel('Email address')",
      kind: 'locator',
    },
    {
      file: 'tests/mobile/forms.spec.ts',
      title: 'Text input shows keyboard on focus',
      template: 'the delivery notes field',
      locator: "getByLabel('Delivery notes')",
      kind: 'locator',
    },
    {
      file: 'tests/admin/reports.spec.ts',
      title: 'exports the monthly report as CSV',
      template: 'export the report as CSV',
      locator: "getByRole('button', { name: 'Export CSV' })",
      kind: 'run',
    },
    {
      file: 'tests/checkout/checkout.spec.ts',
      title: 'should complete checkout with credit card',
      template: 'pay for the order',
      locator: "getByRole('button', { name: 'Pay' })",
      kind: 'run',
    },
  ].map((e) => [`${e.file}\x00${e.title}`, e]),
);

/** The committed-artifact path an entry would live at, mirroring the reporter's key layout. */
async function aiEntryPath(caseDef, template) {
  const dir = caseDef.file.replace(/[^/]+$/, '').replace(/\/$/, '');
  const base = caseDef.file.split('/').pop();
  const h = (await sha256Hex(`${caseDef.title}::${template}`)).slice(0, 8);
  return `${dir}/__piwi__/${base}/${aiUsageSlug(caseDef.title)}.${aiUsageSlug(template)}.${h}.json`;
}

/**
 * The AI-step usage manifest a browser test replayed: the committed
 * `page.piwiLocator` / `page.piwiRun` artifacts (`entries`, powering the
 * project "AI steps" liveness tab) plus the `intents` mapping each compiled
 * locator back to its prompt (powering the healing panel's "Compiled from
 * prompt" line and the diagnosis `aiSteps` section).
 *
 * Two sources, both deterministic (no randomness, so a test yields the SAME
 * manifest in every run and liveness aggregates across runs):
 *  - tests in `AI_STEP_STORY_INTENTS` always carry an intent whose locator IS
 *    their story's failing locator — these are the ones the UI showcases;
 *  - a deterministic ~1/3 of the remaining tests carry generic intents, so the
 *    liveness tab has realistic volume beyond the handful of story cases.
 */
export async function buildAiUsage(caseDef) {
  const story = AI_STEP_STORY_INTENTS.get(`${caseDef.file}\x00${caseDef.title}`);
  if (story) {
    return {
      entries: [await aiEntryPath(caseDef, story.template)],
      intents: [{ template: story.template, locator: story.locator, kind: story.kind }],
    };
  }

  const idHash = await sha256Hex(`${caseDef.file}\x00${caseDef.title}`);
  const pick = parseInt(idHash.slice(0, 2), 16);
  if (pick % 3 !== 0) return null;

  const prompts = [
    { template: 'the primary action field', locator: "getByRole('textbox', { name: 'Name' })", kind: 'locator' },
  ];
  if (pick % 2 === 0) {
    prompts.push({ template: 'submit the form', locator: "getByRole('button', { name: 'Continue' })", kind: 'run' });
  }
  return {
    entries: await Promise.all(prompts.map((p) => aiEntryPath(caseDef, p.template))),
    intents: prompts.map((p) => ({ template: p.template, locator: p.locator, kind: p.kind })),
  };
}
