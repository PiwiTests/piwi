# Publishing Piwi Picker to Chrome, Edge, and Firefox

**Status: live on the Chrome Web Store**, at [`pakhnokpjboejcghgcmkjlpnogfjihhe`](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe) — that ID is assigned by the store and is now permanent for this listing. **Also live on Firefox AMO**, at [`piwi-picker`](https://addons.mozilla.org/firefox/addon/piwi-picker/), under the add-on ID `picker@piwitests.dev` (§4). Edge Add-ons is still unsubmitted; §3 below is the remaining work, and it doesn't block an Edge user today (Edge installs Chrome Web Store extensions once the user allows other stores, see §3).

Current state this guide assumes: manifest name `"Piwi Picker"`, version tracked by release-please repo-wide (`apps/extension/manifest.json`'s version is already an `extra-files` target in `release-please-config.json` — no manual version bumps needed), FSL-1.1-MIT-licensed (root `LICENSE`), icons present at 16/32/48/128px, standing permissions limited to `activeTab` + `debugger` (Chrome and Edge only; `scripts/build.mjs` leaves it out of Firefox's manifest) + `scripting` + `storage`, plus `optional_host_permissions` (`http://*/*`, `https://*/*`) — declared but granted nothing until the user clicks "Record actions" and approves a single origin. See `apps/docs/extension.md`'s permissions table for the exact wording, and the note in §2 step 3 below on justifying this one to reviewers. The manifest also declares `devtools_page` (the Piwi pane and panel in DevTools), which is not a permission and shows no install warning, and one optional API permission, `cookies`, granted nothing at install (see §2 step 3).

## 0. One-time setup (per store, before your first submission)

| Store | Account | Cost | Notes |
|---|---|---|---|
| **Chrome Web Store** | [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) | $5 one-time | Needs a Google account; verify developer identity |
| **Edge Add-ons** | [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/) | Free | Microsoft account; separate registration from Chrome despite the shared Chromium base |
| **Firefox AMO** | [addons.mozilla.org developer hub](https://addons.mozilla.org/developers/) | Free | Firefox account |

**Trademark note (carried over from the original plan doc):** the store listing name can't lead with "Playwright" — the same reason this project is named Piwi, not something Playwright-branded. "Piwi Picker — locators for Playwright tests" plus a standard non-affiliation line is the pattern already used in this repo's docs; keep using it in each store's listing description.

## 1. Build a clean distributable

```bash
npm run extension:zip --workspace=apps/extension
```

Runs a **release build** (`extension:build:release`), then writes the zips next to `manifest.json` (`apps/extension/scripts/zip.mjs`, via `archiver` — pure JS, no dependency on a system `zip`/`7z` binary, so this works the same on Windows as it does in CI):

- `piwi-picker-v<version>.zip` — the add-on for the Chrome Web Store and Edge Add-ons: `dist/`'s contents with the manifest at the zip root, not nested (what stores expect), minus `.map` sourcemaps.
- `piwi-picker-v<version>-firefox.zip` — the same files from `dist-firefox/`, for Firefox AMO. The build writes both directories from the one `manifest.json`; `dist/`'s manifest leaves out `background.scripts`, the Firefox-only key (§4), which Edge lists as an error.
- `piwi-picker-v<version>-source.zip` — the sources that build came from, for Firefox only (§4 b). Chrome and Edge don't ask for it.
- `piwi-picker-v<version>-amo-metadata.json` — the Firefox listing fields the add-on can't carry itself, in both languages (§4 c).

Both are gitignored; regenerate them together whenever you need a fresh pair rather than keeping old ones around. Every release tag builds the same four files in CI and keeps them as the artifacts of its **Publish Browser Extension** run (§5): download them from there rather than building a release locally. A release build stamps `v<version>` into every bundle where a dev build (`extension:build`, `extension:dev`) stamps the build time, so the same sources always produce the same files — that is what lets Firefox reviewers rebuild the source zip and get the add-on zip back. `zip.mjs` refuses a `dist/` or `dist-firefox/` whose `background.js` does not carry the stamp of the manifest's version, so run on its own after a dev build it zips nothing.

## 2. Chrome Web Store — **done**

Live at <https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe>. The steps below are kept because every version bump repeats them (step 1 onwards, minus the listing fields you don't change).

1. Dashboard → **New item** → upload the zip.
2. Store listing requires: description, at least one 1280×800 or 640×400 screenshot, a 128×128 icon (already have it), category (Developer Tools), and a **privacy practices** disclosure. Picking and recording are zero-telemetry/zero-network by default; the one exception is the optional Piwi-instance connection (`options.html`), which — only if the user configures it — sends the API key and a project id (one per configured URL-pattern → project mapping) to fetch that project's function catalog, and nothing else (no recorded data, no browsing history). State both halves plainly rather than only the standalone claim.
3. Permission justification: Chrome's review form asks you to justify each requested permission in plain English. For `activeTab`/`scripting`/`storage`, reuse the exact wording already in `apps/docs/extension.md`'s permissions table — it's already accurate and honest. `optional_host_permissions` needs its own explanation since the two patterns (`http://*/*`, `https://*/*`) look broad on their own: say plainly that this is declared so the extension *can* request a single origin, on demand, only when the user clicks "Record actions" inside that click's own gesture — nothing is granted at install, and the grant is scoped to whichever one site the user is recording, never `<all_urls>` in practice. Reviewers specifically look for this "declared broad, granted narrow, user-gestured" pattern with optional host permissions — state it explicitly rather than assuming the manifest speaks for itself. The instance origin the settings page asks for at **Connect** also carries one content script, registered for that origin only while connected: it sets `data-piwi-picker` (the extension's version) on the instance's pages so the dashboard stops suggesting the extension, reads nothing from the page and sends nothing. If a reviewer asks about `devtools_page`: it adds a pane to DevTools that ranks the element selected there, reads the inspected page only while DevTools is open, and sends nothing anywhere; on a site it has no grant for, it asks for that one origin through the same optional host permission, inside a click. Its Network tab reads the page's requests through `chrome.devtools.network`, only while DevTools is open, keeps them in memory and sends them nowhere: a request's body leaves the browser only as the mock code the user copies or downloads, with credential fields hidden by default. Slow down or fail a request registers a script in the page's main world (as the bug report's evidence script does, under the same one-origin grant, asked for in the click) that delays or fails the page's own `fetch` and XHR calls in that one tab, until the user turns it off; it reads nothing and sends nothing. The privacy answers stay as they are (no data collected, nothing sent to the developer).

   `debugger` is a required permission: Chrome does not let it be optional (checked on Chromium: an `optional_permissions` entry cannot be requested). It shows an install warning ("Read and change all your data on all websites"), and the update that added it disabled the extension until each user accepted the new warning, a cost taken on 2026-09-28 while the extension had few users. Justification, in plain words: Piwi Picker attaches Chrome's debugging protocol to one tab, only while a feature the user started needs it, and detaches as soon as it ends; Chrome shows its own "Piwi Picker started debugging this browser" bar the whole time, and **Cancel** on it makes the feature fall back to working without it. The features: a replay of a bug report sends trusted mouse and keyboard input to the replayed tab, as Playwright does (`Input` domain); a bug report being recorded reads that tab's console, uncaught errors, failed requests (method, URL without query values, status, never a header or a body) and screenshots (`Runtime`, `Log`, `Network`, `Page.captureScreenshot`); and the DevTools panel slows down or fails the tab's requests, throttles its network and CPU, and sets its viewport (`Fetch`, `Network.emulateNetworkConditions`, `Emulation`), until the user turns that off. Nothing read through it leaves the machine: a bug report is sent to the user's own Piwi instance only from its preview, as before. The privacy answers stay as they are. On AMO nothing changes: Firefox has no `chrome.debugger`, its manifest does not ask for the permission, and every feature there works as it did without it.

   `cookies` is in `optional_permissions`, so it shows no install warning and is granted nothing at install. Justification: **Save login for tests** requests it, together with the one site's origin, inside the click that saves the login; it reads that site's cookies (`httpOnly` ones included, which a page cannot read) once, writes them with the site's `localStorage` into a Playwright `storageState` file the user downloads, and keeps nothing. In the privacy practices form, if "Authentication information" is asked about: it is read only on that click, only for the site the user is on, written to a file on the user's own machine, and never transmitted, stored by the extension or used for anything else; the page shown before saving warns that the file is a credential. On AMO this changes nothing in `data_collection_permissions` (`"none"`): no cookie leaves the browser except in the file the user saves. `store/amo-reviewer-notes.md` says the same to AMO's reviewers.
4. Submit for review. First review is typically the slowest (hours to a few days); version updates thereafter are usually faster.
5. Once approved, note the **extension ID** Chrome assigns — useful for support links and the docs page. It came out as `pakhnokpjboejcghgcmkjlpnogfjihhe`, and `apps/docs/extension.md`, `apps/docs/recipes/`, and the root `README.md` all link the listing by that ID.

## 3. Edge Add-ons

Structurally the easiest: Edge is Chromium and accepts the **same zip** as the Chrome Web Store, unmodified.

Not urgent, because Edge users are already served: opening the Chrome Web Store listing in Edge shows an **Allow extensions from other stores** banner, and after one click **Get** installs and auto-updates the extension exactly as in Chrome. That's what `apps/docs/extension.md` tells Edge users to do today. An Edge Add-ons listing buys discoverability inside Edge's own store and skips that banner — worth doing, not blocking.

1. Partner Center → **Create new extension** → upload the same zip from §1.
2. Edge's review is generally faster than Chrome's and has a lighter privacy-disclosure form — fill it out the same honest way.
3. Edge can auto-import a listing from the existing Chrome Web Store entry if you link accounts — do that rather than re-typing the listing, since Chrome is already approved.

## 4. Firefox AMO — **done**, the one with real differences

Live at <https://addons.mozilla.org/firefox/addon/piwi-picker/> (the link without a language opens AMO in the visitor's own). The steps below are kept because a manual submission repeats them, and the differences they describe still hold for every version.

**a) The Firefox-specific manifest keys are already in place.** Chromium ignores all of them, so the single built zip stays valid for all three stores:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "picker@piwitests.dev",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["none"] }
  }
},
"background": {
  "service_worker": "background.js",
  "scripts": ["background.js"]
}
```

- **`id`** — Firefox requires an explicit, stable extension ID (Chrome/Edge derive one from the store upload). **It is permanent once published**: AMO binds the listing to it, and changing it later creates a *new* add-on rather than updating the existing one, orphaning existing installs.
- **`background.scripts`** — Firefox has no extension service workers, and AMO rejects a `service_worker` without this fallback (`Unsupported "/background/service_worker" manifest property used without "/background/scripts" property as Firefox-compatible fallback`). Both keys name the same `background.js`: Firefox runs it as a non-persistent background script and ignores `service_worker` (the linter reports that as a warning, which is expected). The bundle is a plain IIFE, which works as either. Only `dist-firefox/` and its zip carry `scripts`: the build drops it from `dist/`, since Edge reports it as an error on an unpacked load (`'background.scripts' requires manifest version of 2 or lower`).
- **`data_collection_permissions`** — required for every new AMO add-on since November 2025. `"none"` because the add-on sends nothing to its developer or any third party. The only requests it ever makes go to the Piwi instance the user configures in the options page — their own server, with their own API key — and only read from it (the project list, a project's function catalog and its locator index), sending nothing but that key, a project id and a branch name. If that reading changes (a feature that sends page or recording data anywhere), this key must list the data types, and the Chrome privacy disclosure (§2 step 2) changes with it.
- **`strict_min_version` `140.0`** — the highest floor any key needs: `data_collection_permissions` needs 140, `optional_host_permissions` (the recorder's per-origin grant) needs 128, and Firefox before 121 would not start the background script at all while `service_worker` is present. 140 is an ESR release.

Check the zip with Mozilla's own linter before uploading — it is what AMO runs on upload, and it reports the same errors:

```bash
npx addons-linter apps/extension/piwi-picker-v<version>-firefox.zip
```

Expect 0 errors. The warnings it leaves are known: `service_worker` ignored by Firefox (above), `data_collection_permissions` needing Firefox for Android 142 (only relevant if the listing targets Android — leave **Firefox for Android** unchecked on AMO; the add-on is a desktop tool), and the panels' `innerHTML` assignments, which reviewers read in the source.

**b) Submit source, not just the built zip.** `dist/` is Vite-bundled and minified output, so AMO requires the original source plus build instructions, and its reviewers rebuild it and diff the result against the add-on — there must be no differences. `npm run extension:zip` produces that source package alongside the add-on (§1): `piwi-picker-v<version>-source.zip`, holding exactly what the build reads — the files git tracks in `apps/extension/`, the two workspaces it bundles from source (`packages/core`, `packages/picker-dom`), and the root `package.json`, `package-lock.json`, `.npmrc` and `tsconfig.json`, read from the working tree; a file git does not track is left out, and named in the command's output — with `apps/extension/SOURCE-BUILD.md` as its `README.md`: requirements (Node.js 24, npm), the two build commands, and how to diff the output. A zip of `apps/extension/` alone would not build, since it imports the other two workspaces. Always upload the two zips from the same `extension:zip` run.

**c) The listing, in every language of `public/_locales/`:** English (the default), French, and German, Spanish and Brazilian Portuguese, whose descriptions open with a note that the translation is a draft. AMO reads exactly three listing fields from the add-on file — the name, the summary (the manifest `description`) and the homepage (`homepage_url`) — in every language under `public/_locales/`, which `default_locale: "en"` turns on. So the zip pre-fills those in every language, and the Chrome Web Store shows the localized summary too. Everything else on the listing lives in `store/` and reaches AMO through its API, never through the zip:

| AMO field | Source |
|---|---|
| Name, summary, homepage | the manifest and `public/_locales/<code>/messages.json` (in the zip) |
| Description | `store/amo-description.<code>.md`, one per language (AMO's Markdown subset: bold, italic, links, lists; no headings) |
| Add-on URL, category, support website, license, experimental, payment, platforms | `store/amo-listing.json` (`piwi-picker`, Web Development, the GitHub issues page, MIT, no, no, Firefox desktop only) |
| Notes to reviewer | `store/amo-reviewer-notes.md`: source build, network use, permissions, the `innerHTML` warnings, how to test |
| Screenshots | not pre-fillable: upload them in the listing editor |

`npm run extension:zip` merges all of it into `piwi-picker-v<version>-amo-metadata.json`, in the shape AMO's add-on API takes. A new language is one more `public/_locales/<lang>/` directory plus `store/amo-description.<lang>.md`; `tests/unit/store-listing.test.ts` checks every language has both, and that each summary stays within 132 characters, the Chrome Web Store's limit.

Two ways to submit:

- **Everything pre-filled, through AMO's API** (`web-ext sign`, which uploads the add-on, the source and the listing in one go). Needs an API key from <https://addons.mozilla.org/developers/addon/api/key/>; run it right after `npm run extension:zip`, since it packs `dist-firefox/` itself and that must be the release build:

  ```bash
  npx web-ext sign --channel listed \
    --source-dir apps/extension/dist-firefox \
    --amo-metadata apps/extension/piwi-picker-v<version>-amo-metadata.json \
    --upload-source-code apps/extension/piwi-picker-v<version>-source.zip \
    --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" \
    --approval-timeout 0
  ```

  Then add the screenshots in the listing editor. Only the first listed version needs the metadata: for later versions leave `--amo-metadata` out, and edit the listing on AMO.
- **Through the web form**, as below: name, summary and homepage arrive from the zip in every language, and the other fields are pasted from `store/` — each other language's description through the listing editor's language selector once the add-on exists.

Submission steps (web form):
1. AMO developer hub → **Submit a New Add-on** → "On this site" (listed, public) vs "self-distribution" (unlisted) — pick listed unless there's a specific reason not to.
2. Upload `piwi-picker-v<version>-firefox.zip`, keep **Firefox for Android** unchecked, answer "does your extension contain minified/bundled/compiled code?" with yes, and upload `piwi-picker-v<version>-source.zip` when prompted.
3. Fill the rest of the listing from `store/` (§4 c), in every language, and add screenshots.
4. Firefox review is manual and can take longer than Chrome/Edge for a first submission, especially with source review involved.

**Verify, don't assume, before submitting:** Firefox's `chrome.*` namespace aliasing in MV3 is close to Chrome's but not identical everywhere, and nothing in this repo's CI exercises Firefox — the E2E harness (`apps/extension/tests/e2e/`) is Chromium-only via `--load-extension`. Run the extension in a real Firefox (`about:debugging` → **Load Temporary Add-on** → `dist-firefox/manifest.json`) before trusting the listing's "works in Firefox" claim. The one difference found so far is handled: Firefox has no `storage.session.setAccessLevel` and no session storage in content scripts, so the tools that keep state there — the recorder, the pick session, and the active-project and branch overrides — reach it through the background script instead (`src/shared/session-area.ts`). The recorder across two pages and the pick-session panel were checked in Firefox 156 that way; the rest of the tools were not.

## 5. Ongoing updates

Every store re-reviews **every version bump**, not just the first. release-please bumps `apps/extension/manifest.json`'s version repo-wide, and each release tag runs `.github/workflows/reusable-publish-extension.yml` (**Publish browser extension**, called by `release.yml`), which:

1. runs `npm run extension:zip` and keeps the four files of §1 as the run's artifacts, each one downloading as the file itself rather than inside another zip. These are the files to upload by hand;
2. submits the package to every store whose secrets are configured (repository **Settings → Secrets and variables → Actions**), and skips the others:

| Store | Secrets | What the step does |
|---|---|---|
| Chrome Web Store | `CHROME_PUBLISHER_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | Uploads `piwi-picker-v<version>.zip` and submits it for review, with [`chrome-webstore-upload-cli`](https://github.com/fregante/chrome-webstore-upload-cli) (Chrome Web Store API v2). The store publishes it once approved |
| Edge Add-ons | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` | Uploads the same zip and submits it, with [`wdzeng/edge-addon`](https://github.com/wdzeng/edge-addon) (Edge Add-ons API v1.1) |
| Firefox AMO | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | Runs `web-ext sign --channel listed` (§4) on `dist-firefox/` with the source zip, without waiting for the review |

Where each credential comes from:

- **Chrome Web Store** — the publisher ID is under **Publisher → Settings** in the Developer Dashboard. The client ID, client secret and refresh token come from a Google Cloud OAuth client with the Chrome Web Store API enabled; [chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys) walks through it. Set the OAuth consent screen's publishing status to **In production**: while it is **Testing**, the refresh token expires after 7 days.
- **Edge Add-ons** — Partner Center → **Microsoft Edge** → **Publish API** → **Create API credentials** shows the client ID and an API key; the product ID is on the extension's overview page. The API key expires on the date Partner Center shows next to it: create a new one and replace `EDGE_API_KEY` before then. The API only updates a product that exists, so the first submission (§3) is made in Partner Center.
- **Firefox AMO** — <https://addons.mozilla.org/developers/addon/api/key/> gives the JWT issuer and secret. The add-on is public on AMO, so a submission sends only the version's own fields (license, compatibility, notes to the reviewer), and the listing is edited on AMO. The workflow asks AMO's public API for `picker@piwitests.dev`, and sends the whole listing (`--amo-metadata`, §4 c) only when the API does not return it, as before the first approval. Screenshots are added in the listing editor.

A store step that fails leaves the artifacts in place: upload them by hand from the run's page. To submit a release that already has its tag, to a store configured after that release, run the workflow by hand against the tag (**Actions → Publish Browser Extension → Run workflow**, then pick the tag under **Use workflow from**); a store that already has that version rejects it again. A failed store step fails the run without holding back the other stores' steps. Run against a branch, the workflow builds the artifacts and submits nothing.

A store's listed version trails a release by its review time and, on a store without secrets, until the upload by hand.
