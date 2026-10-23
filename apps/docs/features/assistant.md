---
title: Assistant
description: "Ask about your runs, failures and setup: your AI model answers from the read tools agents use, with your access, and changes nothing unless you click Apply on a change it proposes."
lang: en-US
---

# Assistant

<Needs reporter llm />

The assistant answers questions about this instance: why a run failed, which tests are flaky, what a setting does,
whether a capability is on. Your AI model writes the answer from the same read tools the [MCP server](./mcp) gives
coding agents, called with the access of the person asking, and from Piwi's documentation bundled with the server,
so it can say only what the data and the docs say. It changes nothing until you click **Apply** on a change it
proposes.

## Asking a question

Click **Ask Piwi** in the sidebar, under the search, or open the command palette (`Ctrl` + `K`, `⌘` + `K` on macOS),
type a question and pick **Ask Piwi**. The palette also offers a few **Ask about this page** questions for the page you
are on, and so does an empty conversation. The panel opens beside the page, or over the whole screen on a phone, and
keeps its conversation while you move between pages, so you can follow a link in an answer and read on.

Each question carries the page it was asked on: its address, which page it is, its tab and filters, the project it
shows and the parts of it a guide can point at. "Why did this fail?" asked on an execution needs no ids. The clock
icon lists your conversations, to reopen or delete one; the pen starts a new one.

The answer streams in as it is written, with a line for each tool it calls. The API reference (`/docs` in your
instance, or the [demo's](https://piwitests.dev/demo/docs)) lists the conversations' routes under **Assistant**.

The [live demo](https://piwitests.dev/demo/) has no model: it answers the prepared questions **Ask about this page**
lists, each computed from its sample data in your browser, and offers them and the authored guides for any other
question.

With no AI provider configured, the panel says so and links Settings → AI for those who can change it.

## What an answer contains

An answer is text and blocks, each drawn by the dashboard's own components; the model sends no HTML.

- **Text**: Markdown with headings, lists, tables and code. A run, execution, failure cluster, test or project links to
  its page only when a tool result of the conversation named it; any other name stays plain text, so the model cannot
  link to something it never read.
- **Code and commands**: a snippet with a copy button, and a shell command in bash and, when it differs, PowerShell.
- **A patch**: a unified diff with the badge its check against the files at the run's commit gave it, as on a
  [diagnosis](./ai-diagnosis), and its download, apply command and copy buttons.
- **A card** for a run, an execution, a cluster or a test, in its outcome's color, drawn from the tool result.
- **Options**: two to four ways to solve the problem, each with its trade-off and effort, one marked recommended.
  **Choose** sends your pick as the next question.
- **A question** with radio buttons or checkboxes and an **Other** field. **Answer** sends your picks back in words and
  by id, so the model reads exactly what you picked.
- **A checklist**: steps to do in order, some with their command. Your ticks are saved with the conversation.
- **Show me**: a guide on your own screens. The panel closes and a popover walks you through the parts of the
  dashboard the answer is about, each linking its docs page: only parts Piwi lists and tests for guides, never an
  element the model picked.
- **A link** to the page to open next.
- **A proposed change** to apply with a click ([below](#proposed-changes)).

Under each answer, **What it read** unfolds the tools it called, one line each, and names the model. The line under
the question field names the model too, and says that your question and what the assistant reads are sent to it.

## Proposed changes

Asked to do something ("resolve this cluster"), the assistant answers with a card per change, with **Apply** and
**Dismiss**. Nothing runs until you click **Apply**: the dashboard sends the request its own button sends, with your
session, and reloads the page. The card keeps what became of it, or why it was refused. A card can resolve, ignore or
reopen a failure cluster, quarantine or release a test, start a diagnosis, keep a run or decline a capability, and
shows only when you hold the permission it needs; to act on several tests, it first lets you tick them.

## What it reads

Each question is offered a core set of read tools (search, projects, runs, failure clusters, a failure's evidence,
flaky tests, fix plans and the documentation), the tools of the page the question was asked on, and any it adds with
`find_tools`. `get_instance_config` tells it how this instance is set up: the capabilities' states, the AI roles'
providers and models (never a key), the connected issue trackers and whether authentication is on. Storage and
retention are shown to administrators only. `explain_setting` explains a settings field and its `PIWI_*` variables;
which are set, and its value, go only to those who can open its page, a secret only as set or not.

- **Your access.** The tools run as you: a Member reads only the projects they hold a role on, as in the dashboard.
- **No writes.** No tool that changes anything is offered; you apply a change yourself ([above](#proposed-changes)).
- **Tool results are data.** Test titles, error text, console lines and commit messages reach the model as data,
  never as instructions, and each result is cut to 12,000 characters.
- **Sources.** The answer names the tool results and the docs sections it used and links the runs, clusters and tests
  it mentions; each stored answer lists the tools it called, with their arguments.

## The model

The assistant answers with the **Assistant model** role of Settings → AI ([model roles](/guide/ai-provider#model-roles)).
Left unset, it uses the diagnosis model's provider, key and model, so an instance with AI configured has an assistant
with no further setup; set it to point the assistant at a faster, cheaper model while diagnosis keeps the strong one.
The response language and the global and project instructions apply as they do to [AI diagnosis](./ai-diagnosis).

Anthropic models and most OpenAI-compatible servers call tools natively. With the Claude Code CLI (the desktop app, or
a server with `PIWI_CLAUDE_CLI_PATH`), one Claude Code run writes the whole answer: its only MCP server is this server's
endpoint for that answer, which offers the assistant's tools and nothing else, through a token that works for that
answer only. The desktop app's own token never goes to the CLI. A server that refuses tools, and a Claude Code version
without the options this needs, answer in a JSON action mode instead: each reply is one tool call or the answer. The
assistant's status says which mode a model uses once it is known.

In the desktop app the assistant can also read a file's current code, only inside the folder linked to the project.
It never changes a file or imports a run.

## What leaves the instance

Only the calls to the model endpoint you configured, as for AI diagnosis: the question, the page it was asked on, the
earlier exchanges of the conversation and what the tools return. A local model through the OpenAI-compatible provider
keeps everything on your network.

## Privacy

A conversation belongs to the person who started it. No route returns it to anyone else, administrators included;
with authentication off every visitor is the same administrator and shares one list. Deleting a user deletes their
conversations, and the nightly sweep deletes a conversation `PIWI_ASSISTANT_RETENTION_DAYS` after its last message
(90 days by default).

## Limits

| Limit | Default |
| --- | --- |
| Tool calls for one question | 8 |
| Output tokens of one model call | 2,048 |
| Time for one question | 180 seconds |
| Tokens per user in 24 hours | 1,000,000 |
| Tokens for the instance in 24 hours | 5,000,000 |

A daily cap reached stops the answer before its next model call, with an error that names the cap; at the tool-call
limit the model is asked to answer with what it has. Deleting a conversation does not give its tokens back. The
`PIWI_AI_ASSISTANT_*` variables in the [configuration reference](/reference/configuration#assistant) change the
limits, and **AI usage** on Settings → AI counts the assistant's answers apart from diagnoses.

## Turning it off

Decline **Assistant** on the Setup page ([Choose what you use](/operate/capabilities#declining-a-capability)) and its
routes answer as unavailable for everyone, its stored conversations included; **Ask Piwi** leaves the sidebar and the
command palette. Declining AI turns it off too.

## Related

- [AI provider](/guide/ai-provider): configure the model roles
- [MCP server](./mcp): the same tools, for coding agents
- [AI diagnosis](./ai-diagnosis): what the diagnosis model sends and stores
