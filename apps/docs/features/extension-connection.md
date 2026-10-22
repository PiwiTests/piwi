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
once.

## Connect in one step

1. Open Piwi Picker's settings (the gear button in its popup) and type your instance's address.
2. Click **Connect**. The browser asks to let Piwi Picker reach that one address; allow it.
3. A tab opens on your instance. Sign in if asked, with a password or your usual sign-in provider: you come back to
   the same page. It names the connecting browser ("Piwi Picker in Chrome on Windows") and shows a code.
4. Check that the settings page shows the same code, tick **My Piwi Picker shows this same code**, then click
   **Allow**. The link carries the code, so anyone could send you one: if you did not just click **Connect**, deny.

The tab closes, the settings say **Connected as** your name, and the instance's URL patterns appear under **From
your Piwi instance**.

Allowing creates an API key for your account, named after the browser, with your instance role and project roles. It is
listed with your other keys in your account's API key settings, where you revoke it; the browser is then
disconnected at its next request. **Deny**, or ten minutes without an answer, creates nothing.

With [authentication](/operate/authentication) off, **Allow** only confirms the connection: there is no account to
own a key, and none is needed.

### Is the connection working?

Each time Piwi Picker asks your instance for something (a function catalog, the elements your tests reach, the bug
reports, the URL patterns as the settings open), it keeps how the request went. The popup says it in one line under
**Active project**: "Connected to piwi.example.com, checked 5 minutes ago", or, once requests fail, since when
nothing answers, the key is refused or the instance answers with errors, with a link to the settings. The settings
show the same beside your instance's address. A key revoked in your API key settings therefore shows in the popup at
the next request, before a tool fails on it: click **Connect** again.

### Use an API key instead

Under **Use an API key instead**, paste a key created in your account's [API key settings](/operate/api-keys) and
click **Save and test**. An instance older than the one-step connection needs this.

### The desktop app as your instance

The [desktop app](./desktop) runs a Piwi instance on your computer, whose server answers only requests carrying the
app's access token. Once you have [paired the app](./bug-reports#running-it-with-playwright-in-the-desktop-app) under
**Desktop app**, and while no instance is connected, the settings offer **Use the desktop app as your instance**: one
click fills in the app's address and its token as the API key, checks them and connects, as **Save and test** does.
Should the app refuse the token (it was installed again since you paired it), its address stays filled in and the API
key field waits: paste the token from the app's **Connect Piwi Picker**, or pair again.

The token goes to that address only once the program answering there proves it holds it, before every request, as for
**Run with Playwright**. Should the app quit and another program take its port, the extension sends nothing and says
so. This holds after **Unpair** too, and when the token is typed under **Use an API key instead**, where the address
must be written with `127.0.0.1`: `localhost` may reach another program, so the token is not sent there.

The other way round, while an instance is connected and no desktop app is paired, the settings point to the pairing.
The app's address is then shared: **Disconnect** leaves it to the app, and **Unpair** to the instance.

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

The editor suggests one pattern per site your suite already visited: the `baseURL` of recent runs, and for a run that
recorded none, the full addresses its tests opened with `page.goto` and the pages it loaded (its `document` network
requests), then the pages of the [Test Map](./scenario-gaps) and the absolute pages its locators ran on. A run merged
from blob reports (`npx playwright merge-reports`, or a blob report imported in the dashboard) never records the
`baseURL`, which Playwright leaves out of them; its tests' `page.goto('/cart')` names no site either, so its sites come
from the page loads: the network requests the [capture fixtures](/guide/capture-fixtures) record for every test, or
those read from the trace of a failed test. A site a run visited comes with the environment the run was reported with
(the [reporter](/guide/reporter)'s `environment` option or `PIWI_ENVIRONMENT`), and the suggestions are grouped by it.
The newest few runs of every environment are read, so a nightly production suite is suggested beside a staging one that
runs on every push. **Add** puts a suggestion in the list with its environment, **Add all** every suggestion of that
environment; **Save patterns** stores them. When there is nothing to suggest, the editor says why: every site already
has a pattern, or no recent run recorded a `baseURL`, opened a full address or kept the network requests of a page it
loaded. Editing the list takes the Project admin role on the project, like the rest of the project's settings.

### Which project applies

Piwi Picker reads the patterns of every project you can see when it connects and each time its settings open, and
keeps a copy, so a page's project is known with the instance out of reach. For a page it decides in this order:

1. the project chosen in the popup's **Active project** on that site, for the rest of the browser session or until you
   disconnect;
2. the patterns under **This browser only**, the first that matches;
3. the instance's patterns, by project, in each project's order, the first that matches.

A pattern kept in the browser is therefore an override for that browser alone. The settings page marks each pattern
with where it comes from. **Disconnect** sets the patterns of this browser aside: connecting to the same instance
again brings them back, and connecting to another drops them, since they name the first one's projects.

### Add a site

When the current tab matches no pattern, the popup says so and offers **Add this site**. It opens the settings with
`https://<site>/**` filled in: choose a project and click **Add to Piwi**, or **Keep in this browser only**. Adding to
the instance takes a role that edits the project; without one, the settings say so and keep the second choice.

## What is sent

Connecting sends the browser's and the operating system's names, nothing else about the machine. Afterwards the
extension downloads the URL patterns, each mapped project's function catalog and its locator index; adding a site
sends that one pattern. A recording is never sent to the instance: **Send to editor** sends it only to an editor paired
on the same computer. A bug report is sent only from **Send to Piwi…**, after a preview of exactly what goes (see
[Bug reports](./bug-reports)). Only the settings page and the extension's background worker talk to the instance or
the editor, never a script running in a page.

While connected, Piwi Picker also marks your instance's pages in this browser: a script sets `data-piwi-picker`, with
the extension's version, on each page. The dashboard then stops suggesting Piwi Picker, as it does once you click
**Don't show again** on its hint. The script reads nothing from the page and sends nothing, and **Disconnect** stops it.

## Related

- [Browser extension](./extension): everything Piwi Picker does, with or without a connection
- [API keys](/operate/api-keys): create, list and revoke keys, those Piwi Picker created included
- [Tested elements](./tested-elements): what a connection shows on the page
- [Access, roles and groups](/operate/project-access): which projects, and so which patterns, a user sees
