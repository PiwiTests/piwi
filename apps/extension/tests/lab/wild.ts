import type { Page } from '@playwright/test';
import { pause, retype, type, type Scenario } from './scenarios.js';

/**
 * The lab's scenarios on public sites, recorded as **Report a bug** records
 * them: pages the extension was not built against, each picked for something a
 * locator or a replay has to cope with (a button whose id or text changes on
 * every load, identical buttons, a hover menu, a React field, a delayed
 * element, a new tab). Run with `LAB_SET=wild`.
 *
 * The sites belong to others and change: a failure here is a lead to follow,
 * not a verdict. Each scenario changes nothing a second run would find
 * changed, beyond what the site resets on every visit.
 */

const TODO = 'https://demo.playwright.dev/todomvc/#/';
const INTERNET = 'https://the-internet.herokuapp.com';
const UITAP = 'http://uitestingplayground.com';

async function addTodos(page: Page, ...todos: string[]): Promise<void> {
  await page.getByRole('textbox', { name: 'What needs to be done?' }).click();
  for (const todo of todos) {
    await type(page, todo);
    await page.keyboard.press('Enter');
    await pause(page, 400);
  }
}

const bug = { mode: 'bug', settleMs: 2000 } as const;

export const WILD_SCENARIOS: Scenario[] = [
  // TodoMVC: every row's checkbox is named "Toggle Todo", its delete button shows on hover only.
  {
    name: 'wild-todomvc-complete-filter',
    start: TODO,
    ...bug,
    run: async (page) => {
      await addTodos(page, 'buy milk', 'walk the dog', 'file taxes');
      await page.getByRole('listitem').filter({ hasText: 'walk the dog' }).getByRole('checkbox').click();
      await pause(page);
      await page.getByRole('link', { name: 'Active' }).click();
      await pause(page);
      await page.getByRole('link', { name: 'Completed' }).click();
      await pause(page);
      await page.getByRole('link', { name: 'All' }).click();
      await pause(page);
      await page.getByRole('button', { name: 'Clear completed' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-todomvc-edit-delete',
    start: TODO,
    ...bug,
    hovers: 1,
    run: async (page) => {
      await addTodos(page, 'buy milk', 'walk the dog');
      await page.getByTestId('todo-title').filter({ hasText: 'buy milk' }).dblclick();
      await pause(page, 600);
      await page.keyboard.press('ControlOrMeta+A');
      await type(page, 'buy oat milk');
      await page.keyboard.press('Enter');
      await pause(page);
      const row = page.getByRole('listitem').filter({ hasText: 'walk the dog' });
      await row.hover();
      await pause(page, 600);
      await row.getByRole('button', { name: 'Delete' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-todomvc-toggle-all',
    start: TODO,
    ...bug,
    run: async (page) => {
      await addTodos(page, 'one', 'two');
      await page.getByText('Mark all as complete').click();
      await pause(page);
      await page.getByRole('listitem').filter({ hasText: 'one' }).getByRole('checkbox').click();
      await pause(page);
    },
  },

  // The Internet: identical buttons, unlabelled checkboxes, a native select, controls that come and go.
  {
    name: 'wild-internet-add-remove',
    start: `${INTERNET}/add_remove_elements/`,
    ...bug,
    run: async (page) => {
      for (let i = 0; i < 3; i++) {
        await page.getByRole('button', { name: 'Add Element' }).click();
        await pause(page, 400);
      }
      await page.getByRole('button', { name: 'Delete' }).nth(1).click();
      await pause(page);
      await page.getByRole('button', { name: 'Delete' }).first().click();
      await pause(page);
    },
  },
  {
    name: 'wild-internet-checkboxes',
    start: `${INTERNET}/checkboxes`,
    ...bug,
    run: async (page) => {
      await page.getByRole('checkbox').first().click();
      await pause(page);
      await page.getByRole('checkbox').nth(1).click();
      await pause(page);
    },
  },
  {
    name: 'wild-internet-dropdown',
    start: `${INTERNET}/dropdown`,
    ...bug,
    run: async (page) => {
      // A closed native select changes with the arrow keys, as a person's keyboard changes it.
      await page.getByRole('combobox').focus();
      await page.keyboard.press('ArrowDown');
      await pause(page, 400);
      await page.keyboard.press('ArrowDown');
      await pause(page);
    },
  },
  {
    name: 'wild-internet-dynamic-controls',
    start: `${INTERNET}/dynamic_controls`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'Remove' }).click();
      await page.getByText("It's gone!").waitFor();
      await pause(page);
      await page.getByRole('button', { name: 'Add' }).click();
      await page.getByText("It's back!").waitFor();
      await pause(page);
      await page.getByRole('button', { name: 'Enable' }).click();
      await page.getByText("It's enabled!").waitFor();
      await pause(page);
      await page.getByRole('textbox').click();
      await type(page, 'hello');
      await pause(page);
    },
  },
  {
    name: 'wild-internet-hovers',
    start: `${INTERNET}/hovers`,
    ...bug,
    hovers: 1,
    run: async (page) => {
      const figure = page.locator('.figure').nth(1);
      await figure.hover();
      await pause(page, 600);
      await figure.getByRole('link', { name: 'View profile' }).click();
      await page.waitForURL(/\/users\/2/);
      await pause(page);
    },
  },
  {
    name: 'wild-internet-tables',
    start: `${INTERNET}/tables`,
    ...bug,
    run: async (page) => {
      await page.locator('#table1').getByText('Last Name').click();
      await pause(page);
      await page.locator('#table1').getByText('Last Name').click();
      await pause(page);
      await page
        .locator('#table2')
        .getByRole('row')
        .filter({ hasText: 'fbach@yahoo.com' })
        .getByRole('link', { name: 'edit' })
        .click();
      await pause(page);
    },
  },
  {
    name: 'wild-internet-challenging-dom',
    start: `${INTERNET}/challenging_dom`,
    ...bug,
    run: async (page) => {
      // The three buttons get a new id and a new text on every load; the table's links share their names.
      await page.getByRole('row').filter({ hasText: 'Iuvaret3' }).getByRole('link', { name: 'edit' }).click();
      await pause(page);
      await page.locator('a.button.success').click();
      await page.waitForLoadState('load');
      await pause(page, 1500);
      await page.locator('a.button.alert').click();
      await page.waitForLoadState('load');
      await pause(page, 1500);
    },
  },
  {
    name: 'wild-internet-dynamic-loading',
    start: `${INTERNET}/dynamic_loading/2`,
    ...bug,
    run: async (page) => {
      // "Hello World!" is added to the page about five seconds after Start.
      await page.getByRole('button', { name: 'Start' }).click();
      await page.getByText('Hello World!').waitFor({ timeout: 20_000 });
      await pause(page, 600);
      await page.getByRole('heading', { name: 'Hello World!' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-internet-login',
    start: `${INTERNET}/login`,
    ...bug,
    secrets: ['SuperSecretPassword!'],
    run: async (page) => {
      await page.getByRole('textbox', { name: 'Username' }).click();
      await type(page, 'tomsmith');
      await page.getByRole('textbox', { name: 'Password' }).click();
      await type(page, 'SuperSecretPassword!');
      await page.getByRole('button', { name: 'Login' }).click();
      await page.waitForURL(/\/secure/);
      await pause(page);
      await page.getByRole('link', { name: 'Logout' }).click();
      await page.waitForURL(/\/login/);
      await pause(page);
    },
  },
  {
    name: 'wild-internet-key-presses',
    start: `${INTERNET}/key_presses`,
    ...bug,
    run: async (page) => {
      await page.getByRole('textbox').click();
      await page.keyboard.press('Tab');
      await pause(page, 400);
      await page.getByRole('textbox').click();
      await type(page, 'q');
      await pause(page);
    },
  },
  {
    name: 'wild-internet-drag-drop',
    start: `${INTERNET}/drag_and_drop`,
    ...bug,
    run: async (page) => {
      await page.locator('#column-a').dragTo(page.locator('#column-b'));
      await pause(page);
    },
  },
  {
    name: 'wild-internet-jquery-menu',
    start: `${INTERNET}/jqueryui/menu`,
    ...bug,
    run: async (page) => {
      // A jQuery UI menu opens its submenus on mouseenter.
      await page.getByRole('menuitem', { name: 'Enabled' }).hover();
      await pause(page, 800);
      await page.getByRole('menuitem', { name: 'Back to JQuery UI' }).click();
      await page.waitForURL(/\/jqueryui$/);
      await pause(page);
    },
  },
  {
    name: 'wild-internet-new-window',
    start: `${INTERNET}/windows`,
    ...bug,
    run: async (page) => {
      const opened = page.context().waitForEvent('page');
      await page.getByRole('link', { name: 'Click Here' }).click();
      const tab = await opened;
      await tab.waitForLoadState();
      await pause(tab);
    },
  },
  {
    name: 'wild-internet-history',
    start: `${INTERNET}/status_codes`,
    ...bug,
    run: async (page) => {
      await page.getByRole('link', { name: '404' }).click();
      await page.waitForURL(/\/404$/);
      await pause(page);
      await page.goBack();
      await pause(page);
      await page.getByRole('link', { name: '200' }).click();
      await page.waitForURL(/\/200$/);
      await pause(page);
    },
  },

  // UI Testing Playground: pages built to break locators and replays.
  {
    name: 'wild-uitap-dynamic-id',
    start: `${UITAP}/dynamicid`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'Button with Dynamic ID' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-class-attr',
    start: `${UITAP}/classattr`,
    ...bug,
    run: async (page) => {
      // Three buttons named "Button", in an order and with class lists that change on every load.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.locator('.btn-primary').click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-hidden-layers',
    start: `${UITAP}/hiddenlayers`,
    ...bug,
    run: async (page) => {
      // The green button, once clicked, is covered by the blue one.
      await page.locator('#greenButton').click();
      await pause(page);
      await page.locator('#blueButton').click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-load-delay',
    start: `${UITAP}/`,
    ...bug,
    run: async (page) => {
      await page.getByRole('link', { name: 'Load Delay' }).click();
      await page.getByRole('button', { name: 'Button Appearing After Delay' }).waitFor({ timeout: 30_000 });
      await pause(page);
      await page.getByRole('button', { name: 'Button Appearing After Delay' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-ajax',
    start: `${UITAP}/ajax`,
    ...bug,
    run: async (page) => {
      // The label the server sends comes about fifteen seconds after the click.
      await page.getByRole('button', { name: 'Button Triggering AJAX Request' }).click();
      await page.getByText('Data loaded with AJAX get request.').waitFor({ timeout: 30_000 });
      await pause(page, 600);
      await page.getByText('Data loaded with AJAX get request.').click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-click',
    start: `${UITAP}/click`,
    ...bug,
    run: async (page) => {
      // The button ignores a click a script sends: only a real mouse makes it turn green.
      await page.getByRole('button', { name: 'Button That Ignores DOM Click Event' }).click();
      await pause(page);
      await page.getByRole('button', { name: 'Button That Ignores DOM Click Event' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-text-input',
    start: `${UITAP}/textinput`,
    ...bug,
    run: async (page) => {
      // The button takes the typed name once clicked.
      await page.getByRole('textbox', { name: 'Set New Button Name' }).click();
      await type(page, 'Piwi Button');
      await page.getByRole('button', { name: "Button That Should Change it's Name Based on Input Value" }).click();
      await pause(page);
      await page.getByRole('button', { name: 'Piwi Button' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-scrollbars',
    start: `${UITAP}/scrollbars`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'Hiding Button' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-sample-app',
    start: `${UITAP}/sampleapp`,
    ...bug,
    secrets: ['pwd'],
    run: async (page) => {
      await page.getByRole('textbox', { name: 'User Name' }).click();
      await type(page, 'Piwi');
      await page.locator('input[type="password"]').click();
      await type(page, 'pwd');
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.getByText('Welcome, Piwi!').waitFor();
      await pause(page);
      await page.getByRole('button', { name: 'Log Out' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-mouseover',
    start: `${UITAP}/mouseover`,
    ...bug,
    hovers: 0,
    run: async (page) => {
      // The link is replaced by another as the pointer enters it.
      await page.getByText('Click me').click();
      await pause(page, 400);
      await page.getByText('Click me').click();
      await pause(page);
      await page.getByText('Link Button').click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-nbsp',
    start: `${UITAP}/nbsp`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'My Button' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-overlapped',
    start: `${UITAP}/overlapped`,
    ...bug,
    run: async (page) => {
      // The Name field is half covered until its container is scrolled.
      await page.getByPlaceholder('Id').click();
      await type(page, '42');
      await page.getByPlaceholder('Name').scrollIntoViewIfNeeded();
      await page.locator('div[style*="overflow-y: scroll"]').evaluate((el) => el.scrollBy(0, 100));
      await pause(page, 400);
      await page.getByPlaceholder('Name').click();
      await type(page, 'Piwi');
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-shadow-dom',
    start: `${UITAP}/shadowdom`,
    ...bug,
    run: async (page) => {
      await page.locator('#buttonGenerate').click();
      await pause(page);
      await page.locator('#buttonGenerate').click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-animation',
    start: `${UITAP}/animation`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'Start Animation' }).click();
      await page.getByText('Animation done').waitFor({ timeout: 15_000 });
      await pause(page, 400);
      await page.getByRole('button', { name: 'Moving Target' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-uitap-disabled-input',
    start: `${UITAP}/disabledinput`,
    ...bug,
    run: async (page) => {
      await page.getByRole('button', { name: 'Enable Edit Field with 5 seconds delay' }).click();
      await page.locator('#inputField:enabled').waitFor({ timeout: 15_000 });
      await pause(page, 400);
      await page.locator('#inputField').click();
      await type(page, 'ready');
      await pause(page);
    },
  },

  // Sites people use: a React shop, a React form kit, an encyclopedia, a news list, a catalog, an Angular blog.
  {
    name: 'wild-saucedemo-checkout',
    start: 'https://www.saucedemo.com/',
    ...bug,
    secrets: ['secret_sauce'],
    run: async (page) => {
      await page.getByPlaceholder('Username').click();
      await type(page, 'standard_user');
      await page.getByPlaceholder('Password').click();
      await type(page, 'secret_sauce');
      await page.getByRole('button', { name: 'Login' }).click();
      await page.waitForURL(/inventory/);
      // In a browser profile of its own, the shop takes no input for a few seconds after the login.
      await pause(page, 5000);
      await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
      await pause(page, 500);
      await page.locator('[data-test="add-to-cart-sauce-labs-bike-light"]').click();
      await pause(page, 500);
      await page.locator('[data-test="shopping-cart-link"]').click();
      await pause(page);
      await page.getByRole('button', { name: 'Checkout' }).click();
      await pause(page);
      await page.getByPlaceholder('First Name').click();
      await type(page, 'Ada');
      await page.getByPlaceholder('Last Name').click();
      await type(page, 'Lovelace');
      await page.getByPlaceholder('Zip/Postal Code').click();
      await type(page, '75001');
      await page.getByRole('button', { name: 'Continue' }).click();
      await pause(page);
      await page.getByRole('button', { name: 'Finish' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-saucedemo-sort',
    start: 'https://www.saucedemo.com/',
    ...bug,
    secrets: ['secret_sauce'],
    run: async (page) => {
      await page.getByPlaceholder('Username').click();
      await type(page, 'standard_user');
      await page.getByPlaceholder('Password').click();
      await type(page, 'secret_sauce');
      await page.keyboard.press('Enter');
      await page.waitForURL(/inventory/);
      // In a browser profile of its own, the shop takes no input for a few seconds after the login.
      await pause(page, 5000);
      await page.locator('[data-test="product-sort-container"]').selectOption('lohi');
      await pause(page);
      await page.getByText('Sauce Labs Onesie').click();
      await pause(page);
      await page.getByRole('button', { name: 'Back to products' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-text-box',
    start: 'https://demoqa.com/text-box',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      await page.getByPlaceholder('Full Name').click();
      await type(page, 'Ada Lovelace');
      await page.getByPlaceholder('name@example.com').click();
      await type(page, 'ada@example.com');
      await page.getByPlaceholder('Current Address').click();
      await type(page, '12 Analytical Street');
      await page.getByRole('button', { name: 'Submit' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-buttons',
    start: 'https://demoqa.com/buttons',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      // "Click Me" is a substring of the two other buttons' names.
      await page.getByRole('button', { name: 'Double Click Me' }).dblclick();
      await pause(page);
      await page.getByRole('button', { name: 'Click Me', exact: true }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-radio',
    start: 'https://demoqa.com/radio-button',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      // The radio inputs are hidden behind their labels.
      await page.getByText('Impressive', { exact: true }).click();
      await pause(page);
      await page.getByText('Yes', { exact: true }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-checkbox-tree',
    start: 'https://demoqa.com/checkbox',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      // An rc-tree: the switcher that opens a node is an empty span, the checkboxes are spans with a role.
      await page.locator('.rc-tree-switcher').first().click();
      await pause(page);
      await page.getByRole('checkbox', { name: 'Select Desktop' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-react-select',
    start: 'https://demoqa.com/select-menu',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      await page.locator('#withOptGroup').click();
      await pause(page, 600);
      await page.getByText('Group 2, option 1', { exact: true }).click();
      await pause(page);
      await page.locator('#selectOne').click();
      await pause(page, 600);
      await page.getByText('Prof.', { exact: true }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-demoqa-web-tables',
    start: 'https://demoqa.com/webtables',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      await page.getByPlaceholder('Type to search').click();
      await type(page, 'Cierra');
      await pause(page);
      await page.locator('#edit-record-1').click();
      await pause(page);
      await retype(page, page.getByPlaceholder('Salary'), '12345');
      await page.getByRole('button', { name: 'Submit' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-wikipedia-search',
    start: 'https://en.wikipedia.org/wiki/Main_Page',
    ...bug,
    run: async (page) => {
      await page.getByRole('searchbox', { name: 'Search Wikipedia' }).click();
      await type(page, 'Playwright software');
      await pause(page, 1500);
      await page.keyboard.press('Enter');
      await page.waitForLoadState('load');
      await pause(page, 1500);
    },
  },
  {
    name: 'wild-wikipedia-article',
    start: 'https://en.wikipedia.org/wiki/Playwright_(software)',
    ...bug,
    run: async (page) => {
      await page.getByRole('link', { name: 'Talk', exact: true }).click();
      await page.waitForURL(/Talk:/);
      await pause(page);
      await page.getByRole('link', { name: 'Article', exact: true }).click();
      await page.waitForURL(/\/wiki\/Playwright/);
      await pause(page);
      await page.getByRole('link', { name: 'Microsoft', exact: true }).first().click();
      await page.waitForURL(/\/wiki\/Microsoft/);
      await pause(page);
    },
  },
  {
    name: 'wild-hackernews-browse',
    start: 'https://news.ycombinator.com/',
    ...bug,
    run: async (page) => {
      await page.getByRole('link', { name: 'new', exact: true }).click();
      await page.waitForURL(/newest/);
      await pause(page);
      await page.getByRole('link', { name: 'More', exact: true }).click();
      await pause(page);
      await page.getByRole('link', { name: 'Hacker News', exact: true }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-books-catalog',
    start: 'https://books.toscrape.com/',
    ...bug,
    run: async (page) => {
      await page.getByRole('link', { name: 'Travel', exact: true }).click();
      await pause(page);
      // The cover and the title are two links to the book, both named by its title.
      await page.getByTitle("It's Only the Himalayas").click();
      await pause(page);
      await page.getByRole('link', { name: 'Home' }).click();
      await pause(page);
      await page.getByRole('link', { name: 'next' }).click();
      await pause(page);
    },
  },
  {
    name: 'wild-conduit-feed',
    start: 'https://conduit.bondaracademy.com/',
    ...bug,
    settleMs: 4000,
    run: async (page) => {
      await page.locator('.sidebar .tag-list a, .sidebar .tag-list .tag-pill').first().click();
      await pause(page, 1500);
      await page.getByText('Global Feed').click();
      await pause(page, 1500);
      await page.locator('.article-preview').nth(1).getByText('Read more...').click();
      await pause(page, 1500);
    },
  },
];
