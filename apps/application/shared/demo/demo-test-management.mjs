/**
 * The demo's test management tool: the Zephyr Scale project `SHOP` that the checkout project is bound to. The demo has
 * no server to reach Zephyr, so its catalog is this list: the seed stores it, and Refresh catalog stores it again.
 * Nothing calls out.
 *
 * Wired to the checkout tests' tags (`demoTags`): `SHOP-T123` is a case the catalog holds, `SHOP-T124` is a key a test
 * carries that the catalog does not (the mapping summary lists it as unknown, and its hover card says so).
 */

/** The id of the demo's canned Zephyr Scale connection (`app/demo/api/integrations.ts`). */
export const DEMO_TEST_MANAGEMENT_CONNECTION_ID = 3;

/** The canned connection itself: `app/demo/api/integrations.ts` lists it, and the seed stores the row the binding points at. */
export const DEMO_TEST_MANAGEMENT_CONNECTION = {
  provider: 'zephyr-scale',
  name: 'Zephyr Scale Cloud (United States)',
  baseUrl: 'https://api.zephyrscale.smartbear.com/v2',
  config: { region: 'us' },
};

/** The project the checkout project is bound to, and the project the demo's pickers list first. */
export const DEMO_TEST_MANAGEMENT_PROJECT_KEY = 'SHOP';

/** The cases of `SHOP`, as the catalog stores them. */
export const DEMO_TEST_MANAGEMENT_CASES = [
  {
    key: 'SHOP-T120',
    providerId: '9120',
    name: 'Customer pays with a credit card',
    status: 'Approved',
    folder: '8001',
  },
  { key: 'SHOP-T121', providerId: '9121', name: 'Customer pays with PayPal', status: 'Approved', folder: '8001' },
  {
    key: 'SHOP-T122',
    providerId: '9122',
    name: 'Customer is told a card has expired',
    status: 'Draft',
    folder: '8001',
  },
  { key: 'SHOP-T123', providerId: '9123', name: 'Customer pays with Apple Pay', status: 'Approved', folder: '8001' },
  {
    key: 'SHOP-T130',
    providerId: '9130',
    name: 'Customer applies a discount code',
    status: 'Approved',
    folder: '8002',
  },
  {
    key: 'SHOP-T131',
    providerId: '9131',
    name: 'Customer saves a delivery address',
    status: 'Approved',
    folder: '8002',
  },
];

/** The key a checkout test carries as a tag that the catalog does not hold. */
export const DEMO_UNKNOWN_TEST_CASE_KEY = 'SHOP-T124';

/** The projects the demo's connection lists. */
export const DEMO_TEST_MANAGEMENT_PROJECTS = [
  { key: 'SHOP', enabled: true },
  { key: 'WEB_APP', enabled: true },
  { key: 'LEGACY', enabled: false },
];

/** The result statuses of every demo project. */
export const DEMO_TEST_MANAGEMENT_STATUSES = [
  { name: 'Pass', isDefault: false },
  { name: 'Fail', isDefault: false },
  { name: 'Blocked', isDefault: false },
  { name: 'Not Executed', isDefault: true },
];

/** The test cycle folders of every demo project, as the picker shows them. */
export const DEMO_TEST_MANAGEMENT_FOLDERS = [
  { id: '7001', path: 'Nightly' },
  { id: '7002', path: 'Nightly / Release 4.2' },
];
