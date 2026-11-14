---
title: Extension connection
description: "Connect Piwi Picker to your Piwi instance in one step, and keep the URL patterns that tell it which project a page belongs to on the instance, shared by your team."
lang: en-US
---

# Extension connection

<Needs extension />

[Piwi Picker](./extension) works on its own. Connected to your Piwi instance, it also matches a recording against
your project's [test functions](./test-functions) and shows [Tested elements](./tested-elements). Connecting takes
one click, and the URL patterns that say which project a page belongs to live on the instance, so a team sets them
once. Pairing with the desktop app, and what each connection sends, are here too.

## Connect in one step

1. In Piwi Picker's settings (the gear button in its popup), type your instance's address.
2. Click **Connect**. The browser asks to let Piwi Picker reach that one address; allow it.
3. A tab opens on your instance. Sign in if asked, with a password or your usual sign-in provider: you come back to
   the same page. It names the connecting browser ("Piwi Picker in Chrome on Windows") and shows a code.
4. Check that the settings page shows the same code, tick **My Piwi Picker shows this same code**, then click
   **Allow**. The link carries the code, so anyone could send you one: if you did not just click **Connect**, deny.

The tab closes, the settings say **Connected as** your name, and the instance's URL patterns show under **From your
Piwi instance**.

Allowing creates an API key for your account, named after the browser, with your instance role and project roles. It is
listed under **Settings → Account → [Connected apps](/features/run-on-my-machine#connected-apps)**, where you revoke
it; the browser is then disconnected at its next request. **Deny**, or ten minutes without an answer, creates nothing.

With [authentication](/operate/authentication) off, **Allow** only confirms the connection: there is no account to
own a key, and none is needed.

### Is the connection working?

The popup says how the last request to your instance went, under **Active project** ("Connected to
piwi.example.com, checked 5 minutes ago"), or since when nothing answers, the key is refused or the instance answers
with errors, with a link to the settings, which show the same beside the address. A revoked key thus shows at the
next request, before a tool fails: click **Connect** again.

### Use an API key instead

Under **Use an API key instead**, paste a key created in your account's [API key settings](/operate/api-keys) and
click **Save and test**. An instance older than the one-step connection needs this.

### The desktop app as your instance

Once the [desktop app](./desktop) is [paired](#pair-with-the-desktop-app) and no instance is connected, **Use the
desktop app as your instance** fills in the app's address and token as the API key, checks them and connects: the
app's instance answers only requests carrying that token. If the app, installed again, refuses it, paste the one from
its **Pair with Piwi Picker** card, or pair again. Typed by hand, the address must use
`127.0.0.1`, since `localhost` may reach another program.

## Pair with the desktop app

Pairing lets Piwi Picker [run a report with Playwright](./replay-a-bug-report#running-it-with-playwright) in the app,
follow its runs in the [Runs window](./runs-window) and use it as its instance. Under **Desktop app** in the settings,
click **Pair**, then **Allow** in the app's window, which shows the same code. **Pair by hand** takes the address and
token shown in the app's **Settings → Desktop app**, under **Pair with Piwi Picker** (`http://127.0.0.1:3000` by
default). While an instance is connected and no app is paired, the settings point here.

The token goes out only after the program at that address proves it holds it, before every request: another program
on the app's port receives nothing, after **Unpair** too. **Disconnect** leaves the shared address granted to the app,
and **Unpair** to the instance or the editor.

## URL patterns

A URL pattern is a glob over a page's whole address: `*` matches within one part of the path, `**` across parts. So
`https://staging.shop.example/**` covers every page of that site, and `https://shop.example/admin/*` the pages one
level under `/admin`. A pattern starts with `http://`, `https://` or a wildcard.

Each project keeps its own list in the **Browser extension** section of its **Settings** tab. A pattern can name:

- an **environment**, a label shown beside the project in Piwi Picker (`staging`, `production`);
- a **branch**, the one deployed at those addresses, whose tests [Tested elements](./tested-elements) shows;
- a **path prefix**, the part of the path your site serves its pages under and the tests did not: `/app` when the site
  serves `/app/checkout` and the tests ran at `/checkout`. Piwi Picker removes it before comparing the page with the
  [pages the tests ran on](./tested-elements#this-page), whole parts only (`/application` keeps its path), and a bug
  report sent from the site keys its page without it. It is a plain path of at most four parts, with no query, hash or
  wildcard;
- a **tests' path prefix**, the reverse: the part of the path the tests ran the pages under and the site does not,
  `/app` when the tests ran `/app/checkout` and the site serves `/checkout`. Piwi Picker puts it in front of the page's
  path; the site's root becomes `/app`. With both set, the one replaces the other (`/app` on the site, `/v2` in the
  tests), and a page outside the path prefix is left as it is.

The editor suggests one pattern per site your suite already visited, grouped by the environment each run was
reported with (the [reporter](/guide/reporter)'s `environment` option or `PIWI_ENVIRONMENT`), from the newest few runs
of every environment, so a nightly production suite shows beside a staging one. A run's site
is its `baseURL`; for a run with none, the full addresses its tests opened with `page.goto` and the pages it loaded
(its `document` requests), then the [Test Map](./scenario-gaps)'s pages and the absolute pages its locators ran on. A
run merged from blob reports (`npx playwright merge-reports`, or a blob report imported in the dashboard) has no
`baseURL`, which Playwright leaves out of them, so its sites come from the page loads the
[capture fixtures](/guide/capture-fixtures) record for every test, or the trace of a failed test. **Add** puts a
suggestion in the list with its environment, **Add all** every suggestion of that environment; **Save patterns** stores
them. When there is nothing to suggest, the editor says why: every site already
has a pattern, or no recent run recorded a `baseURL`, opened a full address or kept the network requests of a page it
loaded. Editing the list takes the Project admin role.

### Which project applies

Piwi Picker reads the patterns of every project you can see when it connects and each time its settings open, and
keeps a copy, so a page's project is known with the instance out of reach. For a page it decides in this order:

1. the project chosen in the popup's **Active project** on that site, for the rest of the browser session or until you
   disconnect;
2. the patterns under **This browser only**, the first that matches;
3. the instance's patterns, by project, in each project's order, the first that matches.

A pattern kept in the browser is an override for that browser alone, and the settings mark where each comes from. **Disconnect** sets the patterns of this browser aside: connecting to the same instance
again brings them back, and connecting to another drops them, since they name the first one's projects. A connection
left unfinished leaves them aside for the next one.

### Add a site

When the tab matches no pattern, the popup offers **Add this site**, which opens the settings with
`https://<site>/**` filled in: choose a project and click **Add to Piwi**, or **Keep in this browser only**. Adding to
the instance takes a role that edits the project; without one, the settings say so and keep the second choice.

## What is sent

Connecting, and pairing with the desktop app, send the browser's and operating system's names, nothing else about
the machine. It then downloads the projects, the URL patterns, each mapped project's function catalog,
locator index and bug reports, and the runs in progress. It sends the instance nothing else but these, each on your
click: a site's pattern (**Add this site**), a bug report after the **Send to Piwi…** preview
([Bug reports](./bug-reports#sending-a-report)), and a replay's answer (**Share result…**). A recording goes only to a
paired editor (**Send to editor**), and steps only to the paired desktop app (**Run with Playwright…**). Only the settings
page and the background worker make requests, never a page's script.

While connected, Piwi Picker also marks your instance's pages in this browser: a script sets `data-piwi-picker`, with
the extension's version, on each page. The dashboard then stops suggesting Piwi Picker, as it does once you click
**Don't show again** on its hint. The script reads nothing from the page and sends nothing, and **Disconnect** stops it.

## Related

- [Browser extension](./extension): everything Piwi Picker does, with or without a connection
- [API keys](/operate/api-keys): create, list and revoke keys; Piwi Picker's is under Connected apps
- [Tested elements](./tested-elements): what a connection shows on the page
- [Access, roles and groups](/operate/project-access): which projects, and so which patterns, a user sees
