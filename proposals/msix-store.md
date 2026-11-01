# Windows MSIX package through the Microsoft Store

A proposal to publish the desktop app on Windows as an **MSIX package in the Microsoft Store**, in addition to the
`.exe` (per-user NSIS) and `.msi` (per-machine WiX) installers attached to each GitHub release. The Store signs
the package itself, so Windows users get a signed app at no cost and without a code-signing certificate. Both
installers stay as they are.

**Status.** The name "Piwi Dashboard" is reserved in Partner Center. The spike (rollout step 2) runs in CI: the
`msix` leg of `reusable-publish-desktop.yml` packs three variants of the manifest with `scripts/msix.mjs` (the
default full-trust app, option A and option B below). `scripts/msix-check.ps1` installs each one on the runner, signed
with a certificate made for the run, and reports in the job summary where the app's writes land, whether the alias
bridges MCP, and whether a sidecar outlives an update. The shell changes, the Store submission and the docs remain.
Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet.

**Summary.** Tauri does not bundle MSIX, so a new Windows leg of `reusable-publish-desktop.yml` builds the app
without an installer (`tauri build --no-bundle`) and without the updater, then packs it with `makeappx` from a
manifest template, `src-tauri/windows/AppxManifest.xml`. The package is uploaded unsigned to Partner Center, which
signs it on certification. The shell learns to tell when it runs packaged:

- it gives other apps a stable command (an app execution alias) instead of its versioned install path;
- it registers start-on-login through the package's startup task instead of the registry;
- it reports that updates come from the Store.

The spike decides how the package keeps writing to the real `%APPDATA%`, which the data folder, Claude Desktop's
config and every Playwright run the app starts depend on.

## Why the Store

- **Signing is free.** A package installed from the Store carries Microsoft's signature: no SmartScreen prompt,
  no "Unknown publisher", and Smart App Control and company policies that block unsigned apps let it run. A
  code-signing certificate that does the same costs at least ~$10 a month (Azure Artifact Signing, open to
  individuals in the US and Canada only) or $150–300 a year (an OV certificate). Even with one, SmartScreen keeps
  warning until enough people have installed the app.
- **Registration is free.** Since 2025, an individual developer account at <https://storedeveloper.microsoft.com>
  costs nothing. It needs a government-issued ID and a selfie, and is available in nearly 200 markets, France
  included.
- **Updates come for free.** The Store updates the app in the background, and `winget install --source msstore`
  finds it with no manifest to maintain.

Submitting the `.exe` or `.msi` as a Store "Win32 app" is not an option: that path still requires the installer
to be signed by a trusted certificate authority, which is the cost this proposal avoids.

## What stays as it is

- The `.exe` and `.msi` legs, their updater channels (`latest.json`, `latest-nsis.json`) and the GitHub release
  assets. The `.msix` is never attached to a release: an unsigned package cannot be installed by users, only
  uploaded to the Store.
- The server, the sidecar, the discovery file (`~/.piwi/desktop.json` sits under `%USERPROFILE%`, outside
  AppData, so packaging leaves it alone) and the app's identifier `io.piwitests.dashboard`.

## What MSIX changes for this app

Packaged as a full-trust desktop app (`runFullTrust`), the shell runs with medium integrity, like the installers.
Windows still treats a packaged process differently in the ways below, and every process the app starts inherits
that treatment: the Node sidecar, `git`, `npm`, Playwright and its browsers, and the IDE launchers.

### 1. AppData writes are virtualized (the open question)

By default, every file or folder a packaged app **creates** under `%USERPROFILE%\AppData` goes to a private copy:

- it lands in `%LOCALAPPDATA%\Packages\<family name>\LocalCache`;
- only the package sees it;
- it is deleted when the app is uninstalled.

Edits to files that already exist go to the real files. For Piwi, that breaks:

- **the data folder** (`%APPDATA%\io.piwitests.dashboard`): a fresh install keeps its database out of reach of
  backups and the docs' instructions, and uninstalling deletes it. An existing install's folder exists already,
  so new files inside it would be split between both copies.
- **Claude Desktop's config**, which `mcp_clients.rs` writes into `%APPDATA%\Claude` or `%LOCALAPPDATA%\Claude-Data`:
  a file the app creates there is invisible to Claude Desktop. The same goes for the `.piwi-backup.json` copies.
  The MCP bundle in [`claude-desktop-bundle.md`](claude-desktop-bundle.md) would remove this case.
- **the runs the app starts**: `npx playwright install` writes browsers to `%LOCALAPPDATA%\ms-playwright`, and
  `npm` writes its cache to `%LOCALAPPDATA%\npm-cache`. A browser installed from the app would be invisible to the
  user's own terminal, and would vanish on uninstall.

There are three ways out, and the spike (rollout step 2) picks one:

