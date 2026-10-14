# Sample app

One small web app, served by each backend Piwi supports, and the Playwright suite they share. Every backend serves the
same pages (`web/`) and implements the same API on the same port with its own Piwi integration, so the suite, the
look and the dashboard's view of a run are the same whichever backend runs; what differs is what the integration sends.
The backends are ASP.NET Core and Nitro.

The app is a home page, a contact form, a popup, a slow page, a page whose API calls log on the server, and a small
shop: sign in, fill a cart, place an order the backend checks and prices.

## Run it

You need Node.js 20.12 or later, a [Piwi dashboard](https://piwitests.dev/getting-started) (`http://localhost:3000` by
default), and the toolchain of the backend: the [.NET 10 SDK](https://dotnet.microsoft.com/download) for ASP.NET Core,
nothing more for Nitro.

```bash
npm install
npx playwright install chromium
npm test
```

On a fresh Linux machine, a CI runner for one, `npx playwright install --with-deps chromium` installs the browser's
system libraries too.

`npm test` runs the suite against ASP.NET Core, and so does `npm run test:aspnetcore`; `npm run test:nitro` runs it
against Nitro. Playwright starts the backend on `http://localhost:4173` and stops it at the end: ASP.NET Core builds
first (a minute or two the first time), Nitro starts its development server in a few seconds. The results go to the
project `sample-app-<backend>`, `sample-app-aspnetcore` or `sample-app-nitro`; point elsewhere with
`PIWI_DASHBOARD_URL` / `PIWI_PROJECT_NAME`, in the environment or in a `.env` file (see `.env.example`).

To open the app yourself, `npm run start:aspnetcore` or `npm run start:nitro`, then `http://localhost:4173`. A suite
run started meanwhile uses it, whichever backend it is.

`npm run test:<backend>` picks a backend by the script's name. With `npx playwright test`, and for the other scripts
(`test:manual-reporter`, `demo:functions`), set `SAMPLE_BACKEND`:

```bash
SAMPLE_BACKEND=nitro npx playwright test
```

```powershell
$env:SAMPLE_BACKEND='nitro'; npx playwright test
```

Inside the Piwi repository the sample runs without an install of its own: the suite and the Nitro backend find their
packages in the repository's `node_modules`, where the reporter is its workspace (`npm run reporter:build` in
`packages/reporter` builds it), and the Nitro backend builds the integration from its source. An `npm install` here
switches both to the published packages.

> **One test fails and one leaks on purpose.** `failing-locator.spec.ts` clicks a button by its former label, to show
> what the dashboard keeps on a failure: the ARIA snapshot, a locator suggestion and the *Alternative locators* panel.
> `resource-leak.spec.ts` leaves a browser context open.

## What it shows

Each row is something Piwi records, the spec that shows it, and whether each backend provides it. A spec that needs a
feature its backend does not provide is skipped with the reason; `backends.ts` lists each backend's features.

