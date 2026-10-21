/**
 * What Piwi is made of, the decisions a setup involves, and where feedback goes.
 *
 * The registry behind the MCP `describe_piwi` tool and the "The pieces" and
 * "Choosing a setup" sections of the generated All features page
 * (`apps/docs/reference/features.md`, built by
 * `apps/docs/scripts/generate-features.mjs`), so the tool never says anything
 * the docs site does not. Kept short on purpose: each entry names a page that
 * holds the detail.
 *
 * Dependency-free like the feature catalog, so the docs generator imports it
 * with no app runtime. `docs-drift.test.ts` resolves every `doc` target against
 * a real page and heading, and holds `POSITIONING` to the canonical line.
 */
import type { FeatureNeed } from '#shared/piwi-features';

/** The canonical positioning line — one of the surfaces listed in the root AGENTS.md. */
export const POSITIONING = {
  name: 'Piwi',
  tagline: 'Your Playwright results, kept and explained.',
  summary:
    'CI throws away every report it makes. Piwi keeps them, then groups the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted, zero telemetry.',
} as const;

const REPOSITORY = 'https://github.com/piwitests/platform';

export const PROJECT_LINKS = {
  docs: 'https://piwitests.dev',
  demo: 'https://piwitests.dev/demo/',
  apiReference: 'https://piwitests.dev/demo/docs',
  repository: REPOSITORY,
  releases: `${REPOSITORY}/releases`,
  changelog: `${REPOSITORY}/blob/main/CHANGELOG.md`,
  roadmap: `${REPOSITORY}/blob/main/ROADMAP.md`,
  contributing: `${REPOSITORY}/blob/main/CONTRIBUTING.md`,
  issues: `${REPOSITORY}/issues`,
  discussions: `${REPOSITORY}/discussions`,
} as const;

/** One installable or reachable part of the Piwi ecosystem. */
export interface EcosystemPiece {
  id: string;
  name: string;
  /** One or two sentences: what it is and what it does. */
  summary: string;
  /** How to get it — a command, a package or a place. */
  get: string;
  /** When a team needs it. */
  when: string;
  /** Extra prerequisites, in the feature catalog's vocabulary. */
  needs: FeatureNeed[];
  /** Docs page (+ optional `#anchor`), resolved by `docs-drift.test.ts`. */
  doc: string;
}

