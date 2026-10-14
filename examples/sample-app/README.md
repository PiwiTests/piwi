# Sample app

One small web app, served by each backend Piwi supports, and the Playwright suite they share. Every backend serves the
same pages (`web/`) and implements the same API on the same port with its own Piwi integration, so the suite, the
look and the dashboard's view of a run are the same whichever backend runs; what differs is what the integration sends.
ASP.NET Core is the first backend; the Nitro integration is shown in [`examples/playwright-fixtures`](../playwright-fixtures)
for now.

The app is a home page, a contact form, a popup, a slow page, a page whose API calls log on the server, and a small
shop: sign in, fill a cart, place an order the backend checks and prices.

## Run it

You need Node.js 20.12 or later, a [Piwi dashboard](https://piwitests.dev/getting-started) (`http://localhost:3000` by
default), and the toolchain of the backend: the [.NET 10 SDK](https://dotnet.microsoft.com/download) for ASP.NET Core.

```bash
npm install
npx playwright install chromium
npm test
```

`npm test` runs the suite against ASP.NET Core, and so does `npm run test:aspnetcore`. Playwright builds and starts the
backend on `http://localhost:4173` (the first build takes a minute or two) and stops it at the end. The results go to
the project `sample-app-aspnetcore`; point elsewhere with `PIWI_DASHBOARD_URL` / `PIWI_PROJECT_NAME`, in the
environment or in a `.env` file (see `.env.example`).

To open the app yourself, `npm run start:aspnetcore`, then `http://localhost:4173`. A suite run started meanwhile uses it.

`npm run test:<backend>` picks a backend by the script's name. With `npx playwright test`, set `SAMPLE_BACKEND`:

```bash
SAMPLE_BACKEND=aspnetcore npx playwright test
```

```powershell
$env:SAMPLE_BACKEND='aspnetcore'; npx playwright test
```

> **One test fails and one leaks on purpose.** `failing-locator.spec.ts` clicks a button by its former label, to show
> what the dashboard keeps on a failure: the ARIA snapshot, a locator suggestion and the *Alternative locators* panel.
> `resource-leak.spec.ts` leaves a browser context open.

## What it shows

Each row is something Piwi records, the spec that shows it, and whether each backend provides it. A spec that needs a
feature its backend does not provide is skipped with the reason; `backends.ts` lists each backend's features.

| Feature | Shown by | ASP.NET Core |
|---|---|:---:|
| Network, console, Web Vitals, locators and page state ([capture fixtures](https://piwitests.dev/guide/capture-fixtures)) | `home`, `form`, `console`, `popup`, `multi-page`, `browser-newpage`, `context-newpage` | ✓ |
| Failure evidence: screenshot, trace, video, ARIA snapshot, locator healing | `failing-locator` | ✓ |
| Slow endpoints, with `/api/users/1` and `/api/users/2` grouped as one route | `slow-endpoint` | ✓ |
| Resources: CPU, memory, disk, and what a test leaves open | `resource-leak` | ✓ |
| Tags, owners and features | `tags-and-ownership`, `shop` | ✓ |
| Page objects as fixtures, and [recording from the editor](https://piwitests.dev/features/editor-recording) | `shop`, `shop-recorded` | ✓ |
| [Backend logs](https://piwitests.dev/guide/backend-logs): the server's warnings and errors on each request | `backend-logs` | ✓ |
| Route manifest: the routes the backend declares, so the Test Map names the ones no test reaches (`/shop/orders`) | `route-manifest` | ✓ |
| Server spans on each request (`X-Piwi-Trace`) | | only for a probe |
| [Server probes](https://piwitests.dev/features/probes#server-probes): a signed fault applied inside the server | `server-probes` | ✓ |
| [Server coverage](https://piwitests.dev/features/code-reach#server-code): the backend lines each test ran | `server-coverage`, `shop` | ✓ |
| [Code reach](https://piwitests.dev/features/code-reach): the browser files each test ran (`web/assets/*.js`) | every page spec | ✓ |
| Page inventory: the controls and links no test uses (the shop's **Orders** link) | every passing spec | ✓ |
| The API contract below | `api-contract` | ✓ |

The reporter options are in `playwright.config.ts`: on top of the defaults, the page inventory, a video of a failing
test, leak reports, and `coverage: { browser: 'files', server: 'lines' }` (the server side only for a backend with
coverage). `piwi.manifest.json` names the pages, and the backend's route manifest adds its routes, so on the dashboard
`/shop/orders` and `GET /api/orders` show as declared and never reached, and so does `GET /api/before-all-marker`,
which only a `beforeAll` hook calls.

### The specs

| Spec | What it does |
|---|---|
| `home.spec.ts` | The standard `page` fixture: a click, a `fetch`, the page's `console.warn` |
| `form.spec.ts` | Labeled fields, sent with an XHR POST |
| `browser-newpage.spec.ts`, `context-newpage.spec.ts` | Pages opened from the `browser` fixture and from `browser.newContext()` |
| `popup.spec.ts` | A `window.open` popup, captured too |
| `multi-page.spec.ts` | Two pages in one test |
| `failing-locator.spec.ts` | **Fails on purpose** |
| `console.spec.ts` | `console.warn`, `error` and `assert` captured; `console.log` not |
| `slow-endpoint.spec.ts` | An 800 ms call and two calls to `/api/users/{id}` |
| `backend-logs.spec.ts` | The warning and error `/api/report` logs, and the unhandled exception of `/api/failing`, read from `X-Piwi-Logs` |
| `route-manifest.spec.ts` | `/__piwi/manifest` declares every page and the API |
| `server-coverage.spec.ts` | Placing an order returns `X-Piwi-Coverage` |
| `server-probes.spec.ts` | A signed `X-Piwi-Probe` fails `/api/items` inside the backend, and the home page shows the error |
| `api-contract.spec.ts` | The API, called with the `request` fixture: status codes, totals, refused orders |
| `skipped.spec.ts` | A skipped test records nothing |
| `before-all.spec.ts` | `beforeAll` activity is not attributed to a test |
| `custom-fixtures.spec.ts` | The capture fixtures composed with your own (`fixtures-composed.ts`) |
| `tags-and-ownership.spec.ts` | Tags in both forms and `piwi:` owner, priority, feature and link annotations |
| `resource-leak.spec.ts` | **Leaks on purpose**: a context never closed |
| `shop.spec.ts` | The shop through its page objects (`shop-fixtures.ts`): sign in, add to cart, place an order |
| `shop-recorded.spec.ts` | An empty test to record into from your editor |

`tests/fixtures.ts` is the first way to switch capture on, `base.extend(piwiFixtures)`; `tests/fixtures-composed.ts` and
`tests/shop-fixtures.ts` the second, `extendPiwiFixtures(base).extend({ … })`. Every spec imports `test` from one of
them.

## Record a test from your editor

The shop is there to try [recording from the editor](https://piwitests.dev/features/editor-recording): **Piwi: Record
here** in VS Code, or **Tools → Piwi → Record Here** in a JetBrains IDE. The steps you take in the browser it opens are
written at the cursor, and the ones the page objects already perform become calls to them.

1. Copy `.env.example` to `.env` and set the dashboard's address (and an API key when it has sign-in).
2. `npm test` once, so the run creates the project, then `npm run demo:functions`: it registers the page objects'
   methods (`scripts/shop-functions.json`) in the project's [test functions](https://piwitests.dev/features/test-functions)
   catalog.
3. Start the app with `npm run start:aspnetcore` (a recording does not start the `webServer`) and open this folder in
   your editor with the Piwi extension.
4. In `tests/shop-recorded.spec.ts`, put the cursor in the empty test and run **Piwi: Record here** with `/shop/login`
   as the start page. Sign in as `alice@example.com` with any password, add **Trail shoes** and **Water bottle** to the
   cart, open **Cart**, **Checkout**, fill in the shipping form and **Place order**. The steps come out as calls:
   `await loginPage.login('alice@example.com', process.env.E2E_PASSWORD ?? '')`, `await productsPage.addToCart('Trail shoes')`,
   `await checkoutPage.placeOrder({ … })`, one `test.step` per page, as the `'@piwi'` section of `playwright.config.ts`
   asks.
5. Rename `test.fixme` to `test` and run it: it passes, with `E2E_PASSWORD` from `.env`.

## The contract

What a backend implements to join the sample. The suite checks it: `api-contract.spec.ts` first, then the page specs.

### Serving

- Port **4173**, `http://localhost:4173`, in an environment where the Piwi integration is active (ASP.NET Core:
  Development).
- `web/assets/*` at `/assets/*` (`app.css`, `app.js`, `shop.js`), as static files.
- Each page at its own route, so the route manifest declares it. The files are static HTML, the same for every backend:

| Route | File | Status |
|---|---|---|
| `/` | `web/pages/index.html` | 200 |
| `/form`, `/popup`, `/child`, `/slow`, `/backend` | `web/pages/<name>.html` | 200 |
| `/shop` | `web/pages/shop/index.html` | 200 |
| `/shop/login`, `/shop/cart`, `/shop/checkout`, `/shop/done`, `/shop/orders` | `web/pages/shop/<name>.html` | 200 |
| `/shop/products/{slug}` | `web/pages/shop/product.html` | 200, or 404 for a product the shop does not sell |

The pages keep the shop's state in the browser: the shopper's email in the `shop_user` cookie (URI-encoded), the cart in
local storage (`shop_cart`, one product slug per item), the last order in session storage (`shop_order`).

### API

JSON bodies; an error answers `{ "error": "<message>" }` unless noted.

| Endpoint | Answers | Server side |
|---|---|---|
| `GET /api/items` | 200 `[{ name, stock }]`: Alpha 2, Beta 14, Gamma 9 | |
| `POST /api/submit` | 200 `{ ok: true }`; 400 when `email` is missing | |
| `GET /api/users/{id}` | 200 `{ id, name: "User <id>" }`; 404 when `id` is not an integer | |
| `GET /api/slow` | 200 `{ ok: true }` after 800 ms | |
| `GET /api/report` | 200 `{ items: 3, cached: true }` | Logs a Warning `demo: low stock for item Alpha` under an inventory category, then an Error `demo: price sync failed, using cached prices` with an exception |
| `GET /api/failing` | 500, any body | An unhandled exception, `demo: inventory backend exploded`, logged as an Error before the response starts |
| `GET /api/child`, `GET /api/before-all-marker` | 200 `{ ok: true }` | |
| `GET /api/products` | 200 `[{ slug, name, price, description }]`: `trail-shoes` 89, `rain-jacket` 129, `water-bottle` 19 | |
| `GET /api/products/{slug}` | 200 the product; 404 for a product the shop does not sell | |
| `POST /api/orders` | 201 `{ id, name, city, country, count, total, summary }` | Reads the shopper from the `shop_user` cookie: 401 without it. The body is `{ items: [slug], shipping: { name, address, city, country } }`; 400 for an empty cart, a product the shop does not sell, a missing name, address or city, or a country outside France, Germany, Spain and the United Kingdom, logged as a Warning. `summary` is `"<count> item(s) on their way to <city>, <country>."` |
| `GET /api/orders` | 200 the shopper's orders, newest first; 401 without the cookie | Only the order history calls it, and no test opens it |

### The Piwi integration

What the backend's integration adds, in the environments it is active in. `backends.ts` records which of these a
backend provides, and the specs for the others are skipped.

| | What the backend sends | ASP.NET Core |
|---|---|:---:|
| `X-Piwi-Logs` | On every response: the Warning, Error and Critical entries the request logged, as gzip-compressed, Base64-encoded JSON (`[]` when none) | ✓ |
| `GET /__piwi/manifest` | The routes it declares, every page above among them | ✓ |
| `X-Piwi-Probe` → `X-Piwi-Trace` | Applies a fault signed with `PIWI_PROBE_SECRET` (the sample's is `piwi-sample-probe-secret`, in `backends.ts`) when `PIWI_SERVER_PROBES=true`, and names it on the response's root span (`piwi.probe.applied`) | ✓ |
| `X-Piwi-Trace` | The server's spans on every response | |
| `X-Piwi-Coverage`, `POST /__piwi/coverage/collect`, `GET /__piwi/coverage/run` | In a coverage build: the id of each request's coverage, and the coverage of the ids a test received | ✓ |

### Adding a backend

1. A folder `backends/<name>/` that serves the pages and the API above with the backend's Piwi integration, and runs
   from its own command on port 4173.
2. An entry in `BACKENDS` in `backends.ts`: its command, its start timeout, its features.
3. `test:<name>` and `start:<name>` scripts in `package.json`, and an entry in `release-please-config.json` for each
   pinned Piwi package version it uses.
4. `npm run test:<name> -- api-contract`, then the whole suite. The dashboard project is `sample-app-<name>`.

## The ASP.NET Core backend

`backends/aspnetcore/` is a minimal API app (.NET 10). `Program.cs` wires the integration:
`builder.AddPiwiTestLogs()` and `app.UsePiwiTestLogs()` first in the pipeline, then an exception handler that logs an
unhandled exception before its 500 response starts, so the error rides on it. The pages are served from
`Endpoints/PageEndpoints.cs`, the API from `Endpoints/DemoEndpoints.cs` and `Endpoints/ShopEndpoints.cs`, as method
handlers calling the services in `Services/`: a coverage build records a method per test, and an inline lambda handler
only for the whole run.

- **Coverage build.** `dotnet run -p:PiwiCoverage=true` (what `backends.ts` and `start:aspnetcore` run) compiles with
  the compiler's coverage instrumentation; switching between it and a plain build recompiles.
  `PIWI_COVERAGE_MODE=run` keeps the run's coverage only.
- **Environment.** `Properties/launchSettings.json` gives `dotnet run` the address, the Development environment, the
  probe secret and `PIWI_SERVER_PROBES=true`.
- **The integration's source or its packages.** Inside this repository the project references the integration's
  source (`integrations/aspnetcore/`, and the coverage package's build props, which a project reference does not
  import); copied anywhere else, it references the `PiwiTests.Instrumentation.AspNetCore` NuGet package at the version
  release-please pins. The switch is whether `../../../../integrations/aspnetcore/PiwiTests.Instrumentation.slnx`
  exists, seen from the project. Keep `web/` two folders above the project when you copy it.
- **Paths.** Coverage and the route manifest name files relative to the git repository the backend runs in, else
  relative to `backends/aspnetcore/`.
- **CI.** The project is part of `integrations/aspnetcore/PiwiTests.Instrumentation.slnx`, so `dotnet test` builds it.
