# In-app assistant: agent guide

Rules for the in-app assistant (`server/utils/assistant/`, `server/api/assistant/`, `app/components/assistant/`,
`app/utils/assistant/`, `app/utils/nudges/`, `shared/assistant*.ts`). Read [`../../../AGENTS.md`](../../../AGENTS.md)
first; the tools it calls follow [`../mcp/AGENTS.md`](../mcp/AGENTS.md).

## How it answers

The in-app assistant answers questions with the `assistant` AI role (the diagnosis role when unset) by calling the MCP
tools in-process: the loop and its tools in `server/utils/assistant/`, the model calls with tools in
`server/utils/ai-tool-calls.ts`, the routes under `server/api/assistant/`, the wire shapes in `shared/assistant.ts`
and the conversations in `shared/handlers/assistant.ts` (shared with the demo). The panel (`app/components/assistant/`,
`useAssistant`, its pure parts in `app/utils/assistant/`) renders every block with the dashboard's own components,
links a `piwi:` entity only when it is in the conversation's known entities (`assistantKnownEntities`), and plays a
composed guide through `useGuide`.

- **The model is offered read tools only.** `assistantReadTools` drops every tool that declares a `permission` and
  every desktop-only tool but `read_local_source` on the desktop app, which the assistant wraps to read only inside
  the folder linked to a project the user reads (`server/utils/assistant/local-source.ts`), so a new write tool is
  never offered. `apply_locator_fix` and `import_local_report` write and stay out. Never add a tool that writes to the
  assistant's set, not even through `find_tools`.
- **Tools run with the asking user's context.** The route builds the `McpContext` with `requestMcpContext`, as `/mcp`
  does, and both filter the catalog with `toolsForCaller` (`server/utils/mcp/catalog.ts`). Never call a handler with a
  wider context than the caller's.
- **With the Claude Code CLI, one CLI run writes the answer** (`server/utils/assistant/claude-code.ts`, when
  `claudeCliRunsAgents` finds the options in `claude --help`; otherwise the CLI answers step by step in the JSON
  action mode). Its only MCP server is the answer's endpoint, `POST /api/assistant/conversations/:id/mcp`
  (`turn-mcp.ts`), which serves that answer's toolbox and runs each call through the same answer as the loop
  (`answer.ts`: the events, the tool-call limit, nothing after a question block). It authenticates with a token
  minted per user, conversation and answer (`turn-token.ts`), kept as a hash in memory, revoked when the answer ends
  and refused past its time limit, for another conversation, on any other route and from a host, origin or peer that
  is not loopback. The token goes to the CLI in a `--mcp-config` file, never on its command line; never hand the CLI
  the desktop token or an API key. On the desktop app the guard lets that one route through on that token alone
  (`presentsAssistantTurnToken`); any other route keeps needing the desktop token.
- **The Codex CLI uses the same turn endpoint and token** (`ai-codex-cli.ts`, injected into `runClaudeCodeTurn`).
  Every invocation has a private home and working directory, a file-backed ChatGPT login snapshot, an allowlisted
  environment, disabled feature flags and model metadata with no built-in execution or filesystem tools. Only the
  turn's `piwi` MCP server and allowed tools are configured. Never import the user's Codex config, tools, plugins,
  skills, unrelated credentials or API keys into that invocation.
- **The official DeepSeek CLI uses a generated profile with no inherited bundles** (`ai-deepseek-cli.ts`). Its
  explicit roster contains official model and agent plugins and, for an assistant turn, only the turn's Piwi MCP
  client. No built-in shell, filesystem, web, skill or plugin-management tools are mounted. Copy only the selected
  DeepSeek account grant or API key; never import user profiles, unrelated credential records or endpoint overrides.
- **A conversation is never returned to another user**, administrators included. Every read in
  `shared/handlers/assistant.ts` is narrowed to the owner (`assistantOwnerOf`: the user's id, or null with
  authentication off), and a miss answers 404.
- **Tool routing** is `CORE_ASSISTANT_TOOLS` and `PAGE_TOOLS` (an `app/pages` pattern → tool names) in
  `server/utils/assistant/tools.ts`; `tests/unit/assistant-tools.test.ts` checks every name is a read tool and every
  pattern a page.