| Option                                                                                                                                                              | What it takes                                                                            | Risk                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `uap10:RuntimeBehavior="win32App"`**, `TrustLevel="mediumIL"`                                                                                                  | The runtime behavior of apps "packaged with external location"; Windows 10 2004 or later | Unclear whether a regular Store package with this behavior is virtualized. The spike measures it.                                                        |
| **B. Turn virtualization off**: the `unvirtualizedResources` restricted capability, with `FileSystemWriteVirtualization` and `RegistryWriteVirtualization` disabled | One line each in the manifest                                                            | A restricted capability needs a justification at certification, and Microsoft's docs describe the `desktop6` form as meant for games. It may be refused. |
| **C. Exclude named folders** (`virtualization:ExcludedDirectories`, Windows 11)                                                                                     | The list of AppData folders: Piwi's, Claude's, `ms-playwright`, npm's, …                 | The same capability as B, and the list can never be complete: a test suite writes wherever it wants.                                                     |

The spike's test is concrete. From the packaged app, do these three things:

1. link a project;
2. install a Playwright browser;
3. connect Claude Desktop.

Then confirm from a plain PowerShell window that `%APPDATA%\io.piwitests.dashboard\.data\piwi.db`,
`%LOCALAPPDATA%\ms-playwright` and Claude's config hold what the app wrote.

### 2. HKCU registry writes are virtualized

`tauri-plugin-autostart` turns **Start on login** on with a value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Unless option B also turns registry virtualization off,
Windows ignores that value for a package.

- **What the package does instead:** it declares a `windows.startupTask` extension (task id `PiwiStartup`,
  started with `--hidden`).