export const ECOSYSTEM_PIECES: EcosystemPiece[] = [
  {
    id: 'server',
    name: 'Dashboard server',
    summary:
      'The dashboard, its REST API and the MCP server in one Node process. It keeps runs in SQLite (default) or PostgreSQL, and traces, reports and attachments on local disk (default) or S3-compatible storage.',
    get: 'The Docker image `phenx/piwitests-server` (also `ghcr.io/piwitests/platform`), `npx @piwitests/server` (Node.js 22+), a one-click deploy template, or the desktop app.',
    when: 'Always — every result lands in one. Where to run it is the first setup decision.',
    needs: [],
    doc: 'operate/deployment',
  },
  {
    id: 'desktop',
    name: 'Desktop app',
    summary:
      'The same server in a native window, bound to 127.0.0.1. It receives your local runs with no URL or token in the config, runs your tests from the window, reproduces a failure or a flake and bisects it in a throwaway worktree, imports a blob report or trace dropped on it, and connects AI assistants to its MCP server in one click.',
    get: 'Installers on the GitHub releases page: Windows x64 (`.exe` or `.msi`), Apple-silicon macOS (`.dmg`) and Linux x86-64 (`.AppImage`, `.deb`, `.rpm`). They are unsigned, so the OS warns on first launch.',
    when: 'One developer running Playwright on their own machine, with no server to operate.',
    needs: ['desktop'],
    doc: 'features/desktop',
  },
  {
    id: 'demo',
    name: 'Live demo',
    summary: 'The real dashboard on seeded data, running entirely in your browser — no backend, nothing kept.',
    get: 'https://piwitests.dev/demo/',
    when: 'Looking around before installing anything.',
    needs: [],
    doc: 'guide/getting-started#_1-run-the-dashboard',
  },
  {
    id: 'reporter',
    name: 'Reporter',
    summary:
      '`@piwitests/reporter`, a Playwright reporter that streams each run to the dashboard while it executes: results, errors, steps, traces, screenshots, attachments and the HTML report. The first run under a new project name creates the project (with authentication on, the key needs access to all projects).',
    get: '`npx @piwitests/reporter init --server-url <url> --project <name>`, or `npm install --save-dev @piwitests/reporter` and a line in `playwright.config`. It finds a running desktop app by itself.',
    when: 'Always, for live results. Runs recorded before Piwi can be imported instead.',
    needs: [],
    doc: 'guide/reporter',
  },
  {
    id: 'cli',
    name: '`piwi` CLI',
    summary:
      'The command-line tool that ships with the reporter. `init` wires a project up and `skills` installs the agent skills; `gate` fails a CI job on the dashboard’s analysis, `select` and `run` resolve and run a saved test selection, and `report` prints a quality report; `preflight` lists the test locators an uncommitted change breaks, `flake` makes a flaky test fail on demand and verifies the fix, `bug` writes a bug report’s failing test, `probe` runs the dashboard’s probe plan, `codegen` turns a Piwi Picker recording into a spec, and `ai` manages AI-step artifacts.',
    get: '`npx @piwitests/reporter <command>`. Once the reporter is a project dependency, `npx piwi <command>` works too; before that, it fetches an unrelated `piwi` package.',
    when: 'Setting a project up, gating merges in CI, checking a change before it runs, reproducing a flaky test, and running only the tests that matter.',
    needs: [],
    doc: 'reference/cli',
  },
  {
    id: 'fixtures',
    name: 'Capture fixtures',
    summary:
      'An extended Playwright `test` (`piwiFixtures`) that records network timing, console warnings and errors, Web Vitals, browser dialogs, failure-time ARIA snapshots and the locator snapshots locator healing ranks.',
    get: 'A `tests/fixtures.ts` exporting `base.extend(piwiFixtures)` — `init` creates it — with `test` imported from it in your specs.',
    when: 'Recommended: locator healing, slow endpoints, Web Vitals and the richer failure evidence need it.',
    needs: [],
    doc: 'guide/capture-fixtures',
  },
  {
    id: 'ai-steps',
    name: 'AI steps',
    summary:
      '`page.piwiLocator()` and `page.piwiRun()` take plain English. Each prompt is resolved once, through the dashboard’s AI provider, into an artifact you commit, and every later run replays it as ordinary Playwright with no model call.',
    get: 'Part of the reporter: extend `test` with `extendPiwiAi`, then author the missing entries with `npx @piwitests/reporter ai resolve`.',
    when: 'Writing steps in plain English without a model in the loop at run time.',
    needs: ['llm'],
    doc: 'features/ai-steps',
  },
  {
    id: 'backend-logs',
    name: 'Backend instrumentation',
    summary:
      'Packages for the app under test that, outside production, attach what the server did for each request to its response, so a failing test shows the server’s warnings and errors next to the request that caused them. `@piwitests/instrumentation-nitro` (Nitro / Nuxt) also sends server spans; `PiwiTests.Instrumentation.AspNetCore` covers ASP.NET Core, and `PiwiTests.Instrumentation.Serilog` is its sink for apps that log through Serilog. Both packages serve the route manifest.',
    get: '`npm install @piwitests/instrumentation-nitro`, or `dotnet add package PiwiTests.Instrumentation.AspNetCore` (plus `PiwiTests.Instrumentation.Serilog` when the app logs through Serilog).',
    when: 'Your app under test runs on Nitro, Nuxt or ASP.NET Core, and a UI failure may start as a server error.',
    needs: ['fixtures', 'backend'],
    doc: 'guide/backend-logs',
  },
  {
    id: 'extension',
    name: 'Browser extension (Piwi Picker)',
    summary:
      'A Chrome, Edge and Firefox extension. On any page it picks ranked, stable Playwright locators, flags poor locator targets, suggests assertions, records actions as a runnable spec, and turns a bug you reproduce into a failing test and a report; its DevTools panel adds a locator console, response mocks and viewports. It works on its own; connected to an instance, it also matches your test functions, shows which elements your tests reach, and sends bug reports to the project.',
    get: 'The Piwi Picker listing on the Chrome Web Store (https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe), which covers Edge and other Chromium browsers, or on Firefox Add-ons (https://addons.mozilla.org/firefox/addon/piwi-picker/).',
    when: 'Writing or fixing locators against a live page, or reporting a bug as a failing test.',
    needs: ['extension'],
    doc: 'features/extension',
  },
  {
    id: 'editor',
    name: 'Editor extensions (VS Code, JetBrains)',
    summary:
      'The Piwi extension for VS Code (and Cursor, VSCodium) and the Piwi plugin for JetBrains IDEs with the LSP API (WebStorm, IntelliJ IDEA Ultimate, Rider). They record tests in a browser the project’s own Playwright opens, written at the cursor as you go; show the latest CI failures on the branch at their failing lines with the locator heal as a quick fix, the tests behind each locator and file, brittle locators and the locators an unsaved change breaks; and set up Piwi’s MCP server for the editor’s agent.',
    get: 'Install Piwi (`piwitests.piwi`) from the VS Code extensions view or the Visual Studio Marketplace (https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi), or in a JetBrains IDE from Settings → Plugins or the JetBrains Marketplace (https://plugins.jetbrains.com/plugin/34674-piwi). It reads the reporter’s connection (the environment, the workspace `.env` or the desktop app); otherwise Piwi: Connect signs in with the browser and creates an API key for the editor.',
    when: 'You want CI results where you edit the tests: failures at their lines, heals applied in place, and the tests a change reaches.',
    needs: [],
    doc: 'features/editors',
  },
  {
    id: 'mcp',
    name: 'MCP server',
    summary:
      'Built into every dashboard at `/mcp`, with the same `pd_` API keys as the REST API: tools that give a coding agent your runs, failures, clusters, flaky tests, diagnoses, fix plans, locator healing, scenario gaps and bug reports, plus the `setup_piwi` prompt. The desktop app adds three tools that work on local files.',
    get: 'Point an MCP client at `<dashboard>/mcp`; the dashboard’s MCP server page has per-client snippets, the desktop app writes client configs in one click, and the VS Code extension provides the server to the editor’s agent.',
    when: 'A coding agent should read your results and hand back fixes.',
    needs: [],
    doc: 'features/mcp',
  },
  {
    id: 'skills',
    name: 'Agent skills',
    summary:
      'Seven `SKILL.md` workflows (set Piwi up, investigate a failure, apply locator healing, stabilize flaky tests, run the right tests, write the missing test, fix a reported bug) that teach a coding agent what to do with Piwi’s evidence. The six workflow skills use the MCP tools when they are connected, and the dashboard otherwise.',
    get: '`npx @piwitests/reporter skills add`; `init` installs the six workflow skills (all but `setup-piwi`).',
    when: 'Your coding agent should follow the Piwi workflow end to end.',
    needs: [],
    doc: 'features/agent-skills',
  },
  {
    id: 'api',
    name: 'REST API',
    summary:
      'Everything the dashboard does, over HTTP with `pd_` API keys (a Bearer or `X-API-Key` header). Each instance serves its own OpenAPI reference at `/docs` (the spec is `/_openapi.json`).',
    get: 'Your dashboard’s `/docs` page (the demo’s is at https://piwitests.dev/demo/docs).',
    when: 'Scripting against Piwi outside the reporter and the MCP server.',
    needs: [],
    doc: 'operate/api-keys#using-the-api-key-in-raw-http-calls',
  },
  {
    id: 'metrics',
    name: 'Metrics and rollup export',
    summary:
      '`GET /api/metrics` serves the metric catalog’s current values per project in the OpenMetrics format, for a Prometheus or Grafana you run; `GET /api/rollups` streams the daily rollup rows as JSON or CSV for a BI tool or spreadsheet. Both are pulls: Piwi sends nothing anywhere.',
    get: 'Set `PIWI_METRICS_ENABLED=true` to serve `/api/metrics` (off by default) and point a scrape job at it; `/api/rollups` needs no flag. With authentication on, both take an API key and cover its user’s projects.',
    when: 'An operator charts test health next to other services, or loads the daily numbers into a BI tool.',
    needs: [],
    doc: 'operate/metrics',
  },
];

