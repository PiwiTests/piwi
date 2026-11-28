/**
 * Real Playwright error texts, one per message shape the parser covers:
 * action timeouts with their call log (an inert element's included, 1.65),
 * web-first assertions in the 1.49+ `Locator:/Expected:/Received:/Timeout:`
 * layout (a locator given a `describe()` included) and the older `Timed out …
 * waiting for expect(…)` layout, value assertions, strict-mode violations,
 * navigation errors, test timeouts (bare, joined with the pending action, in a
 * hook, during teardown), closed pages, thrown errors, ANSI-colored output and
 * the synthetic `at file:line:col` frame the reporter appends.
 */

export const ESC = String.fromCharCode(27);
export const STACK = '\n    at tests/checkout.spec.ts:42:5';

export const ERRORS = {
  clickNotEnabled: `TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Pay' })
  - locator resolved to <button disabled type="submit" data-testid="checkout-pay">Pay now</button>
  - attempting click action
  - waiting for element to be visible, enabled and stable
  - element is not enabled
  - retrying click action
  - waiting 20ms
  - waiting for element to be visible, enabled and stable
  - element is not enabled
  - retrying click action
  - waiting 100ms
${STACK}`,

  fillNotFound: `TimeoutError: locator.fill: Timeout 10000ms exceeded.
Call log:
  - waiting for getByLabel('Email address')
${STACK}`,

  clickNoCallLogHeader: `TimeoutError: locator.click: Timeout 30000ms exceeded.
  - waiting for getByRole('button', { name: 'Pay' })`,

  clickIntercepted: `TimeoutError: locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Save' })
  - locator resolved to <button>Save</button>
  - attempting click action
  - waiting for element to be visible, enabled and stable
  - element is visible, enabled and stable
  - scrolling into view if needed
  - done scrolling
  - <div class="modal-backdrop"></div> intercepts pointer events
  - retrying click action
  - waiting 20ms
${STACK}`,

  fillNotVisible: `TimeoutError: locator.fill: Timeout 5000ms exceeded.
Call log:
  - waiting for getByPlaceholder('Search')
  - locator resolved to <input hidden placeholder="Search"/>
  - fill("hello")
  - attempting fill action
  - waiting for element to be visible, enabled and editable
  - element is not visible
  - retrying fill action
${STACK}`,

  clickInert: `TimeoutError: locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Place order' })
    - locator resolved to <button type="submit" class="btn-primary">Place order</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is inert
  - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is inert
    - retrying click action
      - waiting 100ms
    8 × waiting for element to be visible, enabled and stable
      - element is inert
    - retrying click action
      - waiting 500ms
    - waiting for element to be visible, enabled and stable
    - element is inert
${STACK}`,

  clickChained: `TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('row', { name: 'Ada Lovelace' }).getByRole('button', { name: 'Delete' })
${STACK}`,

  waitForSelector: `TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('#app-ready') to be visible
${STACK}`,

  toHaveCount: `Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('row')
Expected: 26
Received: 51
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for getByRole('row')
    9 × locator resolved to 51 elements
      - unexpected value "51"
${STACK}`,

  toHaveCountZero: `Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('listitem')
Expected: 3
Received: 0
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for getByRole('listitem')
    9 × locator resolved to 0 elements
      - unexpected value "0"
${STACK}`,

  toBeVisibleText: `Error: expect(locator).toBeVisible() failed

Locator: getByText('Invite sent')
Expected: visible
Received: <element(s) not found>
Timeout: 30000ms

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByText('Invite sent')
${STACK}`,

  toBeVisibleHidden: `Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'Export CSV' })
Expected: visible
Received: hidden
Timeout: 5000ms

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('button', { name: 'Export CSV' })
  - 9 × locator resolved to <button hidden class="export-btn">Export CSV</button>
    - unexpected value "hidden"
${STACK}`,

  notToBeVisible: `Error: expect(locator).not.toBeVisible() failed

Locator: locator('.spinner')
Expected: not visible
Received: visible
Timeout: 5000ms

Call log:
  - Expect "not toBeVisible" with timeout 5000ms
  - waiting for locator('.spinner')
  - 9 × locator resolved to <div class="spinner"></div>
    - unexpected value "visible"
${STACK}`,

  toHaveText: `Error: expect(locator).toHaveText(expected) failed

Locator: getByRole('heading', { level: 1 })
Expected string: "Welcome back"
Received string: "Sign in"
Timeout: 5000ms

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByRole('heading', { level: 1 })
  - 9 × locator resolved to <h1>Sign in</h1>
    - unexpected value "Sign in"
${STACK}`,

  toHaveTextDescribed: `Error: expect(locator).toHaveText(expected) failed

Locator: Order total
Expected: "$42.00"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByTestId('cart').getByTestId('order-total')
${STACK}`,

  toHaveAttribute: `Error: expect(locator).toHaveAttribute(expected) failed

Locator: locator('html')
Expected string: "dark"
Received string: "light"
Timeout: 5000ms

Call log:
  - Expect "toHaveAttribute" with timeout 5000ms
  - waiting for locator('html')
  - 9 × locator resolved to <html lang="en" data-theme="light">…</html>
    - unexpected value "light"
${STACK}`,

  toHaveURL: `Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\\/dashboard$/
Received string:  "http://localhost:3000/login?next=%2Fdashboard"
Timeout: 5000ms

Call log:
  - Expect "toHaveURL" with timeout 5000ms
  - 9 × unexpected value "http://localhost:3000/login?next=%2Fdashboard"
${STACK}`,

  toHaveTitle: `Error: expect(page).toHaveTitle(expected) failed

Expected pattern: /Dashboard/
Received string: "Sign in — Acme"
Timeout: 5000ms

Call log:
  - Expect "toHaveTitle" with timeout 5000ms
${STACK}`,

  timedOutExpectOldFormat: `Error: Timed out 5000ms waiting for expect(locator).toBeVisible()

Locator: locator('.modal.is-open')
Expected: visible
Received: <element(s) not found>
Call log:
  - expect.toBeVisible with timeout 5000ms
  - waiting for locator('.modal.is-open')
${STACK}`,

  toPass: `Error: expect(received).toPass() failed

Timeout: 10000ms

Call log:
  - Expect "toPass" with timeout 10000ms
${STACK}`,

  toBeValue: `Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 401
${STACK}`,

  toContainValue: `Error: expect(received).toContain(expected) // indexOf

Expected substring: "confirmed"
Received string:    "pending"
${STACK}`,

  toEqualDiff: `Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

  Object {
-   "count": 3,
+   "count": 4,
  }
${STACK}`,

  strictClick: `Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements:
    1) <button class="btn btn-primary" data-testid="primary-btn">Primary</button> aka getByTestId('primary-btn')
    2) <button disabled class="btn">Disabled</button> aka getByRole('button', { name: 'Disabled' })
    3) <button class="btn btn-loading">Loading…</button> aka getByRole('button', { name: 'Loading…' })

Call log:
  - waiting for getByRole('button')
${STACK}`,

  strictExpect: `Error: expect.toBeVisible: Error: strict mode violation: getByText('Save') resolved to 2 elements:
    1) <button>Save</button> aka getByRole('button', { name: 'Save' })
    2) <span>Save</span> aka getByText('Save', { exact: true })

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Save')
${STACK}`,

  gotoRefused: `Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/
Call log:
  - navigating to "http://localhost:3000/", waiting until "load"
${STACK}`,

  gotoTimeout: `TimeoutError: page.goto: Timeout 30000ms exceeded.
Call log:
  - navigating to "http://localhost:3000/users", waiting until "load"
${STACK}`,

  gotoDns: `Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://staging.example.internal/login
Call log:
  - navigating to "https://staging.example.internal/login", waiting until "load"
${STACK}`,

  waitForURL: `TimeoutError: page.waitForURL: Timeout 5000ms exceeded.
Call log:
  - waiting for navigation to "/dashboard" until "load"
  -   navigated to "http://localhost:3000/login"
${STACK}`,

  testTimeoutBare: `Test timeout of 30000ms exceeded.`,

  testTimeoutJoined: `Test timeout of 30000ms exceeded.
---
locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Pay' })
  - locator resolved to <button disabled>Pay now</button>
  - attempting click action
  - waiting for element to be visible, enabled and stable
  - element is not enabled
${STACK}`,

  testTimeoutHook: `Test timeout of 30000ms exceeded while running "beforeEach" hook.
${STACK}`,

  testTimeoutTeardown: `Test timeout of 30000ms exceeded while tearing down "context".`,

  testTimeoutGoto: `Test timeout of 30000ms exceeded.
---
page.goto: Test timeout of 30000ms exceeded.
Call log:
  - navigating to "http://localhost:3000/reports", waiting until "load"
${STACK}`,

  testTimeoutExpect: `Test timeout of 30000ms exceeded.
---
Error: expect(locator).toBeVisible() failed

Locator: getByText('Order confirmed')
Expected: visible
Timeout: 30000ms

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByText('Order confirmed')
${STACK}`,

  crashClosed: `Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for getByRole('button', { name: 'Continue' })
${STACK}`,

  crashGoto: `Error: page.goto: Target page, context or browser has been closed${STACK}`,

  pageCrashed: `Error: page.click: Page crashed${STACK}`,

  thrownError: `Error: Payment provider returned an unexpected status
    at tests/checkout.spec.ts:20:11`,

  thrownTypeError: `TypeError: Cannot read properties of undefined (reading 'id')
    at tests/users.spec.ts:33:17
    at node_modules/@playwright/test/lib/worker.js:1:1`,

  ansiColored: `${ESC}[31mError: ${ESC}[39mexpect(locator).toBeVisible() failed

Locator: getByText('Settings saved')
Expected: ${ESC}[32mvisible${ESC}[39m
Received: ${ESC}[31m<element(s) not found>${ESC}[39m
Timeout: 5000ms

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Settings saved')
${STACK}`,

  apiRefused: `Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:4000
Call log:
  - → GET http://127.0.0.1:4000/api/health
${STACK}`,
} as const;

export type ErrorKey = keyof typeof ERRORS;