- **Usage outlives a conversation.** Each answer that called a model writes an `assistant_usage` row, which the daily
  caps and Settings → AI → AI usage read; deleting a conversation never deletes it. The status gives the caller the
  cap that binds first (`assistantAllowanceStatus`), which the panel's gauge shows and which stops its input once
  spent; with the Claude Code CLI, also the subscription's usage window from the CLI's last `rate_limit_event`
  (`getClaudeCliRateLimit`, kept in memory), which only warns: the subscription decides.
- **Stop is a request to the server.** An answer runs to its end when the browser leaves, so **Stop** posts
  `…/conversations/:id/stop`, which aborts the answer this process is writing (`server/utils/assistant/running.ts`,
  the same registry that refuses a second question with a 409); the loop and the CLI runs (Claude Code, Codex,
  DeepSeek) end with the `stopped` error and the answer is stored with what it wrote. The demo stops its prepared
  answer the same way.
- **The next question is a block the model sends last.** `suggest_next` makes a `next` block, refused until the
  answer holds something, that ends the answer like a question block, so it costs no further model call. The panel
  never renders it in the answer: the input offers it as its placeholder (`nextAssistantQuestion`), else the page's
  first suggestion not asked yet, which is all the demo offers.
- **The question history is the user's, on the server.** `GET /api/assistant/questions` reads the owner's typed
  questions across their conversations, leaving out the replies to a block; never keep questions in the browser's
  storage, where another user of the same browser would read them. The panel's docked state and width are
  per-browser conveniences and do live in `localStorage` (`useAssistantDock`).
- **The panel docks beside the page from 1280 px** (`AssistantPanel`, an `aside` in the dashboard group, after
  `main`); below 1536 px it folds the sidebar through Nuxt UI's `dashboard:sidebar:collapse` hook and unfolds it when
  it closes, if it folded it. A spec finds the panel in either form:
  `getByRole('dialog', { name: 'Ask Piwi' }).or(getByRole('complementary', { name: 'Ask Piwi' }))`.
- **An answer's blocks are checked on the server, against limits kept in one place.** Every block but text is a call
  to a block tool (`server/utils/assistant/blocks.ts`); `shared/assistant-blocks.ts` holds `ASSISTANT_BLOCK_LIMITS`,
  the zod schema of each tool's arguments (its input schema is derived from it, so the model reads the same limits)
  and the checks that need no database. A block that fails is never sent: the tool result says why. A `question` or
  `options` block ends the answer; the user's pick comes back as the next question's `reply`, recorded on the block
  (`recordAssistantReply`) and handed to the model as data.
- **Entities come from tool results only.** `extractEntities` (`server/utils/assistant/entities.ts`) reads each read
  tool's result by the field conventions of the MCP tools (the tool's own `id`, by `TOOL_ENTITY`; objects under keys
  such as `project` or `recentExecutions`; the `…Id` fields), and the tool call stores them. The conversation's set
  is the stored calls of all its answers: a card, a choice or a patch target outside it is refused, and the panel
  links `piwi:<type>/<id>` only to one in it. A read tool whose top-level `id` is an entity gets its `TOOL_ENTITY` line.
- **Guide plans are checked server-side** (`server/utils/assistant/guides.ts`), and `find_anchors` filters the same
  way: registry anchors only, their `requires` holding for this user and instance (never a demo-only one; on a
  project's pages a capability follows that project's states, read by `readProjectStates`), each route on one of its
  anchor's pages, its ids readable by the user (`checkRouteEntities`, as `checkEntityScope` checks
  an MCP tool's), a route wherever the anchor's page has an id the user is not on, at most 7 stops, copy within the
  tour's limits with `**bold**` only. A `navigate` route is checked the same way. A page with another kind of `[id]`
  gets its `ROUTE_ENTITIES` line, or its routes are refused. The question's context lists the anchors rendered on the
  page (`renderedAnchors`, the visible `data-tour` values), which `find_anchors` ranks first.