/** One option of a setup decision. */
export interface SetupOption {
  option: string;
  /** When this option is the right one, and what it takes. */
  when: string;
}

/** A decision every team makes once, with the page that settles it. */
export interface SetupDecision {
  id: string;
  question: string;
  /** What happens when you decide nothing. */
  default: string;
  options: SetupOption[];
  doc: string;
}

export const SETUP_DECISIONS: SetupDecision[] = [
  {
    id: 'where',
    question: 'Where should the dashboard run?',
    default: 'Nothing runs until you pick one.',
    options: [
      { option: 'Live demo', when: 'Looking around first — seeded data in your browser, nothing kept.' },
      {
        option: 'Desktop app',
        when: 'One developer on Windows x64, Apple-silicon macOS or Linux x86-64; no Docker or Node needed.',
      },
      { option: 'Docker', when: 'A shared, long-lived instance for a team — the recommended path.' },
      { option: '`npx @piwitests/server`', when: 'A quick local run where Node.js 22+ is installed.' },
      {
        option: 'One-click deploy',
        when: 'A shared instance from a template: Railway, Render, Fly.io or Koyeb, or a Compose file for Coolify or Dokploy on a server you already run. Each provisions one container, a persistent volume and authentication on.',
      },
    ],
    doc: 'guide/getting-started#_1-run-the-dashboard',
  },
  {
    id: 'database',
    question: 'SQLite or PostgreSQL?',
    default: 'SQLite, created automatically in `.data/piwi.db`.',
    options: [
      { option: 'SQLite', when: 'Zero configuration; one writer at a time is ample for a team’s test volume.' },
      {
        option: 'PostgreSQL 14+',
        when: 'Set `PIWI_DATABASE_URL` when several dashboard replicas share one database, or `database is locked` shows up under load. Migrations run on startup either way.',
      },
    ],
    doc: 'operate/database',
  },
  {
    id: 'storage',
    question: 'Where do traces, reports and screenshots go?',
    default: 'Local disk, under `.data/storage/`.',
    options: [
      { option: 'Local disk', when: 'No configuration; back the directory up with the database.' },
      {
        option: 'S3-compatible storage',
        when: '`PIWI_STORAGE_TYPE=s3` with a bucket and region — AWS S3 (static keys optional, instance roles work), Cloudflare R2, DigitalOcean Spaces, RustFS and others.',
      },
    ],
    doc: 'operate/storage',
  },
  {
    id: 'auth',
    question: 'Turn authentication on?',
    default: 'Off: every request is treated as an administrator.',
    options: [
      { option: 'Off', when: 'Only on localhost or in the desktop app.' },
      {
        option: 'On',
        when: 'Anything reachable from a network: `PIWI_AUTH_ENABLED=true` and `PIWI_AUTH_SECRET`, then instance and project roles granted to users or groups, `pd_` API keys for CI, agents and editors, and optional Google or GitHub sign-in. Browser sign-in then needs HTTPS (or localhost). Set `PIWI_SECRET_KEY` too, and work through the production checklist.',
      },
    ],
    doc: 'operate/authentication',
  },
  {
    id: 'fixtures',
    question: 'Add the capture fixtures?',
    default: 'Off: `init` creates the fixtures file, and each spec opts in by importing `test` from it.',
    options: [
      {
        option: 'Yes (recommended)',
        when: 'Import `test` from the fixtures file in your specs, and locator healing, slow endpoints, Web Vitals, the console card, the dialogs lane and failure-time ARIA snapshots light up.',
      },
      {
        option: 'Not yet',
        when: 'Results, traces, screenshots, failure clusters and flaky scores work without them, and an uploaded trace still yields console, network and the failure-time ARIA snapshot.',
      },
    ],
    doc: 'guide/capture-fixtures#with-and-without-the-fixtures',
  },
  {
    id: 'ai',
    question: 'Connect an AI provider, and which one?',
    default:
      'Off. Clustering, flaky scoring, failure clues, locator healing and fix verification need no model. A provider is set in Settings → AI or with environment variables, which win.',
    options: [
      {
        option: 'No AI',
        when: 'Everything deterministic still works. A model adds diagnoses with patches, AI-step authoring, the quality-report narrative and, with an embedding model, similarity merging of clusters.',
      },
      {
        option: 'Anthropic',
        when: 'The recommended provider: `PIWI_AI_PROVIDER=anthropic` and `PIWI_AI_API_KEY`.',
      },
      {
        option: 'OpenAI',
        when: '`PIWI_AI_PROVIDER=openai` with `PIWI_AI_BASE_URL` (OpenAI’s own endpoint), `PIWI_AI_MODEL` and `PIWI_AI_API_KEY`.',
      },
      {
        option: 'OpenAI-compatible or local',
        when: 'Ollama, LM Studio, vLLM and the like: `PIWI_AI_PROVIDER=openai` with `PIWI_AI_BASE_URL` pointing at that server and `PIWI_AI_MODEL`, so nothing leaves your network.',
      },
      {
        option: 'Claude Code (local)',
        when: 'The desktop app, or a server with `PIWI_CLAUDE_CLI_PATH` set, runs the local `claude` CLI on its own sign-in, with no API key (`PIWI_AI_PROVIDER=claude-cli`).',
      },
    ],
    doc: 'guide/ai-provider',
  },
  {
    id: 'scm',
    question: 'Connect source control?',
    default:
      'No token: runs still carry the branch and commit the reporter detects, and public repositories are read anonymously (rate-limited).',
    options: [
      { option: 'No token', when: 'History, clusters, flaky scores and locator healing are unaffected.' },
      {
        option: 'A GitHub, GitLab or Bitbucket token',
        when: 'Set instance-wide (Settings → AI → Repository access) or per project. Read access opens private repositories to the diff in AI diagnosis, What changed, uncovered changes and CODEOWNERS ownership. Write access adds pull-request comments and commit statuses (GitHub, GitLab) and auto-heal pull requests (GitHub, GitLab, Bitbucket Cloud), both with `PIWI_SITE_URL` set, and CI re-runs from the dashboard.',
      },
    ],
    doc: 'guide/source-control',
  },
  {
    id: 'gate',
    question: 'What should block a merge?',
    default: 'Playwright’s own exit code: any failed test.',
    options: [
      { option: 'The exit code', when: 'You only need "did anything fail".' },
      {
        option: '`piwi gate`',
        when: 'The dashboard’s analysis decides: how many tests failed, newly failed, newly turned flaky or are quarantined, a failure cluster never seen before, required tags, or a selection whose tests must run and pass.',
      },
    ],
    doc: 'guide/ci#blocking-a-merge',
  },
  {
    id: 'mcp-modules',
    question: 'Which MCP tools should agents see?',
    default: 'Every tool whose capability is not declined.',
    options: [
      { option: 'All', when: 'The agent can reach every part of Piwi.' },
      {
        option: '`?modules=core`',
        when: 'Append to the MCP URL (any comma-separated set of core, workflow, healing and agents) to narrow the list for a tighter token budget; it never re-enables a declined tool.',
      },
      {
        option: 'Decline a capability',
        when: 'Declining one on the Setup page, or a whole module in its presets, drops the tools that depend on it for every client; tools that need no capability stay.',
      },
    ],
    doc: 'features/mcp#what-it-provides',
  },
  {
    id: 'retention',
    question: 'How much history to keep?',
    default: 'Every run: run pruning is opt-in.',
    options: [
      { option: 'Everything', when: 'The history is the point; budget disk for traces and reports.' },
      {
        option: '`PIWI_RETENTION_DAYS`',
        when: 'A nightly sweep deletes older runs with their files. Kept runs stay, `PIWI_RETENTION_MIN_RUNS` keeps each project’s newest runs, and pruned runs stay counted in the analytics rollups.',
      },
    ],
    doc: 'operate/storage#data-retention',
  },
  {
    id: 'history',
    question: 'Start from history you already have?',
    default: 'Trends start with the first reported run.',
    options: [
      { option: 'Start fresh', when: 'Nothing to import.' },
      {
        option: 'Import',
        when: 'An administrator backfills from Playwright blob reports or bare trace files with the project’s Import button, or drops them on the desktop app; imports are idempotent and send no notifications.',
      },
    ],
    doc: 'guide/importing-runs',
  },
];

