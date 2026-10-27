# In-app assistant: agent guide

Rules for the in-app assistant (`server/utils/assistant/`, `server/api/assistant/`, `app/components/assistant/`,
`app/utils/assistant/`, `app/utils/nudges/`, `shared/assistant*.ts`). Read [`../../../AGENTS.md`](../../../AGENTS.md)
first; the tools it calls follow [`../mcp/AGENTS.md`](../mcp/AGENTS.md). Where each part lives:
[`ARCHITECTURE.md`](../../../ARCHITECTURE.md#backend). A file named below without a folder is in
`server/utils/assistant/`.

The assistant answers with the `assistant` AI role (the diagnosis role when it is unset). A **turn** answers one
question: the model reads through the MCP read tools and writes the **answer** (`answer.ts`), a message made of text
and blocks whose wire shapes are in `shared/assistant.ts`. Either `loop.ts` calls the model step by step and runs its
tool calls in-process, or an AI CLI calls the tools itself through the turn's MCP endpoint (`claude-code.ts`).

## What the model may do

- **The model is offered read tools only.** `assistantReadTools` (`tools.ts`) keeps the tools that declare no
  `permission` and leaves out every desktop-only tool. The one exception is `read_local_source` on the desktop app,
  wrapped to read only inside the folder linked to a project the user reads (`local-source.ts`). `apply_locator_fix`
  and `import_local_report` write and stay out. Never add a tool that writes to the assistant's set, not even through
  `find_tools`.
- **Tools run with the asking user's context.** The route builds the `McpContext` with `requestMcpContext`, as `/mcp`
  does, and both filter the catalog with `toolsForCaller` (`server/utils/mcp/catalog.ts`). Never call a handler with a
  wider context than the caller's.
- **Tool routing** is `CORE_ASSISTANT_TOOLS` and `PAGE_TOOLS` (an `app/pages` pattern to its tool names) in `tools.ts`;
  `tests/unit/assistant-tools.test.ts` checks every name is a read tool and every pattern a page.
- **A change is a proposal the user applies; the model never writes.** `propose_change` makes a `proposal` block from
  the closed registry `ASSISTANT_ACTIONS` (`shared/assistant-actions.ts`). The block is shown only when the action's
  parameters pass its schema, its target is an entity of the conversation of the kind it changes, its capability is
  declined neither for the target's project nor on the instance (a project may enable one the instance declined), and
  the user holds its permission on the target's project (on the instance when it has no target). **Apply** calls the
  action's own REST route from the browser with the user's session (`assistantActionRequest`), then records the
  outcome through `PATCH …/messages/:messageId/proposal`.
- **A new action is one registry entry naming an existing route**: its method, the permission that route declares in
  `x-required-permission`, and pure builders of its path and body. `tests/unit/assistant-actions.test.ts` reads each
  route's file and fails on a route or a permission that does not match. Never add an action whose route does not exist
  yet, nor one the browser could not call with a click.
- **`explain_setting`** (`settings.ts`) reads `SETTINGS_PAGES` and `HELP_TOPICS` from `shared/`. Which variables the
  environment sets, and a field's value, go only to a user who may open the field's page. A value comes from a
  `READERS` line that reads it as that page's own endpoint does; a secret is reported only as set or not set, and a
  variable's value never.

## Turns run by an AI CLI

- **With the Claude Code CLI, one CLI run writes the answer** (`claude-code.ts`, when `claudeCliRunsAgents` finds the
  options it needs in `claude --help`; otherwise the CLI answers step by step, in the JSON action mode). Its only MCP
  server is the turn's endpoint, `POST /api/assistant/conversations/:id/mcp` (`turn-mcp.ts`). The endpoint serves the
  turn's tools and runs each call through the same answer as the loop (`answer.ts`: the same events, the same
  tool-call limit, nothing after a question block).
- **The turn's token opens that endpoint only.** It is minted for one user, conversation and turn (`turn-token.ts`),
  kept as a hash in memory and revoked when the turn ends. It is refused past the turn's time limit, for another
  conversation, on any other route, and from a host, origin or peer that is not loopback. The CLI gets it in a
  `--mcp-config` file, never on its command line; never hand the CLI the desktop token or an API key. On the desktop
  app, the guard lets that one route through on that token alone (`presentsAssistantTurnToken`); every other route
  still needs the desktop token.
