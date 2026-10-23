# In-app assistant

- Status: accepted
- Date: 2026-10-23

A plan for an assistant inside the dashboard and the desktop app: a panel that answers questions about the user's
runs, failures and configuration with the AI model the instance already uses, shows the answer on the real screens with
a guided walkthrough, and proposes changes the user applies with a click. It reads the data through the MCP tools with
the access of the person asking, and Piwi's own documentation bundled into the server, so it can say nothing the data
and the docs do not.

**Status.** Proposed 2026-10-22. **PR 1 built 2026-10-22**: the guide engine (`useGuide`), extracted from the demo
tour, which runs on it unchanged; the anchor registry in `shared/guide-anchors/` with the tour's 26 anchors; and its
three checks, against the source, the seed and the built demo. As built, an anchor lists every page it renders on
(several components render on more than one), and a sample names its demo persona by id. **PR 2 built 2026-10-23**: the
anchor coverage, 334 anchors in eleven area files (layout 14, home 8, analytics 59, projects 66, runs 26, executions 24,
clusters 33, test cases 12, setup 18, settings 72, demo 2), each with a `kind`: 37 pages, 40 tabs, 38 settings fields,
139 blocks, 3 rows, 67 actions and 10 sidebar destinations. `guide-anchor-coverage.test.ts` reads from the source every
page, tab the URL selects, settings field, help topic set on a block and sidebar destination, and fails on one no anchor
covers. 33 exemptions remain, each with its reason, all of them items no seeded screen renders: 8 pages (5 sign-in and
connect pages outside the dashboard layout, 3 that only redirect) and 25 help topics or fields (6 widgets no built-in or
seeded dashboard holds; share links, OAuth providers and SMTP the demo does not configure, authentication it never turns
off and the AI it always simulates; 7 states the seed holds none of; 2 views of the Screen tab held in a component's
state). As built, a `data-tour` is also a static key on a menu item, on a `NavbarActions` action's `attrs` or in a
static map spread with `v-bind`; a route names a built-in dashboard by its key (`/analytics/d/engineering`), which the
server's route check accepts with no entity to check; each section of the fix toolbox has its anchor on its toggle,
which an `unfold` clicks only while it reads folded; the built-demo check fails an anchor whose computed opacity is 0,
so a hover-only control is no anchor; and the 3 desktop anchors are checked by `check-demo-runtime.mjs --desktop`, on a
desktop-mode dev server with the mocked Tauri bridge. **PR 3 built 2026-10-23**: the first list's 15 authored guides
in `app/utils/guides/`, 3 to 6 stops each, listed on every instance by the command palette's Guides group and by the
assistant panel when its conversation is empty or it cannot answer, each filtered by its `requires`; a stop on an
entity's page names one of 8 resolvers (the project updated last, the newest finished run, a failure of the newest
failed run, a failure with a locator fix, the open cluster seen last, the flakiest test and its project, the first
saved dashboard the user can edit), and one whose resolver finds nothing shows centered at once with its anchor's
`shownWhen` (the engine's `absent` stop); `authored-guides.test.ts` checks every bold label against the source of the
stop's component or page, and `check-demo-runtime.mjs` starts every guide from the palette in the built demo. As
built, the demo's four tours keep their own format; a guide stays off anchors inside a modal; and the engine
scrolls a stop's target back into view when content loading above pushes it out, until the user scrolls, clicks or
types. **PR 4 built 2026-10-22**,
the server side with no panel yet: the `assistant` role; the loop with tool calling (native for Anthropic and
OpenAI-compatible servers; a JSON action mode, one tool call or the answer per reply, for a server that refuses tools
and for the Claude Code CLI until PR 7); the read tools routed per page with `find_tools` and `get_instance_config`;
private conversations, and an `assistant_usage` ledger the daily caps count from, so deleting a conversation does not
reset them; the `assistant` capability; its routes (1.0 register D58); and a fixed demo reply. **PR 5 built
2026-10-23**: the answer blocks, each a block tool the server checks against `ASSISTANT_BLOCK_LIMITS`
(`shared/assistant-blocks.ts`) before it is sent; the entities each tool result names, which the answer may link
(`piwi:<type>/<id>`) or offer as a card or a choice; `find_anchors` and composed guides, every stop checked on the
server (its anchor, `requires`, page and the entities its route names), built-in dashboards included; patches validated
at the run's commit; replies stored on their block; checklist ticks through their own route; and the panel, a side
panel beside the page (full screen on a phone) opened from the sidebar and the command palette, with "Ask about this
page" suggestions and **What it read** under each answer. As built, the launcher sits under the sidebar's search, since
no page header is shared, and the page context does not yet list the anchors rendered on the page (PR 6 adds it).
**PR 6 built 2026-10-23**: proposal cards, a `proposal` block made by `propose_change` from a closed registry of ten
actions (`shared/assistant-actions.ts`: resolve, ignore and reopen a cluster; quarantine and release a test; diagnose a
cluster or an execution; keep a run; a capability decision for the instance or for a project), each an existing REST
route and the permission it declares, which a test reads from the route's file; a card shows only when the user holds
that permission on its target's project, its **Apply** calls the route from the browser with the user's session and
records the outcome (`PATCH …/messages/:messageId/proposal`), and a question's picks end in one card each;
`explain_setting`, with `HELP_TOPICS` and `SETTINGS_PAGES` moved to `shared/`; and the anchors rendered on the page in
the question's context, which `find_anchors` ranks first. As built, filing an issue is no card, since its route needs
the tracker binding and required fields its dialog fills, and no card declines AI or the assistant, which the assistant
rides on. **PR 7 built 2026-10-23**: with the Claude Code CLI, one run writes the whole answer through a per-answer MCP endpoint
(`/api/assistant/conversations/{id}/mcp`) serving exactly that answer's toolbox, behind a token minted for the user,
the conversation and the answer, accepted from this machine only and revoked when the answer ends; the desktop guard
lets that route through on that token alone, and the desktop token never reaches the CLI. On the desktop app the model
may read source files, only inside the folder linked to a project the user reads. **PR 8 built 2026-10-23**: the nudges,
a registry in `app/utils/nudges/` of rules over facts their page already loaded, with no model call: Setup with
undecided capabilities asks the assistant which of them the runs would use; a cluster diagnosis that read no commits,
with no SCM token set, offers the SCM token guide; a failure leading with a timeout or a network clue while the capture
fixtures are undecided offers their guide, in place of the execution page's line that offered to decline them. One
inline card per page view, with **Show me** or **Ask** and **Don't show again**, and three a week per browser; the
dismissals in `assistant_nudge_dismissals`, per user (null with authentication off), through their own routes (1.0
register D58). As built, the fixtures nudge shows to everyone its guide is listed for, the evidence footer keeps its
decline controls beside it, and a dismissal can be undone through the API; a nudge that offers a guide, and its
dismissal, stay when the assistant or AI is declined, and only the question nudge goes with the assistant. **PR 9 built 2026-10-23**: 150
questions over the demo seed (`tests/live/assistant-questions.ts`), each with the tools a good answer calls, the facts
it must state (each traced to the seed or the docs, which a zero-token unit test checks), the blocks and, for show-me
questions, the anchors it should use; and a live spec that asks them all against a real model and scores each answer
(`npm run app:test:assistant:live`, on demand only). It has run only against a scripted mock model so far: the pass
threshold (0.6) is a starting point to tune on the first real run. **D6 built 2026-10-23**: the demo answers 11
prepared questions (`shared/demo/assistant-questions.mjs`), which are its **Ask about this page** suggestions, each
answer computed from the seed through the shared handlers and streamed in the real events: why a failure happened,
with its patch or replacement line, the command reproducing it and the ways to fix it; the flakiest tests to tick, then
a quarantine card each, applied through the demo's own route; what changed since a run's baseline; which CI, then the
steps and the pipeline in shards; a guide to where something is; what Piwi is; and, for any other question, the page's
prepared questions to pick from and the authored guides. As built, the demo's panel sits under its banner. **Fix-ups
built 2026-10-23**: a stop revealed by an `open` step keeps its popover open, since the guide's popover counts as a
layer opened from it and **Next** taking focus no longer closes it (`check-demo-runtime.mjs` plays a guide in the
run's **Details** popover); a proposal card follows the capability decisions of its target's project, and an anchor
those of the page's project and of each stop's, a project's enable winning over the instance's decline, in the demo's
prepared answers too; the Claude Code CLI's turn budget counts a turn per block an answer can hold; the panel has its
own six anchors, from the launcher to **What it read**, with a seeded conversation of the demo persona to open; and
the live question set adds 8 changes to apply, each ending in a proposal card, 158 in all. Every planned piece is
built, with two items left out: the demo's four tours keep their own format rather than becoming authored guides,
since they speak four languages and open each role's seeded screens, where an authored guide is English and finds
its pages with resolvers, and they already run on the guide engine and the anchor registry; and the demo does not
search the bundled docs for a question no prepared answer matches, since the docs are server assets the demo does not
ship, so it offers the page's prepared questions and the authored guides that fit instead. Every question is
decided ([Decisions](#decisions), D1–D8): guides point only at a closed registry of anchors, every anchor tested;
finding elements from the page's ARIA snapshot is deferred to
[a later step](#later-finding-elements-from-the-pages-aria-snapshot), which keeps the measurements behind that choice;
a dedicated AI role; proposal cards in PR 6; an authored demo; private conversations; nudge dismissals kept per user on
the server. Answers are made of typed blocks (section 5): formatted text, code, options to choose from, questions with
checkboxes, checklists.

## Why

- **The answers are on the instance, spread out.** The dashboard has 47 pages, 204 help hints, 34 settings fields and
  131 `PIWI_*` variables, and the server bundles about 105 documentation pages. A user who asks "why does the diagnosis
  not see my diff?" has to know the SCM token is a setting, find its page and read its help. Nothing joins the
  question to those facts.
- **AI agents have a better interface to Piwi than people do.** An MCP client reads 85 tools, the docs and the
  changelog, scoped to its owner's access. A person in the dashboard has the screens. The tools already enforce the
  caller's access, so the same surface can serve the person.
- **Pointing at the screen works, but only in the demo.** The demo's guided tour opens a role's screens one by one and
  highlights one element on each: 26 stops, four fixed paths, on seeded data, in the demo build only.
- **Configuration answers depend on the instance.** Whether a capability is on, which AI roles are set, whether the
  environment manages a setting: the docs answer the general case, the instance's own state answers the rest.

An assistant that interrupts gets switched off. This one opens when asked; the only thing that appears unasked is a
rare, rule-based nudge that can be dismissed for good (section 8).

## What already exists

| The assistant needs to… | Already in the repository |
| --- | --- |
| Read data with the user's access | 85 MCP tools and 3 desktop-only ones (`server/utils/mcp/tools.ts`, definitions in `shared/mcp-tools.ts`). Each handler takes `(db, params, ctx: McpContext)`, checks the project scope and, for the 22 write and triage tools, the permission the same REST action needs. `/mcp` hides the tools of a declined capability and the ones the caller can use on no project (`server/utils/mcp/filter.ts`). |
| Know Piwi | `describe_piwi` and `get_release_notes` (`server/utils/mcp/about-piwi.ts`) read the docs and `CHANGELOG.md` bundled as server assets, with section search (`shared/docs-corpus.ts`), the variable registry (`shared/piwi-env-vars.ts`), the feature catalog and the ecosystem pieces. They say nothing the docs do not. |
| Read the configuration | Capability states (`resolveInstanceStates`, `shared/handlers/setup-status.ts`), `readAiSettings` (never returns a key), `SETTINGS_PAGES` (`app/utils/settings-metadata.ts`: page → field → help topic → variables), `HELP_TOPICS` (`app/utils/help-content.ts`, 204 entries with docs links). |
| Suggest what to do | `shared/next-step.ts` (one next step, chosen by a policy), `shared/situation.ts`, the failure clues, the MCP workflow prompts (`setup_piwi`, `investigate_failure`, `stabilize_flaky_tests`, …). |
| Point at the screen | The demo tour (`app/composables/useDemoTour.ts`): opens a route, waits for the target, unfolds a folded section, scrolls the panel that holds it and highlights it with driver.js. Its stops are data (`app/utils/demo-tour/profiles.ts`); `data-tour` attributes are its API, checked by `tests/unit/demo-tour.test.ts` and walked in the built demo by `scripts/check-demo-runtime.mjs` in CI. |
| Call a model | `server/utils/ai-provider.ts`: Anthropic, OpenAI-compatible endpoints and the local Claude Code CLI; roles (`diagnosis`, `research`, `embedding`) with `reuse`; prompt caching; streaming; token accounting (`shared/handlers/ai-usage.ts`); the response language (`readAiLanguage`) and the global and per-project instructions. |
| Stream to the browser | `server/utils/sse.ts` and the diagnosis frames (`server/utils/diagnosis-stream-frames.ts`). |
| Test against known answers | The deterministic demo seed with its labeled stories (`shared/demo/failure-stories.mjs`) and examples (`shared/demo/demo-examples.mjs`), a mock-provider E2E (`tests/ai-diagnosis.spec.ts`) and live-model tests (`tests/live/`). |
| Open from anywhere | The command palette (`UDashboardSearch` in `app/layouts/default.vue`, built from the sidebar's items). |

Paths are under `apps/application/` unless they start at the repository root.

What is missing: every model call today is one system prompt and one user message with no tools
(`buildAnthropicParams` and `buildOpenAiBody` in `ai-provider.ts`), and the Claude Code CLI provider turns tools off
on purpose (`--tools '' --strict-mcp-config --max-turns 1` in `ai-claude-cli.ts`). The tour engine is mounted only in
the demo build (`app.vue`, behind `runtimeConfig.public.demoTour`).

## The proposal

### 1. An `assistant` AI role

A fourth role next to `diagnosis`, `research` and `embedding` (`ROLE_ORDER` in `ai-provider.ts`), with
`reuse: 'diagnosis'` when it is not set, so an instance with AI configured has an assistant with no further setup.
A team can point it at a faster, cheaper model for conversation; diagnosis keeps the strong one, and the assistant
starts a diagnosis through `run_cluster_diagnosis` or `run_execution_diagnosis` rather than writing one itself.

Configuration follows the research role and the Settings surface rule (`apps/application/AGENTS.md`):
`PIWI_AI_ASSISTANT_MODEL`, `PIWI_AI_ASSISTANT_PROVIDER`, `PIWI_AI_ASSISTANT_BASE_URL`, `PIWI_AI_ASSISTANT_API_KEY`
and `PIWI_AI_ASSISTANT_TEMPERATURE` in `shared/piwi-env-vars.ts`, a help topic carrying them, a field on
Settings → AI. The response language and the global and per-project instructions apply as they do to diagnosis.

### 2. The agent loop

`server/utils/ai-agent.ts` runs a conversation turn: messages in, tool calls out, tool results back, until the model
answers or a limit stops it. Per provider:

- **Anthropic.** Native tool use. The system prompt and the tool definitions are the stable prefix and carry the cache
  breakpoints, as the diagnosis context does today.
- **OpenAI-compatible.** `tools` and `tool_calls`. Support varies across servers (Ollama, vLLM, LM Studio, hosted
  gateways), so the call steps down a ladder like `postOpenAiWithFallbacks`: native tool calls, then a JSON mode where
  each reply is either one tool call or the answer, constrained by a schema. The connection test on Settings → AI
  (`server/api/settings/ai/test.post.ts`) also checks tool calling and records the result; with neither rung working the
  assistant answers from the docs and the page's own facts and says so.
- **Claude Code CLI** (the desktop app, or a server with `PIWI_CLAUDE_CLI_PATH`). Claude Code runs the loop itself, with
  this server's MCP endpoint attached (`--mcp-config`), only the read tools allowed (`--allowedTools`), a turn limit and
  `stream-json` output. It authenticates with a short-lived token minted for the user and the conversation, never the
  desktop token.

Limits, each with a `PIWI_AI_ASSISTANT_MAX_*` variable clamped like `PIWI_AI_STEP_MAX_*`: tool calls per turn, output
tokens, wall-clock time per turn.

The turn streams Server-Sent Events: `text` (Markdown, as it is written), `tool` (the tool's name and a one-line
summary, never its raw result), `block` (any other block of section 5, whole and checked), `done` (model and token
counts) and `error`.

### 3. Tools: the MCP handlers, in-process

The route builds an `McpContext` from the session exactly as `/mcp` does (`requireAuth`, the access summary,
`getProjectScope`) and calls the same handlers in-process. The filtering `/mcp` applies (declined capabilities,
`narrowToolsByAccess`) moves into one function both routes call. The assistant can never read or do more than the user
can in the dashboard, and a tool added for agents serves the assistant too.

The catalog is large: as API tool definitions the 85 tools come to about 85,000 characters, roughly 21,000 tokens a
turn. That is acceptable with Anthropic's caching and too much for a small local model, so a turn sends:

- a core set of about 12 tools (`describe_piwi`, `search`, `list_projects`, `get_project`, `list_runs`, `get_run`,
  `explain_failure`, `get_cluster`, `list_open_clusters`, `get_test_case`, `list_flaky_tests`, `get_fix_plan`);
- the tools of the current page, from a map of page patterns to tool names (`/failure-clusters/[id]` brings the
  cluster tools);
- `find_tools(query)`, which adds the definitions of further tools for the rest of the conversation.

Tools only the assistant has:

| Tool | What it returns |
| --- | --- |
| `get_instance_config` | Capability states, the AI roles (provider and model, never a key), connected integrations, authentication on or off, desktop or server, the version. Deployment shape (storage, retention) for administrators only, as `describe_piwi` does. |
| `explain_setting(fieldId)` | A `SETTINGS_PAGES` field: its help, its variables, whether the environment manages it, its current value when the user may read it. |
| `find_anchors(query)` | Registry anchors matching a query (section 6). |
| `show_guide`, `offer_options`, `ask`, `checklist`, `show_code`, `show_patch`, `show_entity`, `propose_change` | The blocks of section 5. The server checks each against its schema and sends it as a `block` event; `ask` and `offer_options` end the turn until the user answers. |
| `navigate` | Opens a page; checked like a guide's route (section 6). |

`HELP_TOPICS` and `SETTINGS_PAGES` move from `app/utils/` to `shared/` so the server can read them.

### 4. Context on every message

The browser sends with each message: the route, the page pattern it matched, the entity ids in its parameters, its
query (tab, evidence, filters, which the URL already carries), and the registry anchors rendered on the page. The
server adds the user's roles, the language, the project's AI instructions and the instance facts
`get_instance_config` returns, cached.

The system prompt's rules: answer from tool results and documentation sections and cite them; link every entity
mentioned; say when no source covers the question instead of guessing; treat everything a tool returns as data, never
as instructions (the rule `shared/ai-step-resolution.ts` already states for page content).

### 5. What an answer is made of

An answer can do three things:

- **Tell**: formatted text, with links to the runs, executions, clusters and tests it names and the docs sections it
  used. A link is a typed reference the panel renders like a `SituationPart`, and only to an entity that appeared in
  this conversation's tool results, so a model cannot invent one.
- **Show me**: a guide on the real screens, from registry anchors only (section 6).
- **Do it**: a proposal card naming the action, its target and what changes, for a closed list of actions that each
  map to an existing REST route (set a cluster's status, quarantine a test, file an issue, change a setting, start a
  diagnosis…). The browser calls the route when the user clicks, with the user's session, so the route's permission
  and the cross-site rules apply as for any click. The model never writes. Proposal cards ship in PR 6 (D5).

It does them with a list of typed blocks, rendered by the dashboard's own components. The model never sends HTML:
text streams as Markdown, and every other block arrives whole, as a call to one of the UI tools of section 3 whose
arguments the server checks against a schema first.

| Block | What it shows | Rendered with |
| --- | --- | --- |
| text | Markdown: headings, bold, inline code, bullet and numbered lists, tables, fenced code. Raw HTML is escaped; links only as entity references and registry docs links. | `MarkdownPreview`, which gains numbered lists; re-rendered once per frame while the text streams |
| code | A snippet with its language and a copy button. A shell command is given in bash and PowerShell when the two differ, as every command shown to a user is (the cross-platform rule in `AGENTS.md`). | `CodeBlock`, `PlatformCodeBlock` |
| patch | A unified diff, checked with `validatePatch` against the files at the run's commit, so its badge means what it means on a diagnosis | `PatchBlock` |
| entity | A run, execution, cluster or test as a compact card with its status colors, drawn from the tool result rather than from the model's words | the list rows' components |
| options | Two to four ways to solve the problem, each with a title, one line, its trade-off and its effort, one marked recommended. Picking one sends it back as the next message, or starts the guide it carries. | new `AssistantOptions` |
| question | A question with radio buttons or checkboxes and an optional "Other" field. The answer goes back as data, the ids of the options picked, not as typed text. | new, on `URadioGroup` and `UCheckbox` |
| checklist | Steps to do in order. The user ticks them, the ticks are kept with the conversation, and a step can open its guide stop or carry a command. | new |
| guide | A **Show me** button for an authored or composed guide | section 6 |
| proposal | A change applied with a click | PR 6 |

For example, "which flaky tests should I quarantine?" gets a short paragraph and a `question` listing the flakiest
tests from `list_flaky_tests` as checkboxes. The user ticks three; from PR 6 the answer is one proposal card per test,
before it a guide to the **Quarantine** action. "How do I run this suite in CI?" gets a `question` (which CI provider),
then a `checklist` whose steps carry the commands and the guide stops for that provider.

The schemas bound each block: two to four options; at most 10 choices in a question, or 20 when they are entities from
tool results; titles of at most 60 characters; unique ids; an entity named in a choice or a card must come from this
conversation's tool results. A block that fails its check is dropped, and the tool result tells the model why, so it
can try again once.

It stays simpler than a general chat assistant: no generated pages or charts, no images, no file uploads, nothing
outside the blocks above. A trend chart is a later block, drawn from `get_metric_trend` with the dashboard's
`ChartCard`, not from the model's numbers.

### 6. Guides on fixed anchors

A guide is a list of stops; a stop is an anchor and the words of its popover. Anchors come from one registry, and
nothing else can be pointed at (D1). The registry is large and every entry is tested (D2).

#### The registry

`shared/guide-anchors/`, pure data shared by the app, the server, the demo and the tests: plain ESM (`index.mjs`
joining one file per area of the dashboard, the types in `index.d.mts`), like `shared/demo/demo-examples.mjs`, so the
built-demo check, a plain Node script, reads it too:

```ts
export interface GuideAnchor {
  /** The `data-tour` value of the one element it names. */
  id: string;
  /** The pages it renders on, as patterns of `app/pages`, the main one first; `['*']` for the layout and the demo banner. */
  pages: readonly string[];
  /** What to do on the page before it shows, in order. */
  reveal?: readonly (
    | { query: Record<string, string> } // a tab: { tab: 'flaky-tests' }, { evidence: 'source' }
    | { unfold: string } // the anchor of the folded section holding it
    | { open: string } // the anchor of the button opening the menu, drawer or modal holding it
  )[];
  /** One sentence for the model and the people maintaining it: what the block shows, when someone needs it. */
  describes: string;
  /** When it does not always render, the condition in one sentence ("when a locator fix exists"). */
  shownWhen?: string;
  /** What the user or the instance must have for it to render. */
  requires?: { capability?: CapabilityId; permission?: Permission; desktop?: true; demo?: true };
  help?: HelpTopicKey;
  doc?: string;
  /** Where the tests open it: a seeded route, the demo persona to act as (its id), and what the seed must hold there. */
  sample: { route: string; persona?: number; expect?: DemoExampleExpect; surface?: 'demo' | 'desktop' };
}
```

The `data-tour` rules stay as they are (static value, kebab-case, set in exactly one component), and the registry
becomes their owner: the tour test's rule "every `data-tour` is a stop's target or folded section" becomes "every
`data-tour` is a registry anchor". The `data-shot` attributes stay the screenshot harness's API; an element can carry
both.

#### Coverage

"Every block someone could ask about" is turned into rules the tests can check:

| What | Count today | Rule |
| --- | --- | --- |
| Pages | 47 page files | One anchor per page: its heading area. |
| Tabs | the project, run, execution, cluster and test-case tabs | One anchor per tab, revealed by its `query`. |
| Blocks with inline help | 142 `help` props and 88 `HelpHint` uses | One anchor per block; its `help` names the topic. |
| Settings fields | 34 in `SETTINGS_PAGES` | One anchor per field. |
| Primary actions | the Next step, Diagnose with AI, Create issue, … | One anchor each. |
| Sidebar and command palette destinations | the sidebar's items | One anchor each. |

That is on the order of 300 to 400 anchors, against 26 today. The coverage test lists every page file, every settings
field and every help topic shown on a block, and fails on one without an anchor, unless it is in an exemption list
where each entry says why.

#### Two kinds of guide

- **Authored guides** (`app/utils/guides/`), in the shape of `TOUR_PROFILES`: fixed stops and fixed copy for the tasks
  people ask most. First list: report a first run, configure AI, add the SCM token, set up CI and sharding, turn on
  pull-request feedback, connect Jira, set up notifications, grant roles and groups, add the capture fixtures, connect
  an MCP client, schedule a quality report, run the Flake Lab, apply a locator fix, build a dashboard, set retention.
  They need no model: the command palette and the panel list them on any instance. The demo's four tours become
  authored guides in the same format and keep their four languages.
- **Composed guides**: the model finds anchors with `find_anchors`, orders them and writes each stop's title and body.
  The server checks the plan before it reaches the browser: every anchor exists; its `requires` hold for this user and
  this instance; each route parameter is an entity the user can read; at most 7 stops; a title of at most 60
  characters and a body of at most 360, with `**bold**` as the only markup, as for the tour. A stop's docs link comes
  from its anchor's `doc`, never from the model.

#### The engine

The engine part of `useDemoTour.ts` (navigation, reveal, scrolling the right panel, the highlight and its ring, the
ARIA attributes driver.js borrows) moves to `app/composables/useGuide.ts`; the demo tour keeps its prompt, languages
and profiles on top of it. It is mounted in every build and loads driver.js on first use, as the tour does. Additions:

- routes with parameters, filled from the plan;
- `reveal` steps beyond a single unfold: a tab through the URL, then folds and openers in order;
- a stop whose anchor does not render shows centered, with the anchor's `shownWhen` sentence;
- later, a "your turn" stop that leaves the target usable and moves on once the user did the step (today the target
  is inert and a navigation the guide did not make ends it).

#### How every anchor is tested

1. **Against the source** (Vitest, `tests/unit/guide-anchors.test.ts`): each anchor is the `data-tour` of exactly one
   element and every `data-tour` is an anchor; values are static and kebab-case; `page` matches a file of `app/pages`;
   `reveal` names anchors of the same page; `help` and `doc` resolve (the `docs-drift` rules); `describes` fits its
   length; the coverage rules above.
2. **Against the seed** (`tests/unit/demo-seed-consistency.test.ts`): every sample's `expect` holds on the generated
   seed, as for tour stops and demo examples.
3. **In the built demo** (`scripts/check-demo-runtime.mjs`, already in CI): every anchor opened at its sample, as its
   persona (the demo's "Acting as" picker), revealed, then found visible with a non-empty box inside its panel after
   the engine's scroll. Anchors are grouped by sample route so each page loads once. At 1280 px; the authored guides
   also at 390 px. Anchors marked `desktop` run in the screenshot harness's `desktop` mode, with its mocked Tauri
   bridge.
4. **Authored guides** are walked end to end, as the tours are today.
5. **Composed-guide checks** are unit-tested on fixture plans: unknown anchor, failing `requires`, unreadable entity,
   copy too long.

A change to the UI that moves, renames or removes an anchored element updates the registry in the same commit, as for
the tour today; `apps/application/AGENTS.md` gains that rule with PR 1.

### 7. The panel

A side panel in the default layout, a full-screen sheet below `sm`, opened from a header button, from the command
palette ("Ask Piwi" with the typed text as the question, and the authored guides as items) and from "Ask about this
page" suggestions authored per page pattern. It shows the streamed answer with its links; "What it read", the tools
called and the docs sections used, in the spirit of `CopyAiPromptButton`; a **Show me** button when a guide is
attached; proposal cards. A line under the input names the model and says that the question and what the assistant
reads are sent to it.

### 8. Nudges

Rule-based and model-free, like `shouldNudgeFixtures` (`shared/capability-nudge.ts`): a pure condition over facts the
page already loaded, and a guide or a prefilled question to offer. At most one per page view and a few a week;
dismissing one hides it for good. Dismissals are stored per user on the server (`assistant_nudge_dismissals`: user,
nudge, when), so a nudge dismissed in one browser stays dismissed in every other (D8); with authentication off, every
visitor is the same virtual administrator, so a dismissal holds for the whole instance. First candidates: Setup with
undecided capabilities; a diagnosis whose data coverage lacks the SCM diff on an instance with no SCM token; a failure
leading with a network clue while the capture fixtures are undecided (the existing nudge, offered as a guide).

### 9. Conversations, usage and limits

`assistant_conversations` and `assistant_messages` in both dialects: the messages, the blocks with the user's
answers and ticks, the tool calls' names and arguments, the model and the tokens of each turn. A conversation belongs
to its user: no route returns it to anyone else, administrators included (D7). Retention prunes them on their own
horizon (`retention.ts`). `getAiUsageSummary` counts assistant turns as their own kind, and a per-user daily token
cap and an instance cap stop a turn before the call.

### 10. Where it runs

- **Dashboard and desktop app**: the same panel, since the desktop app runs the same server. The desktop app adds the
  Claude Code loop and the desktop-only tools; `apply_locator_fix` writes a file, so it is a proposal card.
- **Demo**: no server and no key (D6). The demo answers a set of authored questions with replies computed from the
  seed, the way `app/demo/api/ai.ts` builds diagnoses, in the same blocks as a real answer, searches the bundled docs
  for the rest, and offers the authored guides. Every new route gets its demo handler (`app:check:demo`).
- **Editors**: the VS Code extension already registers the MCP server for the editor's own agents
  (`apps/vscode/src/extension.ts`); no panel is planned there.

### 11. Security

- **Access**: the user's own `McpContext`; anchors filtered by `requires`; a guide's entities checked against the
  user's scope before it is sent.
- **Untrusted text**: tool results carry test titles, error text, console lines, commit messages and issue comments.
  What the model's output can do is closed: blocks only from the list of section 5, rendered by components and never
  as HTML, links only to entities seen in tool results, docs links only from the registry, stops only on registry
  anchors, proposals only from the closed list, applied only by a click.
- **What leaves the instance**: only the calls to the configured model endpoint, as for diagnosis; the panel says so.
  A local model through the OpenAI-compatible provider keeps everything on the network.
- **Opting out**: an `assistant` capability in `CAPABILITIES` (`shared/capabilities.ts`), declinable for the instance;
  declined, the panel, its routes, its palette entries and the nudges that ask it a question are gone. The authored
  guides are not part of it: they need no model, so a nudge offering one stays, and so do its dismissals.

### 12. Measuring the answers

- **In CI, no tokens**: unit tests check each block's schema on fixtures (too many options, a choice naming an entity
  no tool returned, a title too long). A mock provider scripts the model's replies, so an E2E drives the loop (a tool
  call, its result, the answer), renders every block, answers a question with checkboxes and sees the ids reach the
  next turn, and takes a guide plan through validation and a proposal card to its REST route. A screenshot scene
  captures the panel with each block, at 390 and 1280 px.
- **On demand, with tokens** (`tests/live/`): about 150 questions over the seed, each with the tools it should call,
  the facts its answer must contain (from `failure-stories.mjs` and `demo-examples.mjs`) and, for "show me" questions,
  the anchors its guide should use. The run scores each model.

## Decisions

Decided on 2026-10-22.

| # | Decision |
| --- | --- |
| D1 | **Guides point only at registry anchors.** The model picks anchors by id; it never names an element, a selector or a position itself. |
| D2 | **Every anchor is tested, and the registry covers the dashboard**: an anchor ships with its sample and passes the source, seed and built-demo checks; the coverage rules fail on a page, a settings field or a help-hinted block without one. |
| D3 | **Finding elements from the page's ARIA snapshot is deferred** ([below](#later-finding-elements-from-the-pages-aria-snapshot)). |
| D4 | **A dedicated `assistant` AI role**, reusing the diagnosis model until it is set (section 1). |
| D5 | **The first release tells and shows; proposal cards come in PR 6.** Until then a "do it" answer is a guide to the action. |
| D6 | **The demo answers authored questions** with replies computed from the seed. No bring-your-own-key field. |
| D7 | **Conversations are private to their user** and pruned by retention; administrators cannot read them. |
| D8 | **Nudge dismissals are kept per user on the server**, so a dismissal follows the user to every browser. |

No question is open; the next step is PR 1.

## Delivery plan

Rough effort in developer-weeks, for someone who knows the codebase. PR 1 to PR 3 need no model.

| PR | Contents | Effort |
| --- | --- | --- |
| 1 | `useGuide` extracted from the tour; `shared/guide-anchors/` with the 26 tour anchors; the source and seed checks; the built-demo anchor pass; the tours on the registry; the AGENTS.md rule. Nothing changes for a user. | 2 |
| 2 | Anchor coverage: pages, tabs, settings fields, help-hinted blocks, primary actions, with their samples; the coverage test. Can split by area (failure pages, project tabs, settings, analytics, desktop). | 3–4 |
| 3 | Authored guides for the first list, from the command palette, on every instance. | 2 |
| 4 | The `assistant` role; the agent loop for Anthropic and OpenAI-compatible endpoints; tool routing; the assistant tools; conversations, usage, limits; the mock-provider E2E; the 1.0 register entry for its routes. | 3–4 |
| 5 | The panel: tell and show me (composed guides), the answer blocks (text, code, patch, entity, options, question, checklist), page context, the capability, the docs page, the demo's answers. | 4 |
| 6 | Do it: proposal cards, including from a question's picks; `explain_setting`. | 1–2 |
| 7 | Desktop: the Claude Code loop, the desktop tools. | 1 |
| 8 | Nudges. | 1 |
| 9 | The live question set. | 1–2 |

## Later: finding elements from the page's ARIA snapshot

The alternative to a registry: give the model the page's accessibility tree and let it pick the element, as the
reporter's AI steps do (`page.piwiLocator()`, `piwiRun()`: role, name and `[ref]` chosen from a trimmed snapshot, with
page content treated as untrusted, `shared/ai-step-resolution.ts`). It would cover every control with no list to keep.

Measured on 2026-10-22 on the seeded dev server with Playwright 1.63's `ariaSnapshot({ mode: 'ai' })`, the snapshot the
AI steps send, on ten pages and on the 23 tour stops that open a page. Tokens are characters divided by 4; the ref
markers tokenize worse, so the real counts are higher.

| | Result |
| --- | --- |
| Main panel, as loaded | 3,400 to 20,000 tokens a page, median about 6,000; the sidebar adds 1,000 to 2,000 |
| Kept to controls, headings and landmarks | 300 to 3,000 tokens, median about 1,200 |
| Controls with no accessible name | none on 8 of the 10 pages; 15 on Analytics (the Insights cards), 1 on Settings → AI |
| Controls sharing a role and a name | up to 72 on Home (one set of row actions per inbox row), 39 on Setup ("Docs" ×29); the ref tells them apart |
| Not in the snapshot until clicked | execution page: 16 folded sections, 14 tabs of which 3 open; cluster page: 11 folded sections, 8 tabs of which 1 open |
| Tour targets | 22 of 23 render on load; the diagnosis fix on cluster 10 exists only once More ways to fix is unfolded |
| How those 22 can be named | 3 carry their own role and name (an inbox row's button, the "Feature map" image, the "Headline numbers" region); 15 are unnamed containers; 11 have a heading near the top; the rest can be told only by their content |

What that says:

- **Labels are not the obstacle.** Almost every control has a usable accessible name.
- **What is not rendered is.** A large part of each detail page sits behind tabs and folds, and other pages are not in
  the snapshot at all, so a guide across pages needs a model call per page visited; a registry plans the whole guide
  in one call and the engine plays it with none.
- **Blocks are harder than controls.** Cut down to controls and headings, a snapshot loses the text that identifies an
  unnamed block such as the situation block; kept whole, it costs up to 20,000 tokens a page.
- **A wrong pick fails silently.** No test catches the model highlighting the block next to the right one.

If it comes back, the measured shape is: a map generated by crawling the seeded app (every page, tab and fold, with
the structure kept and the data stripped) to plan from, and a cut-down live snapshot only to find a stop's element when
the registry has none. The registry this plan builds is then its benchmark: each anchor's `describes` is a "show me"
question with a known right answer. Finding elements live needs code in the page that computes roles and accessible
names (Playwright's snapshot does not run in a user's browser); `@piwitests/picker-dom` computes roles, not yet names.
No model has been run against these snapshots.

## Risks

- **Upkeep.** Each reworked block touches the registry. The tests name the anchor and what broke, and an entry is a
  few lines; the tour has worked this way since it shipped.
- **CI time.** The built-demo pass grows with the anchors. Grouping by sample route keeps it to one load per page;
  it can shard like the performance suite if it grows past that.
- **Answer quality.** A model can be confidently wrong. The closed outputs (section 11), the citation rule and the live
  question set bound it; they do not remove it.
- **Weak local models.** Tool calling fails on small models; the connection test detects it and the assistant falls
  back to the docs, saying so.
- **Cost.** Bounded by the limits and caps of sections 2 and 9; the core tool set and caching keep a turn's input
  small.

## Not in this plan

- Finding elements from the page's ARIA snapshot ([above](#later-finding-elements-from-the-pages-aria-snapshot)).
- The model operating the UI: it reveals tabs, folds and openers the registry declares, nothing else.
- A chat panel in the VS Code and JetBrains plugins; asking from Slack or Teams, which would need inbound integrations
  that do not exist.
- Translating the dashboard. Authored guides are in English like the dashboard; the demo's tours keep their four
  languages.
- Administrators reading users' conversations (D7), and reports on what users ask.
- Charts, generated pages, images and file uploads in answers (section 5).