/** Where each kind of feedback goes, and what makes it actionable. */
export const FEEDBACK_CHANNELS = {
  bug: {
    url: `${REPOSITORY}/issues/new?template=bug_report.yml`,
    include: [
      'What you did, what you expected, and what happened instead.',
      'The dashboard version (Settings → About, or `GET /api/version`) and the reporter version.',
      'The deployment: Docker or source, SQLite or PostgreSQL, local or S3 storage, auth on or off.',
      'Server logs or browser console output around the failure.',
    ],
  },
  idea: {
    url: `${REPOSITORY}/issues/new?template=feature_request.yml`,
    include: [
      'The problem first — the situation where the feature is missing matters more than the solution.',
      'A rough sketch of the behavior you would like, and the alternatives you considered.',
      'The roadmap and existing issues, checked first: the idea may already be tracked.',
    ],
  },
  translation: {
    url: `${REPOSITORY}/issues/new?template=translation.yml`,
    include: [
      'The language, and where in Piwi Picker the text appears (the popup, the settings, Report a bug, the store listing).',
      'What it says now, copied or as a screenshot.',
      'What it should say, and why if it helps.',
    ],
  },
  question: PROJECT_LINKS.discussions,
  security: `${REPOSITORY}/security/advisories/new`,
  docs: 'Docs pages carry an "Edit this page on GitHub" link (the generated reference pages excepted); a fix is a pull request against `apps/docs/`.',
  nonGoals: [
    'Other test frameworks (Cypress, Jest, JUnit…) — Piwi stays Playwright-only.',
    'A hosted SaaS — Piwi is built to be self-hosted.',
  ],
} as const;

