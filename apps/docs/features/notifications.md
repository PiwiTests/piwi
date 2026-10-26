---
title: Notifications & alerts
description: "Browser, email, Slack, Microsoft Teams and webhook channels, the events they fire on, and per-project subscriptions with digests and mute."
lang: en-US
---

# Notifications & alerts

<Needs reporter />

Piwi pushes run events to a **browser** tab, **email**, **Slack**, **Microsoft Teams** or an **HTTP webhook**, so your
team hears about failures, new failure clusters, flakiness spikes and performance regressions without watching the
dashboard.

## What it does

1. A **channel** is a destination: a browser tab, an email address, a Slack channel, a Teams webhook, or your own URL.
2. A **subscription** links a channel to the events you care about, for every project or one, with filters and a
   delivery mode.
3. When an event fires, Piwi matches the active subscriptions and writes each delivery to an outbox, which a scheduled
   task sends with retries. A browser channel is delivered at once to every open dashboard tab.

## Where it is

**Settings → Notifications** manages channels and subscriptions, and the **bell** on a project page subscribes to that
project. The new-channel form shows where to get each destination, flags a URL that belongs to another type (a Slack
URL pasted under Teams offers to switch), and can **send a test** before saving: a channel whose test went through is
saved as verified. Email goes only to a verified address: an email channel once a test reached it, the account email
once its owner verified it. Notifications need no authentication: with it off, the instance is single-tenant and every
channel and subscription is **global**. With `PIWI_AUTH_ENABLED=true` ([authentication](/operate/authentication)), each user keeps
their own, and administrators can add global ones shared by everyone.

<figure>
  <img src="/screenshots/notifications.png" alt="Settings, Notifications: the SMTP status with the environment variables to set, a Slack channel, and its subscription to project 1's failed runs and new clusters">
  <figcaption><strong>Settings → Notifications</strong>: email delivery, the channels, and what each one is subscribed to.</figcaption>
</figure>

## Events