- **A change is a proposal the user applies; the model never writes.** `propose_change` makes a `proposal` block from
  the closed registry `ASSISTANT_ACTIONS` (`shared/assistant-actions.ts`), shown only when the action's parameters
  pass its schema, its target is an entity of the conversation of the kind it changes, its capability is declined
  neither for the target's project nor on the instance (a project may enable one the instance declined), and the user
  holds its permission on the target's project (on the instance when it has no target). **Apply** calls the action's own REST
  route from the browser with the user's session (`assistantActionRequest`), then records the outcome through
  `PATCH …/messages/:messageId/proposal`. A new action is one registry entry naming an existing route, its method, the
  permission that route declares in `x-required-permission` and the pure path and body builders;
  `tests/unit/assistant-actions.test.ts` reads each route's file and fails on a route or permission that does not
  match. Never add an action whose route does not exist yet, nor one the browser could not call with a click.
- **`explain_setting`** (`server/utils/assistant/settings.ts`) reads `SETTINGS_PAGES` and `HELP_TOPICS` from
  `shared/`. Which variables the environment sets, and a field's value, go only to a user who may open its page; a
  value comes from a `READERS` line that reads it as that page's own endpoint does, a secret only as set or not set, a
  variable's value never.
- **The demo answers prepared questions, each computed from the seed.** With no model, the demo's assistant answers
  `DEMO_ASSISTANT_QUESTIONS` (`shared/demo/assistant-questions.mjs`: each question's answer, the pages it is offered
  on, which are the demo's **Ask about this page** suggestions, and a seeded sample route). `app/demo/api/assistant-match.ts`
  matches a typed question to an answer by its words and its page; `app/demo/api/assistant-answers.ts` computes the
  answer from the in-browser database through the shared handlers the read tools call, each read streamed as the
  `tool` the server's assistant would call, with the entities it named, its blocks made through
  `checkAssistantBlock`, its guides from `rankAnchors` (on a project's pages, with that project's capability states,
  as the server reads them) and the authored guides, its proposals held to the action's capability and permission on
  the target's project, and a reply to one of its blocks answered with the follow-up. A question no
  answer matches gets the page's prepared questions to pick from and the authored guides that fit it. Never write a
  seeded fact into an answer: read it. `tests/unit/demo-assistant-answers.test.ts` computes every answer at its sample
  on the generated seed and `scripts/check-demo-runtime.mjs` asks one of each from the panel in the built demo; a seed
  change that breaks one updates the answer or its sample, never the check.

### Nudges

A nudge is the one thing the assistant shows unasked: a suggestion on a page, offering an authored guide (**Show me**)
or a question the panel opens on and asks (**Ask**), when a rule over what the page already loaded holds.

- **One registry**: `NUDGES` in `app/utils/nudges/nudges.ts`, all pure. A nudge has an id, its page (a pattern of
  `app/pages`), its rule over that page's facts (`NudgePageFacts`), its offer, its words (a title ≤ 60 characters and
  one or two plain sentences, in the docs' voice) and its `requires`; a guide offer also needs its guide's `requires`,
  a question an AI model. Its id is in `ASSISTANT_NUDGE_IDS` (`shared/assistant-nudges.ts`), the only ids the
  dismissal routes accept, which their meta's `enum` lists. A new nudge is its id there and in both routes' `enum`,
  its `NUDGES` entry, its page placing `<AssistantNudge page="…" :facts="…">` and its row on
  `apps/docs/features/guides.md`; `tests/unit/assistant-nudges.test.ts` checks the ids, the placement, the copy and
  each rule both ways.
- **No model call, ever, and no fetch of its own**: a rule reads only what its page already loaded.
- **The budget keeps them rare**: a page view shows one nudge at most and asks the budget once, and a browser shows at
  most `NUDGE_BUDGET` (3) in seven days, counted in `localStorage['piwi-nudges']` (`app/utils/nudges/budget.ts`).
  Never raise it to make room for a nudge.
- **A dismissal lives on the server**, one row per owner and nudge in `assistant_nudge_dismissals` (the owner as
  `assistantOwnerOf` reads it: null with authentication off, when a dismissal holds for the whole instance), through
  `shared/handlers/assistant-nudges.ts`, shared with the demo; deleting a user deletes theirs. Never keep one in the
  browser alone: **Don't show again** holds in every browser.
- **Declining the assistant hides only the nudges that ask it**: a guide needs no model, so a nudge offering one keeps
  showing while the `assistant` capability (or AI) is declined, and the dismissal routes keep answering; a question's
  nudge shows only while the assistant can answer (`canAsk`). The card renders in the browser only, after the page's
  first paint.
