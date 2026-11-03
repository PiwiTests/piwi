---
title: Share links
description: "Read-only links to a failure, a quality report or a live dashboard for someone without an account, a status badge, and their security properties."
lang: en-US
---

# Share links

<Needs reporter />

A share link is a read-only URL that anyone can open — no dashboard account, no login. It opens one of four
things:

- an **execution** or a **failure cluster**: the live counterpart of an [offline export](./offline-export), the
  investigation as it stands when the link is opened;
- a **report snapshot**: a stored [quality report](./quality-reports#report-snapshots), as it was generated;
- a **saved dashboard**: a [live dashboard link](#live-dashboard-links), computed at every view.

Share links are **off by default**. Set `PIWI_SHARE_LINKS_ENABLED=true` to allow them — see the
[configuration reference](/reference/configuration#authentication).

The [live demo](https://piwitests.dev/demo/) runs without a server, so it has no share links and hides the **Share**
button.

## Creating a link

On an execution page, a failure-cluster page or a report snapshot page, open **Share** (next to **Export** or
**Download**); on a saved dashboard, open *Live dashboard links* in the dashboard's menu:

1. Pick an expiry. The dialog offers lifetimes up to `PIWI_SHARE_LINK_MAX_TTL_DAYS` (30 days unless configured;
   setting it to `0` lifts the cap and allows links with no expiry, which work until they are revoked or their
   creator loses access to what they open).
2. **Copy the link immediately — it is shown only once.** The server stores a hash of the token, not the token, so
   there is no way to display the URL again later. Mint a new link instead.

Creating and revoking links requires the **Maintainer** role or above on the project, or an administrator; anyone
who can read the project can see which links exist. Each entry in the dialog shows the link's prefix, its expiry state, and how many times it was opened.

## What the viewer sees

The link serves the same self-contained HTML report the [offline export](./offline-export) produces, rebuilt from
the current data on every view — a diagnosis added after the link was minted shows up, a cluster marked fixed reads
as fixed. The same size budgets apply (`PIWI_EXPORT_MAX_*`), so an anonymous view can never cost the server more
than an authenticated export does.

Two consequences of "live" worth knowing:

- **Retention thins a shared cluster over time.** When [data retention](/operate/storage#data-retention) prunes old runs, a
  cluster link keeps resolving but progressively loses member evidence — the same thinning the dashboard shows. A
  link whose entity is pruned entirely answers 404. When the investigation must outlive retention, hand over an
  export file instead.
- **Revocation is immediate.** A revoked link stops resolving on the next request. Turning the feature off entirely
  (`PIWI_SHARE_LINKS_ENABLED` unset) dead-ends every outstanding link at once without deleting anything, so the
  variable doubles as a kill switch.

## Report share links

A report snapshot's link renders the stored quality report as one self-contained HTML page. It shows the numbers
the report was generated with, whatever retention deleted since, and answers 404 once the snapshot itself is pruned
(`PIWI_RETENTION_REPORT_DAYS`).

A [report schedule](./quality-reports#report-schedules) can mint one per report: turn on **Share link** in the
schedule form. Each report then gets its own link, which the email and the Slack message carry beside the button to
the snapshot, so a stakeholder without an account reads the report in one click. The link expires a week after the
schedule's next report, within `PIWI_SHARE_LINK_MAX_TTL_DAYS`. The token travels encrypted with `PIWI_SECRET_KEY`
from the schedule to the delivery, and is shown to nobody.

## Live dashboard links

A live dashboard link renders a saved dashboard as a quality report computed at every view, and the page reloads
itself every minute: a bookmark for a stakeholder, or a wall screen with nobody signed in. Built-in dashboards have
none; duplicate one first.

- The numbers are computed with the access of the person who minted the link, checked again at every view
  (at most a minute behind). The link dies when that access or the dashboard goes, when it expires, or when it is
  revoked.
- It shows the aggregates and the lists the dashboard carries, never evidence files: no screenshot, no trace, no
  video.

## Status badge

A report link and a live dashboard link each carry two images, shown when the link is minted:

- `/share/<token>/badge.svg`: a badge such as "tests on default branch · 97.8% · 7 d", the test [pass rate](/guide/concepts#pass-rate) on the
  pass-rate color scale, for a README or a wiki page. The dialog copies it as Markdown.
- `/share/<token>/chart.png`: the report's trend. A scheduled report's Slack message draws it as an image, since
  Slack needs a public address to show one.

Both stop resolving with their link. An image proxy (GitHub's for a README, Slack's) may keep showing its copy
for up to five minutes, the time the images may be cached. Images count against their link's request limit, not
the reader's address, since such a proxy fetches for many readers.

## Security properties

- The token is a 256-bit random secret (`psl_` + 64 hex characters) — unguessable at any request rate. The server
  stores its SHA-256 hash and the first 8 hex characters, which the dialog shows as the link's prefix.
- Everything a link serves is data its creator can see: minting requires access to the execution, the cluster,
  every project of the snapshot, or the dashboard, so a link is a narrower delegation of an existing member's read
  access, never an escalation.
- A link works only while its creator can still read what it opens: the project of the execution or the cluster,
  or every project of the snapshot (a live dashboard link follows its creator's access as
  [described above](#live-dashboard-links)). Once they lose that access, the link answers 404 like an unknown link,
  and works again if the access comes back. Deleting their account revokes their links. With authentication off,
  every link works.
- An execution, cluster or report link with no creator is tied to no account, and works until it is revoked or
  expires: one Piwi created itself, in an issue an [automation rule](./issue-automation) filed, one created while
  authentication was off, and one whose creator was deleted before v0.65.0. An administrator revokes it in the
  **Share** dialog of what it opens, which lists every link to it, whoever created it.
- The rendered page is sandboxed into a unique origin and served with `noindex` and `Referrer-Policy: no-referrer`,
  so it cannot read dashboard cookies, call the API with credentials, or leak the URL through outbound links. The
  page is never cached; the two images may be, for five minutes.
- A share URL is a capability: anyone holding it can view the page, and it can end up in browser history or proxy
  logs like any URL. Prefer short expiries, and revoke links when an investigation closes.

## Related
- [Offline export](./offline-export) — the file to hand over when the recipient has no network path to your instance
- [Authentication](/operate/authentication) — roles, and who can mint or revoke
- [Storage & retention](/operate/storage#data-retention) — retention, and how it interacts with long-lived links