- **What the shell does:** when packaged, the tray's toggle enables and disables the task through the
  `StartupTask` API (the `windows` crate's `ApplicationModel` feature).

### 3. The install path changes with every update

The package lives in `C:\Program Files\WindowsApps\<name>_<version>_x64__<publisher id>\`, a folder that changes
name with every version and that other apps should not run files from. `bridge_command` in `mcp_clients.rs` writes
`current_exe()` into Claude Desktop's config and the other MCP clients' configs, so the first Store update would
break every entry.

- **What the package declares:** an app execution alias, `piwi-desktop.exe`. Windows puts it in
  `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on `PATH`, and it starts the installed version whatever its
  folder.
- **What the shell does:** when packaged, `bridge_command` returns the alias's path.
- **What stays as it is:** the shell's own uses of `current_exe()` (the Ctrl+C helper in `interrupt.rs`), which
  run inside the package.

### 4. The Store handles updates

- **The updater:** the MSIX leg never applies an updater overlay, so the app reports updates as `unsupported`,
  as a keyless build does today.
- **Settings → About:** `DesktopUpdateCard.vue` says "Updates come from the Microsoft Store" instead of hiding
  the section. That takes a new `store` state, or a flag on `unsupported`.
- **Updating a running app:** Windows installs the new version beside the old one, so no file is locked. When
  it closes the running app for the update, the Node sidecar must exit with it. The spike checks that it does.

### 5. The install folder is read-only

Nothing may write under `resources\app-server` at run time: no cache of Nitro, sharp or libSQL. The installed
copies are writable for their user today, so the spike checks that the server starts and serves a run from the
read-only folder.

### 6. Paths are longer

`scripts/check-path-lengths.mjs` holds the built server to `MAX_PATH` below the per-user install folder
(`C:\Users\<20 chars>\AppData\Local\Piwi Dashboard\resources\app-server\.output\`, 88 characters). The package
folder is deeper:

- the prefix is `C:\Program Files\WindowsApps\PiwiTests.PiwiDashboard_<version>.0_x64__<13 chars>\resources\app-server\.output\`;
- that comes to about 115 characters, with room for a longer version and the name Partner Center reserves.

The check takes the deeper of the two prefixes, leaving the server about 25 characters less.

### 7. Smaller differences

- **No install wizard.** The NSIS welcome page that picks the port has no MSIX equivalent. The app starts on its
  default port and the Setup page changes it, the path a silent install already takes.
- **File associations.** `.zip` (viewer) and `.piwibug` are declared as `uap:FileTypeAssociation` in the manifest.
  The package's start entry, not the installer, registers them.
- **App user model ID.** A packaged app gets its ID from the package (`<family name>!App`). The spike checks the
  taskbar thumbnail buttons (`taskbar_win.rs`) and the native notifications under it.
- **Installed beside the `.exe` or `.msi`.** Both read the same data folder (once option A or B holds) and
  `tauri-plugin-single-instance` keeps one running, but the Start menu shows two entries. The docs say to keep
  one; switching keeps the data.
- **WebView2.** Windows 11 and supported Windows 10 builds include it. The manifest's minimum version is
  `10.0.19041.0` (Windows 10 2004), which `uap10` requires anyway.
- **Signatures inside the package.** The Store signs the package, which is what Windows checks for a packaged
  app. `node.exe` keeps its own OpenJS signature.

## Build

A fifth leg in `reusable-publish-desktop.yml`, `bundles: msix`, on `windows-latest`:

1. The shared steps as they are: fetch the Node sidecar, stage the server, `npx tauri icon`. That command already
   writes `StoreLogo.png` and the `Square*Logo.png` tiles a manifest names.
2. `npx tauri build --target x86_64-pc-windows-msvc --no-bundle`, without `--config <updater overlay>`, instead
   of `tauri-action`.
3. `node scripts/msix.mjs` copies three things into a layout folder:
   - the app executable;
   - `node.exe`, next to it as `externalBin` puts it;
   - `resources\app-server`.

   It then fills `src-tauri/windows/AppxManifest.xml`:
   - **version**: `tauri.conf.json`'s, with `.0` appended, since the Store wants a fourth part of 0;
   - **identity**: `Identity Name`, `Publisher` and `PublisherDisplayName`, from Partner Center, kept as repository
     variables, not secrets, since they are public;
   - **display name and logos**.

   Finally it runs `makeappx pack` from the Windows SDK on the runner.

4. **A smoke test** on the same runner:
   - sign a copy of the package with a throwaway self-signed certificate whose subject matches `Publisher`;
   - trust that certificate on the runner and install the package with `Add-AppxPackage`;
   - start the app through the alias and wait for `~/.piwi/desktop.json` and `/api/health`;
   - check that the database sits in the real `%APPDATA%\io.piwitests.dashboard\.data`;
   - pipe an MCP `initialize` through `piwi-desktop.exe mcp-stdio`;
   - uninstall with `Remove-AppxPackage`.
5. Upload the unsigned `.msix` as the run's artifact, on a tag as well as off one.

The manifest declares:

- the full-trust application with `--hidden` for the startup task;
- the `runFullTrust` capability, plus `unvirtualizedResources` if the spike picks option B or C;
- the two file type associations, the execution alias and the startup task.

The desktop guide (`apps/desktop/AGENTS.md`) gains one rule once it is built: **a path handed to another app goes
through `bridge_command`**, never `current_exe()`.

## Store submission

- **Once, by hand:**
  - create the individual developer account;
  - reserve the name "Piwi Dashboard";
  - copy the identity values into the repository variables;
  - fill in the listing:
    - the description: the positioning line from the root `AGENTS.md`;
    - screenshots;
    - category: Developer tools;
    - the privacy policy URL: <https://piwitests.dev/guide/privacy>, which already exists;
    - the age rating questionnaire;
    - a justification for each restricted capability.
  - upload the tag's `.msix` artifact.
- **Then on every release tag**, a job after the desktop legs submits the package with the `msstore` CLI (or
  Microsoft's `store-submission` action). It signs in with a Microsoft Entra app tied to the Partner Center
  account, and its tenant id, client id and secret live in the `release` environment. Certification takes up to
  three business days, so nothing in the release waits for it.

## Docs

- `apps/docs/features/desktop.md`: a Microsoft Store row in the **Where it is** table, signed, updated by the Store.
  It also explains how to switch from the `.exe` or `.msi`, and the Store side of **Updates**.
- `apps/docs/guide/getting-started.md`: the desktop row stops calling all the installers unsigned.
- `apps/desktop/README.md`: a section on the package (manifest, `msix.mjs`, the smoke test, submission), and the
  signing section points at it.

## Rollout

1. **Account and name** (the maintainer): the developer account, the name reservation, the identity values.
2. **Spike**: pack each variant in CI and install it on the Windows runner (`scripts/msix-check.ps1`), or register
   a layout unpacked with `Add-AppxPackage -Register` in Developer Mode. Then answer each check above: virtualization (option A, then B), the sidecar exiting on an
   update, the read-only install folder, the AUMID features. Record the answers in this Status.
3. **Shell changes**:
   - packaged detection (`GetCurrentPackageFullName`);
   - the alias in `bridge_command`;
   - the startup task;
   - the Store state in Settings → About;
   - the deeper path-length prefix.
4. **CI leg and smoke test**, building the `.msix` on every run.
5. **First submission by hand**, then the automated submission job.
6. **Docs**, in the same pull request as the first Store listing that goes live.

## Open questions

- **Which virtualization option certification accepts.** If neither A nor B passes, the Store package would ship
  with virtualization on. Its data would then be its own, and Playwright browsers installed from the app invisible
  outside it, which is likely too surprising to ship.
- **Individual or company account.** Microsoft's guidance gives the individual account to developers whose apps
  are "not in relation to their business, trade, or profession". A switch later is not possible: a company account
  is a new account, and the app's identity moves with a transfer.
- **Listing the `.exe` or `.msi` as well.** Once the Store package exists, the docs could recommend it as the
  Windows default and keep the installers for machines without the Store (some company images remove it).
