---
title: Mock and slow down requests
description: "From the Piwi panel's Network tab in DevTools: a request the page made written as a page.route mock for a test, or slowed down or failed in your own tab."
lang: en-US
---

# Mock and slow down requests

<Needs extension />

The **Network** tab of the Piwi panel in [Developer tools](./devtools) lists the page's `fetch` and XHR requests. Select
one to write it as a mock for a test, or to try the page under a slow or failing request.

## Mock this response

Select a request in the Network tab and the panel writes it as a route for a test:

```ts
await page.route('**/api/cart?_=*', (route) =>
  route.fulfill({
    json: { items: [{ sku: 'SPRING-TEE', qty: 1 }], total: 40 },
  }),
);
```

The URL pattern drops the origin and turns the query values that change on every request (a timestamp, a cache
buster) into `*`; edit it before copying. A status other than 200 is kept, and a method other than GET is checked.
**Answer with** switches to a server error (500) or a network failure (`route.abort()`), for testing the page's
error state. A body over 100 kB goes to a file the route reads, such as `mocks/cart.json`, downloaded beside the code.

Fields named like a password, a token, a key or a session are written as `<hidden>` until you tick **Show hidden
values**; headers, cookies included, are never written. Nothing is sent anywhere: the code reaches your clipboard
when you copy it.

## Slow down or fail a request

Under a selected request, the Network tab also offers **Slow down** by the seconds you type, **Fail with 500** and
**Fail (network error)**: the flaky conditions a test has to survive, tried by hand in your own tab. The first time,
Piwi Picker asks for access to the site. From then on the tab's requests to that URL wait, answer 500 or fail, on every
page of the site in that tab, until you remove the condition, click **Turn all off and reload**, or close the tab. A
banner on the page says which conditions are on, with **Turn off**; other tabs are not affected.

In Chrome and Edge, a condition reaches any request, documents, scripts and images included (tick **Every kind** to
list them), and the toolbar's **Network** and **CPU** throttle the whole page as DevTools does: fast or slow 3G,
offline, or a CPU 4, 6 or 20 times slower. They go through the debugging protocol: Chrome shows its debugging bar until
you turn them all off, and **Cancel** on it ends the throttling, leaving the requests' conditions to the page's `fetch`
and XHR calls. Firefox has only those: documents, scripts, images and a service worker's requests go past, and a page
that replaces `fetch` itself may behave differently.

A replay started while a condition is on runs under it, and its panel says which conditions were on, beside the
verdict.

## Related

- [Developer tools](./devtools): the Piwi panel and its other tabs
- [Browser extension](./extension): the permissions these use
- [Replay a bug report](./replay-a-bug-report): a replay under the conditions on
