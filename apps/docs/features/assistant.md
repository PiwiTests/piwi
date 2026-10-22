---
title: Assistant
description: "Ask about your runs, failures and setup: your AI model answers from the read tools agents use, with your access, and never changes anything."
lang: en-US
---

# Assistant

<Needs reporter llm />

The assistant answers questions about this instance: why a run failed, which tests are flaky, what a setting does,
whether a capability is on. Your AI model writes the answer from the same read tools the [MCP server](./mcp) gives
coding agents, called with the access of the person asking, and from Piwi's documentation bundled with the server,
so it can say only what the data and the docs say. It reads; it never changes anything.

A conversation is asked over the API: start one, send a question, and the answer streams back as Server-Sent Events,
text as it is written and a line for each tool it calls. The API reference (`/docs` in your instance, or the
[demo's](https://piwitests.dev/demo/docs)) lists the routes under **Assistant**. The live demo has no model and
answers with a fixed reply.

## What it reads

Each question is offered a core set of read tools (search, projects, runs, failure clusters, a failure's evidence,
flaky tests, fix plans and the documentation), the tools of the page the question was asked on, and any it adds with
`find_tools`. `get_instance_config` tells it how this instance is set up: the capabilities' states, the AI roles'
providers and models (never a key), the connected issue trackers and whether authentication is on. Storage and
retention are shown to administrators only.

- **Your access.** The tools run as you: a Member reads only the projects they hold a role on, as in the dashboard.
- **No writes.** No tool that changes anything is offered, not even a diagnosis run. To change something, it tells you
  where in the dashboard to do it.
- **Tool results are data.** Test titles, error text, console lines and commit messages reach the model as data,
  never as instructions, and each result is cut to 12,000 characters.
- **Sources.** The answer names the tool results and the docs sections it used and links the runs, clusters and tests
  it mentions; each stored answer lists the tools it called, with their arguments.

## The model

The assistant answers with the **Assistant model** role of Settings → AI ([model roles](/guide/ai-provider#model-roles)).
Left unset, it uses the diagnosis model's provider, key and model, so an instance with AI configured has an assistant
with no further setup; set it to point the assistant at a faster, cheaper model while diagnosis keeps the strong one.
The response language and the global and project instructions apply as they do to [AI diagnosis](./ai-diagnosis).

Anthropic models and most OpenAI-compatible servers call tools natively. A server that refuses tools, and the Claude
Code CLI, answer in a JSON action mode instead: each reply is one tool call or the answer. The assistant's status says
which mode a model uses once it is known.

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
routes answer as unavailable for everyone, its stored conversations included. Declining AI turns it off too.

## Related

- [AI provider](/guide/ai-provider): configure the model roles
- [MCP server](./mcp): the same tools, for coding agents
- [AI diagnosis](./ai-diagnosis): what the diagnosis model sends and stores