| Feature | Shown by | ASP.NET Core | Nitro |
|---|---|:---:|:---:|
| Network, console, Web Vitals, locators and page state ([capture fixtures](https://piwitests.dev/guide/capture-fixtures)) | `home`, `form`, `console`, `popup`, `multi-page`, `browser-newpage`, `context-newpage` | ✓ | ✓ |
| Failure evidence: screenshot, trace, video, ARIA snapshot, locator healing | `failing-locator` | ✓ | ✓ |
| Slow endpoints, with `/api/users/1` and `/api/users/2` grouped as one route | `slow-endpoint` | ✓ | ✓ |
| Resources: CPU, memory, disk, and what a test leaves open | `resource-leak` | ✓ | ✓ |
| Tags, owners and features | `tags-and-ownership`, `shop` | ✓ | ✓ |
| Page objects as fixtures, and [recording from the editor](https://piwitests.dev/features/editor-recording) | `shop`, `shop-recorded` | ✓ | ✓ |
| [Backend logs](https://piwitests.dev/guide/backend-logs): the server's warnings and errors on each request | `backend-logs` | ✓ | ✓ |
| Route manifest: the routes the backend declares, so the Test Map names the ones no test reaches (`GET /api/orders`) | `route-manifest` | ✓ | only the routes it has answered |
| Server spans on each request (`X-Piwi-Trace`) | `server-spans` | only for a probe | ✓ |
| [Server probes](https://piwitests.dev/features/probes#server-probes): a signed fault applied inside the server | `server-probes` | ✓ | ✓ |
| [Server coverage](https://piwitests.dev/features/code-reach#server-code): the backend lines each test ran | `server-coverage`, `shop` | ✓ | |
| [Code reach](https://piwitests.dev/features/code-reach): the browser files each test ran (`web/assets/*.js`) | every page spec | ✓ | ✓ |
| Page inventory: the controls and links no test uses (the shop's **Orders** link) | every passing spec | ✓ | ✓ |
| The API contract below | `api-contract` | ✓ | ✓ |

The reporter options are in `playwright.shared.ts`: on top of the defaults, the page inventory, a video of a failing
test, leak reports, and `coverage: { browser: 'files', server: 'lines' }` (the server side only for a backend with
coverage). `piwi.manifest.json` names the pages, so on the dashboard `/shop/orders` shows as declared and never
reached. A backend whose route manifest declares its routes (ASP.NET Core) adds them, so `GET /api/orders` shows the
same, and so does `GET /api/before-all-marker`, which only a `beforeAll` hook calls.

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
| `server-spans.spec.ts` | `X-Piwi-Trace` names the request on its root span |
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

### Two setups for the fixtures, two wirings for the reporter

- **Option A**, `tests/fixtures.ts`: `base.extend(piwiFixtures)`. **Option B with composition**,
  `tests/fixtures-composed.ts` and `tests/shop-fixtures.ts`: `extendPiwiFixtures(base).extend<MyFixtures>({ … })`,
  your own fixtures on top of the capture fixtures. Every spec imports `test` from one of them, never from
  `@playwright/test`: that import is what switches capture on.
- `playwright.config.ts`, the recommended wiring: `wrapConfig` adds the reporter and its global setup (`npm test`).
  `playwright.manual-reporter.config.ts`: the reporter in the `reporter` array (`npm run test:manual-reporter`). Both
  take the suite, the backend and the reporter options from `playwright.shared.ts`.

## Record a test from your editor

The shop is there to try [recording from the editor](https://piwitests.dev/features/editor-recording): **Piwi: Record
here** in VS Code, or **Tools → Piwi → Record Here**, Alt+Enter or Alt+Insert in a JetBrains IDE. The steps you take in
the browser it opens are written at the cursor, and the ones the page objects already perform become calls to them,
taken from the fixtures.

- **Page objects** (`tests/pages/`): `LoginPage.login(email, password)`, `ProductsPage.addToCart(product)`,
  `CheckoutPage.placeOrder({ name, address, city })`.
- **Fixtures** (`tests/shop-fixtures.ts`): the three page objects, `shopper` (the test data, an option a spec can
  override with `test.use`) and `signedIn` (signs the shopper in by cookie, so a test starts on the products).
- **Test functions catalog**: `scripts/shop-functions.json` describes each page-object method as the
  [catalog](https://piwitests.dev/features/test-functions) stores it: its parameters, the steps it performs and where
  each parameter comes from. `npm run demo:functions` registers them on the instance.

### Set it up

1. Copy `.env.example` to `.env` and set the dashboard's address (and an API key when it has sign-in).
2. `npm test` once, so the run creates the project, then `npm run demo:functions`: the three page-object methods
   appear under **Project → Test functions**. With Nitro, `npm run test:nitro`, and `SAMPLE_BACKEND=nitro` for
   `demo:functions`, so it registers them in `sample-app-nitro`.
3. Start the app with `npm run start:aspnetcore` or `npm run start:nitro` (a recording does not start the
   `webServer`), and open this folder in your editor with the Piwi extension; it connects through `.env`.

### Demo script

1. **The fixtures.** Open `tests/shop-fixtures.ts`, then `tests/shop.spec.ts`: each test asks for the page objects it
   needs, `async ({ page, loginPage, shopper }) => …`.
2. **The catalog.** In the dashboard, **Project → Test functions** lists `login`, `addToCart` and `placeOrder`, each
   with the steps it performs. **Add function** shows how one is registered by hand, from pasted source with AI, or by
   a coding agent.
3. **Record steps into a test.** Open `tests/shop-recorded.spec.ts`, put the cursor in the empty test and run **Piwi:
   Record here**. Give `/shop/login` as the start page; the page the steps run on is `page`. In the browser: sign in as
   `alice@example.com` with any password, open **Trail shoes** and **Add to cart**, do the same for **Water bottle**.
   Press **Check an element** in the recording bar and pick the **Cart (2)** link: its text is offered first, as the
   page shows it; **Add the check**. Open **Cart**, **Checkout**, fill in the shipping form and **Place order**. On the
   confirmation, check the summary line the same way, then press **Check the address** and keep `/shop/done`. Each
   step appears in the editor as you go, and runs of them turn into calls once their last step is recorded:

   ```ts
   await test.step('/shop/login', async () => {
     await page.goto('/shop/login');
     await loginPage.login('alice@example.com', process.env.E2E_PASSWORD ?? '');
   });
   await test.step('/shop', async () => {
     await productsPage.addToCart('Trail shoes');
     await productsPage.addToCart('Water bottle');
     await expect(page.getByRole('link', { name: 'Cart' })).toHaveText('Cart (2)');
     await page.getByRole('link', { name: 'Cart' }).click();
   });
   await test.step('/shop/cart', async () => {
     await expect(page).toHaveURL(/\/shop\/cart(?:[?#]|$)/);
     await expect(page.getByRole('button', { name: 'Checkout' })).toHaveCount(1);
     await page.getByRole('button', { name: 'Checkout' }).click();
   });
   await test.step('/shop/checkout', async () => {
     await checkoutPage.placeOrder({ name: 'Alice Martin', address: '12 Harbour Street', city: 'La Rochelle' });
   });
   await test.step('/shop/done', async () => {
     await expect(page.locator('#summary')).toHaveText('2 item(s) on their way to La Rochelle, France.');
     await expect(page).toHaveURL('/shop/done');
   });
   ```

   Between two steps of your own that lead to another page, the code waits for it; a page object's call waits for its
   pages itself. The password is never recorded: the code reads `E2E_PASSWORD`, and a warning says so. The checks are
   written where you added them; the file imports only `test`, so the recording adds
   `import { expect } from './shop-fixtures';` at the top. While the pick and its dialog are open, nothing you click is
   recorded.
4. **The code options.** Open `playwright.shared.ts`: its `'@piwi'` section asks for a `test.step` per page, which is
   why the steps above are grouped, and gives a new test the `@recorded` tag and the shop team as owner. Change
   `testSteps` to `'none'` and record again: the steps come out one after another.
5. **Pause.** Press **Pause** in the browser's recording bar, look around the shop, then **Resume**: nothing done
   meanwhile is written. The editor shows the pause too.
6. **Stop and undo.** **Stop** in the browser or the editor. One **Undo** removes the whole recording; **Redo** puts it
   back.
7. **A new test.** Put the cursor below the last test of `tests/shop.spec.ts` and record again: a whole `test(…)` is
   written, tagged `@recorded` and owned by `@shop-team`, taking the page objects as fixtures,
   `async ({ page, loginPage, productsPage, checkoutPage }) => …`, with no import or `new`.
8. **Run it.** Rename `test.fixme` to `test` and run the spec: it passes, with `E2E_PASSWORD` from `.env`.

## The contract

What a backend implements to join the sample. The suite checks it: `api-contract.spec.ts` first, then the page specs.

### Serving

- Port **4173**, `http://localhost:4173`, in an environment where the Piwi integration is active (ASP.NET Core:
  Development; Nitro: its development server, `nitro dev`).
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
| `GET /api/users/{id}` | 200 `{ id, name: "User <id>" }`; 404 `{ error }` when `id` is not an integer | |
| `GET /api/slow` | 200 `{ ok: true }` after 800 ms | |
| `GET /api/report` | 200 `{ items: 3, cached: true }` | Logs a Warning `demo: low stock for item Alpha` under an inventory category, then an Error `demo: price sync failed, using cached prices` with an exception |
| `GET /api/failing` | 500, any body | An unhandled exception, `demo: inventory backend exploded`, logged as an Error before the response starts |
| `GET /api/child`, `GET /api/before-all-marker` | 200 `{ ok: true }` | |
| `GET /api/products` | 200 `[{ slug, name, price, description }]`: `trail-shoes` 89, `rain-jacket` 129, `water-bottle` 19 | |
| `GET /api/products/{slug}` | 200 the product; 404 for a product the shop does not sell | |
| `POST /api/orders` | 201 `{ id, shopper, name, city, country, count, total, summary }` | Reads the shopper from the `shop_user` cookie: 401 without it. The body is `{ items: [slug], shipping: { name, address, city, country } }`; 400 for an empty cart, a product the shop does not sell, a missing name, address or city, or a country outside France, Germany, Spain and the United Kingdom, logged as a Warning. `summary` is `"<count> item(s) on their way to <city>, <country>."` |
| `GET /api/orders` | 200 the shopper's orders, newest first; 401 without the cookie | Only the order history calls it, and no test opens it |

### The Piwi integration

What the backend's integration adds, in the environments it is active in. `backends.ts` records which of these a
backend provides, and the specs for the others are skipped.

| | What the backend sends | ASP.NET Core | Nitro |
|---|---|:---:|:---:|
| `X-Piwi-Logs` | On every response: the Warning, Error and Critical entries the request logged, as gzip-compressed, Base64-encoded JSON (`[]` when none) | ✓ | ✓ |
| `GET /__piwi/manifest` | The routes it declares, every page above among them | ✓ | the routes it has answered since it started |
| `X-Piwi-Probe` → `X-Piwi-Trace` | Applies a fault signed with `PIWI_PROBE_SECRET` (the sample's is `piwi-sample-probe-secret`, in `backends.ts`) when `PIWI_SERVER_PROBES=true`, and names it on the response's root span (`piwi.probe.applied`) | ✓ | ✓ |
| `X-Piwi-Trace` | The server's spans on every response | | ✓ |
| `X-Piwi-Coverage`, `POST /__piwi/coverage/collect`, `GET /__piwi/coverage/run` | In a coverage build: the id of each request's coverage, and the coverage of the ids a test received | ✓ | |

The [backend instrumentation guide](https://piwitests.dev/guide/backend-logs) covers wiring each integration into your
own app: ASP.NET Core apps on the classic `Startup` model, apps that log through Serilog, test tiers with their own
environment names, Nuxt.

### Adding a backend

1. A folder `backends/<name>/` that serves the pages and the API above with the backend's Piwi integration, and runs
   from its own command on port 4173.
2. An entry in `BACKENDS` in `backends.ts`: its command (and environment), its start timeout, its features.
3. `test:<name>` and `start:<name>` scripts in `package.json`, and an entry in `release-please-config.json` for each
   pinned Piwi package version it uses.
4. `npm run test:<name> -- api-contract`, then the whole suite. The dashboard project is `sample-app-<name>`.

## The ASP.NET Core backend

`backends/aspnetcore/` is a minimal API app (.NET 10). `Program.cs` wires the integration:
`builder.AddPiwiTestLogs()` and `app.UsePiwiTestLogs()` first in the pipeline, and no exception handler of its own: the
developer exception page answers the unhandled exception of `/api/failing` with a 500, and the middleware records the
exception on that response's `X-Piwi-Logs`. The pages are served from `Endpoints/PageEndpoints.cs`, the API from
`Endpoints/DemoEndpoints.cs` and `Endpoints/ShopEndpoints.cs`, as method handlers calling the services in `Services/`: a
coverage build records a method per test, and an inline lambda handler only for the whole run.

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

## The Nitro backend

`backends/nitro/` is a standalone [Nitro](https://nitro.build) 2 app. Its routes are the files under `routes/`, one per
route: the pages (`routes/*.get.ts`, `routes/shop/`), each serving its file of `web/pages` through
`utils/page-files.ts`, and the API (`routes/api/`), handlers calling the services in `services/`, as the ASP.NET Core
endpoints do. `nitro.config.ts` serves `web/assets` at `/assets`. The whole Piwi integration is one file,
`plugins/piwi-test-logs.ts`, which Nitro loads on startup (in a Nuxt app it goes in `server/plugins/`):

```ts
export { default } from '@piwitests/instrumentation-nitro';
```

- **Backend logs.** The integration captures the warnings and errors logged through `consola`, and a request's
  unhandled error; a bare `console.warn` is not captured. `services/inventory-service.ts` logs through `consola` for
  `/api/report`, and `/api/failing` throws. An entry's message is every argument of the log call, so the error of
  `/api/report` reads `demo: price sync failed, using cached prices Error: demo: the price feed did not answer in time`,
  with the exception's stack.
- **Active outside production.** Capture is on when `NODE_ENV` is unset, `development` or `test`, as under
  `nitro dev`. `PIWI_TEST_LOGS_DISABLED=true` turns it off anywhere, `PIWI_TEST_LOGS_DISABLED=false` on in a production
  build.
- **Environment.** `nitro.config.ts` gives `nitro dev` (what `backends.ts` and `start:nitro` run) the probe secret,
  `PROBE_SECRET` from `backends.ts`, and `PIWI_SERVER_PROBES=true`, unless the environment sets them.
- **Route manifest.** Nitro has no route table to read while it runs, so the integration's `/__piwi/manifest` lists the
  routes the server has answered since it started, by their paths (`GET /api/products/rain-jacket`, a number folded to
  `:id`). The reporter reads it as the run starts, before the tests reach them: `route-manifest.spec.ts` is skipped,
  and on the dashboard the pages no test reaches come from `piwi.manifest.json` only.
- **The integration's source or its package.** Inside this repository, until an `npm install` here, `nitro.config.ts`
  builds the integration from its source (`integrations/nitro/src/`), and `tsconfig.json` type-checks against it;
  otherwise the server uses the `@piwitests/instrumentation-nitro` npm package at the version release-please pins,
  bundled into the server (`externals.inline`), since the package's build imports its own modules without a file
  extension, which Node does not resolve. Keep `web/` and `backends.ts` two folders above `backends/nitro/` when you
  copy it.
- **Without the dashboard.** `npm run start:nitro`, open `http://localhost:4173/backend`, and **Load report** with the
  browser's network panel open: the response's `X-Piwi-Logs` header holds the two entries, compressed and encoded.