/**
 * The docs sections the tool quotes verbatim (as plain-text list items) rather
 * than restating: the four jobs, the two rules and the stated limits.
 */
export const QUOTED_DOCS_SECTIONS = {
  jobs: 'guide/what-piwi-does#the-four-jobs',
  rules: 'guide/what-piwi-does#two-rules',
  limits: 'guide/comparison#when-piwi-is-not-the-right-choice',
} as const;

/** The topics the MCP `describe_piwi` tool answers, with what each returns. */
export const DESCRIBE_PIWI_TOPICS = {
  overview: 'What Piwi is and is not (its four jobs, two rules and limits), its pieces, and this instance.',
  ecosystem: 'Every piece — what it is, how to get it, when you need it.',
  choices: 'The setup decisions, their options and defaults (and, for administrators, what this instance chose).',
  features:
    'The feature catalog behind the All features page: what each feature needs and where it lives (and capability states, for administrators).',
  configuration: 'Every PIWI_* environment variable; add `query` to filter.',
  mcp: 'This MCP server: tool modules, what is served here, desktop-only tools, prompts and skills.',
  feedback: 'Where bug reports, ideas and questions go, what to include, and the non-goals.',
  docs: 'The index of documentation pages, to read with `page`.',
} as const;

export type DescribePiwiTopic = keyof typeof DESCRIBE_PIWI_TOPICS;
