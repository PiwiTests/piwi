---
title: Choose what you use
description: "Pick the capabilities your instance and each project use from Settings → Capabilities, and decline the rest so the dashboard stops showing them."
lang: en-US
---

# Choose what you use

**Settings → Capabilities** (`/settings/capabilities`, administrators only) is where an instance says what else it does once results arrive. It opens on one coarse question, *What do you want Piwi for?*, with **See why tests fail** always on and three opt-out groups: **Triage as a team** (notifications, quarantine, pull-request feedback, issue tracking), **Fix faster** (locator healing, auto-heal), and **Let agents in** (AI diagnosis, the assistant). Below it, a ladder lists every optional capability grouped by state: **Active** (evidence has arrived), **Available** (configured but not used yet), **Not set up**, and a folded **Declined** group. The page ends with **Off until turned on**: [Run on my machine](/features/run-on-my-machine) and [Pass reuse](/features/reuse-forecast) stay off until an administrator turns them on.

## Declining a capability

Not every team uses every capability. Any optional one can be **declined** so the dashboard stops showing it everywhere: the evidence tabs, empty panels, settings page, sidebar entry, project actions and MCP tools it owns all go, rather than lingering half-visible. Decline instance-wide from the ladder (*Not for this instance*) or the presets, or per project from the **Capabilities** section of the project's **Settings** tab and the places the capability appears (for example the execution page's evidence footer, *Not for this project*). A project override can also **enable** a capability the instance declined.

Declining instance-wide is for administrators, and per project for the project's [Project admin](./project-access#project-roles) role. It is never final: each declined capability keeps a *Reconsider* link on the ladder that clears the decision, and because data always wins, a declined capability that starts receiving data reads as active again with the stored decision shown next to it. See [Why a card is empty](/features/evidence#why-a-card-is-empty) for how this reads on the execution page.

<figure>
  <img src="/screenshots/setup-ladder-declined-wide.png" alt="The Capabilities settings page's list of what is switched on, Notifications among the active capabilities, marked declined with a Reconsider link beside its docs link">
  <figcaption>A declined capability that still receives data reads as active, its decision and Reconsider link beside it.</figcaption>
</figure>

## Related

- [Getting started](/guide/getting-started): connect a first suite
- [All features](/reference/features): every capability and what it needs
- [Integrations](./integrations): connect the external services some capabilities use