Run events fire when a run finishes or fails, cluster events when a failure cluster appears, is fixed or regresses,
and others on a flakiness spike, a performance regression, a finished AI diagnosis and an auto-heal pull request.
Each event, when it fires and the payload it carries are in
[Notification events & webhooks](/reference/notification-events). A
[report schedule](./quality-reports#report-schedules) sends its report to the channels it names, with no subscription.
A run from an editor, or a partial run from a developer's machine or the desktop app, fires no run event and no
new-cluster, flakiness or performance event ([run origin](/reference/test-metadata#run-origin)).

## Channels

### Browser

Sends native OS notifications to any open Piwi tab, even in the background, through the [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API); grant permission when prompted.

- **With authentication**: create a channel of type `browser` in **Settings → Notifications** and subscribe it to events; the stream then delivers exactly the events and projects your subscriptions cover.
- **Without authentication**: no channel is needed; the **bell** on each project page stores per-browser preferences (a cookie) for which events raise notifications.

Diagnosis-completion notifications can be switched off per browser in **Settings → AI → Diagnosis
notifications** without deleting the subscription.

### Email

Requires SMTP to be configured (see below). Sends to a destination address. With authentication on, each user with an account email also gets an automatic **Account email** channel.

### Slack

Under **Send with**, pick an incoming webhook or a bot token; both post the same message.

**Incoming webhook.** Paste an [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks) URL
(`https://hooks.slack.com/services/…`). Without one, the form's **Create a Slack app for Piwi** link opens Slack with an
app already filled in, asking only for the `incoming-webhook` permission: create it, choose **Install to Workspace** and
the channel, then copy the URL from **Incoming Webhooks**. A Slack-compatible server (Mattermost, Rocket.Chat) works too.

**Bot token.** Piwi posts with the Web API's
[`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage). The same link asks for `chat:write`
and `chat:write.public` instead: install the app, copy the **Bot User OAuth Token** (`xoxb-…`) and the channel's
**Channel ID**, and invite the app to a private channel first. The token is encrypted at rest and never returned, so it
needs `PIWI_SECRET_KEY`. A refusal names Slack's error code (`not_in_channel`, `invalid_auth`) with what to do, and a
rate-limited delivery retries after Slack's `Retry-After`.

### Microsoft Teams

In the Teams channel's **⋯** menu, open **Workflows**, pick the template *Send webhook alerts to a channel*, choose the
team and channel, and paste the URL the workflow shows. A legacy Microsoft 365 connector webhook still works while
Microsoft keeps it, and the form flags it. Each event, digest and
[quality report](./quality-reports#report-schedules) arrives as an Adaptive Card.

### Webhook

Piwi `POST`s a JSON body to your URL. When the channel has a secret, which the form can generate (storing it needs
`PIWI_SECRET_KEY`), each request is signed with an HMAC-SHA256 `X-Piwi-Signature` header. Private and loopback
addresses are refused.
The body, its fields and how to verify the signature are in
[Notification events & webhooks](/reference/notification-events#webhook-body).

### Reaching the person who fixed it

`cluster.fixed` and `cluster.regressed` resolve the fixing commit's author through the SCM provider, which for a private repository needs an [SCM token](/guide/source-control) (for a regression, the author of the fix that did not hold). On top of the normal subscription routing, the event is then delivered to that person directly:

- **Email**, through the same outbox, when SMTP is configured **and** the commit's email belongs to a registered Piwi user. The mail goes to that user's account email, never to the raw commit address, so a fix by an outside contributor never becomes a mail to a stranger.
- **A browser notification** for that user, delivered even when they have no matching subscription.

When the lookup fails (a private repository without a token, a host that exposes no email), subscriptions alone apply.

### Global channels & subscriptions

Admins can mark a channel **global** so it is available to all users, and mark a subscription **instance-wide** (from the project bell) so it delivers whoever is signed in: the way to route every failure to one team Slack channel. Global subscriptions must target a global channel. Other users see where a global webhook points, never its full URL. With authentication disabled, every channel and subscription is global.

## Subscriptions

A subscription controls *what* is delivered and *how*. The project **bell** creates one for that project — a channel, one or more of the events above and, optionally, the branches and environments it covers, delivered in real time. **Settings → Notifications** lists them with their filters, and mutes one for 7 days or removes it.

### Branches and environments

The bell offers the branches and environments the project's runs reported, and takes a typed name too: `*` matches
any characters, so `release/*` covers every release branch. A subscription delivers only events from runs on one of
its branches **and** in one of its environments; a run that reported no branch (or environment) matches none, and an
empty list matches every run. The filters apply to every event that comes from a run: the `run.*` events,
`flakiness.spike`, `perf.regression`, the `cluster.*` events and `bug.looks_fixed`. `diagnosis.completed` and
`auto_heal.pr_opened` are not filtered.

### Through the API

The subscriptions REST API (see the [API docs](https://piwitests.dev/demo/docs)) adds:

- **Scope**: all projects (`projectId: null`, for a user who can access every project), or a single project.
- **Filters**: `branches` and `environments` as above; for run events, status; **owner**, which applies to the
  `run.*` events, `flakiness.spike`, `perf.regression` and `cluster.new` and delivers them only when a failing test
  behind the event belongs to that team (see [Tags & ownership](/guide/concepts#tags-ownership)); `flakinessThreshold`
  (a 0–1 rate) and `perfRegressionPct`.
- **Mode**: `realtime`, sent as events happen, or `digest` with `digestAt` (`HH:MM`, UTC), held until then and sent as
  **one combined message** per email, Slack or Teams channel.
- **Mute**: `mutedUntil`, any time, without deleting the subscription.

## SMTP configuration

Email channels and the account flows (verification, password reset, invites) need SMTP. Slack, webhook and browser channels work without it. SMTP is set via environment variables only and shown read-only in **Settings → Notifications**; `PIWI_SMTP_HOST` and `PIWI_SMTP_FROM` are enough for a relay that accepts unauthenticated mail:

```bash
PIWI_SMTP_HOST=smtp.example.com
PIWI_SMTP_PORT=587            # default 587
PIWI_SMTP_FROM=noreply@example.com
PIWI_SMTP_FROM_NAME=Piwi Dashboard   # optional display name
PIWI_SMTP_USER=apikey         # only when the server requires authentication
PIWI_SMTP_PASS=••••••••        # only when the server requires authentication; never returned by the API
PIWI_SMTP_SECURE=false        # true for port 465 (implicit TLS)
PIWI_SITE_URL=https://piwi.example.com   # base URL used in email links
```

Send a test email from **Settings → Notifications** to confirm delivery.

## Limits

- **Digests group email, Slack and Teams only.** Webhook and browser deliveries are always one per event.
- **A browser channel needs an open tab.** Nothing reaches a closed browser; the
  [desktop app](./desktop) shows OS notifications while its window is in the background.
- **Email needs SMTP**, set through environment variables only.

## Related

- [CI & sharding](/guide/ci): the alternative, pulling the run URL into your pipeline
- [Authentication](/operate/authentication): per-user channels and subscriptions
- [Configuration reference](/reference/configuration): every environment variable
- [Notification events & webhooks](/reference/notification-events): every event and the webhook body
- [Quality reports](./quality-reports#report-schedules): scheduled quality reports sent to these channels
- [Failure clusters & the inbox](./failure-clusters): what triggers the cluster events