- **The Codex and DeepSeek CLIs use the same endpoint and token**: `turn.ts` passes their `run` (`runCodexCliAgent`,
  `runDeepseekCliAgent`) to `runClaudeCodeTurn`. How each CLI is isolated:
  [`../AGENTS.md`](../AGENTS.md#ai-cli-providers).

## Conversations, usage and Stop

- **A conversation is never returned to another user**, administrators included. Every read in
  `shared/handlers/assistant.ts` is narrowed to the owner, as `assistantOwnerOf` (`turn.ts`) gives it: the user's id,
  or null with authentication off. A miss answers 404.
- **Usage outlives a conversation.** Each answer that called a model writes an `assistant_usage` row, which the daily
  caps and Settings → AI → AI usage read; deleting a conversation never deletes it. The status gives the caller the cap
  that binds first (`assistantAllowanceStatus`), which the panel's gauge shows and which stops its input once spent.
  With the Claude Code CLI it also gives the subscription's usage window from the CLI's last `rate_limit_event`
  (`getClaudeCliRateLimit`, kept in memory), which only warns: the subscription decides.
- **Stop is a request to the server.** An answer runs to its end when the browser leaves, so **Stop** posts
  `…/conversations/:id/stop`. It aborts the answer this process is writing (`running.ts`, the same registry that
  refuses a second question with a 409). The loop and the CLI runs (Claude Code, Codex, DeepSeek) end with the
  `stopped` error, and the answer is stored with what it wrote. The demo stops its prepared answer the same way.
- **The question history is the user's, on the server.** `GET /api/assistant/questions` reads the owner's typed
  questions across their conversations, leaving out the replies to a block. Never keep questions in the browser's
  storage, where another user of the same browser would read them. The panel's docked state and width are per-browser
  conveniences and do live in `localStorage` (`useAssistantDock`).

## Blocks, entities and guides

- **An answer's blocks are checked on the server, against limits kept in one place.** Every block but text is a call
  to a block tool (`blocks.ts`). `shared/assistant-blocks.ts` holds `ASSISTANT_BLOCK_LIMITS`, the zod schema of each
  tool's arguments (its input schema is derived from it, so the model reads the same limits) and the checks that need
  no database. A block that fails is never sent: the tool result says why.
- **A `question` or `options` block ends the answer.** The user's pick comes back as the next question's `reply`,
  recorded on the block (`recordAssistantReply`) and handed to the model as data.
- **The next question is a block the model sends last.** `suggest_next` makes a `next` block, refused until the answer
  holds something; it ends the answer like a question block, so it costs no further model call. The panel never
  renders it in the answer: the input offers it as its placeholder (`nextAssistantQuestion`), else the page's first
  suggestion not asked yet, which is all the demo offers.
- **Entities come from tool results only.** `extractEntities` (`entities.ts`) reads each read tool's result by the field
  conventions of the MCP tools (the tool's own `id`, through `TOOL_ENTITY`; the objects under keys such as `project` or
  `recentExecutions`; the `…Id` fields), and the tool call stores them. A conversation's entities are the stored calls
  of all its answers: a card, a choice or a patch target outside them is refused, and the panel links `piwi:<type>/<id>`
  only to one of them (`assistantKnownEntities`). A read tool whose top-level `id` is an entity gets its `TOOL_ENTITY`
  line.
- **Guide plans and `navigate` routes are checked on the server** (`guides.ts`, whose header lists the checks), and
  `find_anchors` filters the anchor registry the same way. Anchors come from the registry only, with their `requires`
  holding for this user and instance (never a demo-only one; on a project's pages, a capability follows that project's
  states, read by `readProjectStates`). A route opens one of its anchor's pages and names only ids the user can read
  (`checkRouteEntities`, as `checkEntityScope` checks an MCP tool's). Stops stay within
  `ASSISTANT_BLOCK_LIMITS.maxGuideStops` and the tour's copy limits, with `**bold**` as the only markup.
- **A page whose `[id]` is a new kind of entity gets its `ROUTE_ENTITIES` line** in `guides.ts`, or its routes are
  refused. The question's context lists the anchors rendered on the page (`renderedAnchors`, the visible `data-tour`
  values), which `find_anchors` ranks first.

## Panel

- **A spec finds the panel in both of its forms**:
  `getByRole('dialog', { name: 'Ask Piwi' }).or(getByRole('complementary', { name: 'Ask Piwi' }))`. From 1280 px the
  panel docks beside the page (`AssistantPanel`, an `aside` after `main` in the dashboard group) unless the user floats
  it; otherwise it is a slide-over dialog.
- **The docked panel unfolds the sidebar only if it folded it.** Below 1536 px it folds the sidebar through Nuxt UI's
  `dashboard:sidebar:collapse` hook when it opens.

## Demo

- **The demo answers prepared questions, computed from the seed.** With no model, it answers
  `DEMO_ASSISTANT_QUESTIONS` (`shared/demo/assistant-questions.mjs`: each question's answer, the pages that offer it as
  an **Ask about this page** suggestion, and a seeded sample route). `app/demo/api/assistant-match.ts` matches a typed
  question to an answer by its words and its page. `app/demo/api/assistant-answers.ts` computes the answer from the
  in-browser database through the shared handlers the read tools call: each read is streamed as the `tool` the
  server's assistant would call, with the entities it named; its blocks go through `checkAssistantBlock`; its guides
  come from `rankAnchors` (on a project's pages, with that project's capability states, as the server reads them) and
  the authored guides; its proposals are held to the action's capability and permission on the target's project; and
  a reply to one of its blocks gets the follow-up. A question no answer matches gets the page's prepared questions to
  pick from, and the authored guides that fit it.
- **Never write a seeded fact into a prepared answer: read it.** `tests/unit/demo-assistant-answers.test.ts` computes
  every answer at its sample on the generated seed, and `scripts/check-demo-runtime.mjs` asks one question of each kind
  from the panel of the built demo. A seed change that breaks one updates the answer or its sample, never the check.

### Nudges

A nudge is the one thing the assistant shows unasked: a suggestion on a page, offering an authored guide (**Show me**)
or a question the panel opens on and asks (**Ask**), when a rule over what the page already loaded holds.

- **One registry**: `NUDGES` in `app/utils/nudges/nudges.ts`, all pure. A nudge has an id, its page (an `app/pages`
  pattern), its rule over that page's facts (`NudgePageFacts`), its offer, its words (a title of at most 60 characters
  and one or two plain sentences, in the docs' voice) and its `requires`; a guide offer also needs its guide's
  `requires`, and a question an AI model.
- **A new nudge** is its id in `ASSISTANT_NUDGE_IDS` (`shared/assistant-nudges.ts`, the only ids the dismissal routes
  accept) and in the `enum` of both routes' meta, its `NUDGES` entry, `<AssistantNudge page="…" :facts="…">` on its
  page, and its row in the _Suggested on a page_ table of `apps/docs/features/guides.md`.
  `tests/unit/assistant-nudges.test.ts` checks the ids, the placement, the copy and each rule both ways.
- **No model call, ever, and no fetch of its own**: a rule reads only what its page already loaded.
- **The budget keeps nudges rare**: a page view shows one at most and asks the budget once, and a browser shows at most
  `NUDGE_BUDGET` (3) in seven days, counted in `localStorage['piwi-nudges']` (`app/utils/nudges/budget.ts`). Never
  raise it to make room for a nudge.
- **A dismissal lives on the server**: one row per owner and nudge in `assistant_nudge_dismissals`, through
  `shared/handlers/assistant-nudges.ts`, shared with the demo. The owner is read as `assistantOwnerOf` gives it (null
  with authentication off, when a dismissal holds for the whole instance), and deleting a user deletes theirs. Never
  keep one in the browser alone: **Don't show again** holds in every browser.
- **Declining the assistant hides only the nudges that ask it.** A guide needs no model, so a nudge offering one keeps
  showing while the `assistant` capability (or AI) is declined, and the dismissal routes keep answering; a question's
  nudge shows only while the assistant can answer (`canAsk`). The card renders in the browser only, after the page's
  first paint.
