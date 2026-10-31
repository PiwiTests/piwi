import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type BrowserContext } from '@playwright/test';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  isEditorChallenge,
} from '@piwitests/core/editor-send';
import { PAIRING_TOKEN, pairedExtension } from './runs-fixtures.js';

/**
 * The program on the paired port: the editor, which proves it holds the pairing's token, or another program, which
 * answers without a proof. `asked` counts the challenges it got.
 */
async function program(proves: boolean): Promise<{ origin: string; asked: () => number; close(): Promise<void> }> {
  let asked = 0;
  let port = 0;
  const server: Server = createServer((req, res) => {
    const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
    if (!isEditorChallenge(challenge)) return void res.writeHead(404).end();
    asked++;
    void (async () => {
      if (proves) res.setHeader(EDITOR_PROOF_HEADER, await editorTokenProof(PAIRING_TOKEN, port, challenge));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"windows":[]}');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    asked: () => asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('the paired editor’s proof, checked where the pairing shows', () => {
  let context: BrowserContext | undefined;
  test.afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  test('says nothing more while the editor on the paired port proves it holds the token', async () => {
    const editor = await program(true);
    try {
      const paired = await pairedExtension(editor);
      context = paired.context;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${paired.extensionId}/options.html`);
      const status = page.locator('#editor-status');
      await expect(status).toHaveText(/^Paired with the editor at /);
      await expect.poll(editor.asked).toBeGreaterThan(0);
      // The answer is read after the request: give it the time a refusal would take to show.
      await page.waitForTimeout(500);
      await expect(status).toHaveText(/^Paired with the editor at /);
      await expect(status).toHaveClass('ok');
    } finally {
      await editor.close();
    }
  });

  test('says to pair again when another program holds the paired port', async () => {
    const other = await program(false);
    try {
      const paired = await pairedExtension(other);
      context = paired.context;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${paired.extensionId}/options.html`);
      await expect(page.locator('#editor-status')).toHaveText(
        /but the program on that port does not prove it is your editor, so nothing goes to it: run “Piwi: Pair with Piwi Picker” in your editor again/,
      );
      await expect(page.locator('#editor-status')).toHaveClass('error');
      await expect(page.locator('#editor-pill')).toHaveText('Paired');
    } finally {
      await other.close();
    }
  });

  test('says when nothing answers at the paired address', async () => {
    const gone = await program(true);
    await gone.close();
    const paired = await pairedExtension(gone);
    context = paired.context;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${paired.extensionId}/options.html`);
    await expect(page.locator('#editor-status')).toHaveText(/but nothing answers there now: open your editor/);
  });

  test('says when the browser no longer lets it reach the paired address', async () => {
    const paired = await pairedExtension(null);
    context = paired.context;
    // Kept as an earlier version kept it, at an address the browser does not grant.
    await paired.worker.evaluate(
      (token) => chrome.storage.local.set({ piwiEditorPairing: { url: 'http://127.0.0.1:9/piwi/send', token } }),
      PAIRING_TOKEN,
    );
    const page = await context.newPage();
    await page.goto(`chrome-extension://${paired.extensionId}/options.html`);
    await expect(page.locator('#editor-status')).toHaveText(/but the browser took back Piwi Picker’s access to it/);
  });

  test('the Runs window offers the settings while another program holds the paired port', async () => {
    const other = await program(false);
    try {
      const paired = await pairedExtension(other);
      context = paired.context;
      const runs = await context.newPage();
      await runs.goto(`chrome-extension://${paired.extensionId}/runs.html`);
      await expect(
        runs.getByText(
          'The program on the paired port is not this editor: Piwi Picker sent it nothing, and asks again in a moment. If your editor moved to another port, pair Piwi Picker with it again in the settings.',
        ),
      ).toBeVisible();
      await expect(runs.getByRole('button', { name: 'Open the settings' })).toBeVisible();
      await expect(runs.getByRole('button', { name: 'Look again' })).toBeVisible();
    } finally {
      await other.close();
    }
  });
});
