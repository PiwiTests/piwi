# Claude Desktop through an MCP bundle

A proposal to connect Claude Desktop to Piwi with an **MCP bundle** (a `.mcpb` file, which Claude Desktop installs
itself) instead of writing an entry into `claude_desktop_config.json`. Neither the desktop app nor the docs would then
need to know where Claude Desktop keeps that file, a location that has changed twice on Windows. It covers the desktop
app's one-click connect and the hosted instance's setup snippet; the other MCP clients keep their config files.

**Status.** Proposed; nothing is built. A stopgap shipped first: the desktop app's detection (`claude_desktop_dirs` in
`apps/desktop/src-tauri/src/mcp_clients.rs`) knows the three Windows folders below and passes over one holding a
`.user-data-left.*` file, and the MCP page and `apps/docs/features/mcp.md` list them. Rollout step 1, checking a
hand-built bundle on real installs, comes before any code. Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet.

**Summary.** Piwi already has a **bridge**: a process Claude Desktop starts over stdio, which forwards each JSON-RPC
message to Piwi's `/mcp` endpoint over HTTP (`piwi-desktop mcp-stdio` for the desktop app, `npx mcp-remote` for a hosted
instance). The proposal packages one bridge, written in JavaScript, as an MCP bundle. Claude Desktop runs it with the
Node it ships, asks for the settings in its own install dialog, keeps the API key in the OS keychain, and stores the
bundle in its own data folder, wherever that is. A hosted instance offers the bundle as a download with its URL filled
in; the desktop app opens it for Claude Desktop to install, and the bridge then finds the app through the discovery
file, as `mcp-stdio` does.

## The problem

Claude Desktop reads the MCP servers it starts as local commands from `claude_desktop_config.json`, and on Windows that
file has had three homes:

| Folder                                                                    | Build                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `%APPDATA%\Claude\`                                                       | the classic installer                                                                       |
| `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` | Microsoft Store (MSIX) builds: Windows redirects their writes aimed at `%APPDATA%` there    |
| `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`                        | recent builds; each folder they moved out of keeps an empty `.user-data-left.<folder>` file |

What follows from it:

- **An entry written to the wrong copy is ignored without a word.** Claude Desktop reads one copy and says nothing about
  the others. Before the stopgap, the desktop app wrote to the package folder of a build that had moved to
  `Claude-Data`, and showed the client as connected.
- **Claude Desktop's own Developer → Edit Config is not a reliable pointer.** On a Store install it opened
  `%APPDATA%\Claude\` while the app read the package copy ([anthropics/claude-code#26073][issue-edit-config], open).
- **The hosted setup needs Node on the PATH** (`npx -y mcp-remote`) and leaves the API key in plain text in the file's
  `env`.
- **Claude Desktop reads the file at startup only**, so every change needs a full restart.

Each detection fix holds until a build moves the folder again. A bundle does not depend on the folder at all.

## What exists today

| Piece             | Where                                                                      | What it does                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-click connect | `mcp_clients.rs` (`paths_of`, `set_entry`, `heal_configured_clients`)      | finds each client's config file, writes a `piwi-desktop` entry, rewrites a stale one at launch                                                                                                    |
| The stdio bridge  | `mcp_stdio.rs`, run as `piwi-desktop mcp-stdio`                            | POSTs each line read on stdin to `/mcp` with the token read from the discovery file on every message, writes the reply as one line; a published entry point (`apps/desktop/AGENTS.md`)            |
| Discovery file    | `~/.piwi/desktop.json`: `{ url, token, pid, projects }`                    | read by the reporter, `mcp_stdio.rs`, the editor service and the bundled server; the reporter's reader (`packages/reporter/src/internal/config/desktop.ts`) also drops a file whose `pid` is gone |
| Hosted snippet    | `claudeDesktopSnippet` in `app/pages/mcp.vue`, `apps/docs/features/mcp.md` | `npx -y mcp-remote <url>/mcp --transport http-only`, the key in `env.AUTH_HEADER`; `mcp-remote` also runs the OAuth sign-in                                                                       |
| Zip writing       | `fflate`, an app dependency                                                | writes the offline exports today                                                                                                                                                                  |

## MCP bundles

What the format and Claude Desktop provide, from the [MCPB specification][mcpb-manifest] and
[Anthropic's announcement][anthropic-post]. The points marked _to check_ are what rollout step 1 verifies.

- **A `.mcpb` file is a zip** holding a `manifest.json` and the server's files. Opening it (double-click, or a drop on
  Settings → Extensions) shows Claude Desktop's install dialog: name, description, the settings to fill in, Install.
- **`server.type: "node"`** runs `mcp_config.command`, `args` and `env`, with `${__dirname}` (the bundle's folder once
  installed) and `${user_config.<key>}` replaced. Claude Desktop ships its own Node, so the user installs nothing.
- **`user_config`** declares the settings the dialog asks for (`string`, `number`, `boolean`, `directory`, `file`, each
  with `required` and `default`). A `string` marked `sensitive` is masked and stored in the OS keychain.
- **`compatibility`** names the platforms (`darwin`, `win32`) and a minimum Claude Desktop version.
- **Claude Desktop keeps the bundle in its own data folder**: `Claude Extensions/<id>/`, with its settings in
  `Claude Extensions Settings/<id>.json`, as a third party observed on macOS ([himalaya-mcp][himalaya]). _To check_ on
  Windows. Either way, finding that folder is Claude Desktop's job, not Piwi's.
- **Organizations can block extensions** through Group Policy or MDM. There, the config file stays the only route.
- **The `@anthropic-ai/mcpb` command line** validates (`mcpb validate`), packs (`mcpb pack`), signs and verifies
  (`mcpb sign`, `mcpb verify`: X.509, detached signature) a bundle. How Claude Desktop presents an unsigned bundle:
  _to check_.

## Design

### One bundle, two modes

One bundle, `piwi.mcpb`, holds one script, `server/index.js`, and asks for two settings:

| Setting   | Type                        | Use                                                                                                                                                                     |
| --------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | string, optional            | the MCP URL of a hosted instance (`https://piwi.example.com/mcp`, with `?modules=core` when the page's switch is on). **Empty means the desktop app on this computer.** |
| `api_key` | string, sensitive, optional | sent as `Authorization: Bearer <key>` to `url`, and to no other address. Unused when `url` is empty: the desktop app's token comes from the discovery file.             |

The manifest, in outline:

```json
{
  "manifest_version": "0.3",
  "name": "piwi",
  "display_name": "Piwi",
  "version": "<the Piwi release>",
  "description": "Piwi's MCP server: test runs, failure clusters, flaky tests and locator fixes from your Piwi.",
  "author": { "name": "Piwi" },
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"],
      "env": { "PIWI_MCP_URL": "${user_config.url}", "PIWI_API_KEY": "${user_config.api_key}" }
    }
  },
  "user_config": {
    "url": {
      "type": "string",
      "title": "Piwi MCP URL",
      "description": "Leave empty to use the Piwi desktop app on this computer.",
      "required": false,
      "default": "<the instance's MCP URL>"
    },
    "api_key": { "type": "string", "title": "API key", "sensitive": true, "required": false }
  },
  "tools_generated": true,
  "compatibility": { "platforms": ["darwin", "win32"] }
}
```

`tools_generated` says the tools come from the server at run time: the catalog depends on the instance, its declined
capabilities and `?modules`, so the manifest lists none.

### The bridge script

It keeps the contract of `mcp_stdio.rs`, the bridge Claude Desktop already runs:

- newline-delimited JSON-RPC on stdin and stdout; each message is one `POST` to the MCP URL with
  `Accept: application/json`, and the reply is written back as one line;
- a notification gets no reply; a failure to reach Piwi is answered as a JSON-RPC error carrying the request's `id`;
- while Piwi is unreachable, a message is retried for 8 seconds, then answered with an error that says what to do
  ("start the desktop app", "check the URL");
- a 401 or 403 is not retried and says the key or the token was refused;
- **with `url` empty**, the discovery file is read on every message, as `mcp_stdio.rs` does, and a file whose `pid` is
  gone reads as no app, as the reporter's reader does. The token never leaves that file.

It uses Node's global `fetch` and nothing else, bundled into one file, so the bundle has no `node_modules`. The
discovery file gains a fifth reader: the list in `apps/desktop/AGENTS.md` names it.

### Where the code lives

A new private workspace, `packages/mcp-bundle/` (`@piwitests/mcp-bundle`), holds the script, its tests and the manifest
template. It is not published to npm: the app bundles its build. Like any workspace, it takes two entries in
`release-please-config.json`. Its license side is an open question below.

### Delivery from a hosted instance

- A route of the app answers the bundle: the manifest, stamped with the instance's MCP URL as the default of `url`, and
  the built script, zipped with `fflate`. The zip is built in `shared/`, so the demo's handler and the server share it.
- The Claude Desktop tab of the MCP page leads with a **Download for Claude Desktop** button, then one sentence: open
  the file, paste an API key in Claude Desktop's dialog (or leave it empty when authentication is off), Install. No
  folder to find, no restart before the install.
- The `mcp-remote` snippet stays below it, for two cases the bundle does not cover: signing in through OAuth instead of
  an API key, and an organization that blocks extensions. The folder list the stopgap added stays with that snippet.
- The demo shows the button disabled, as it shows the rest of the MCP page: the demo has no `/mcp` endpoint to reach.

### Delivery from the desktop app

- **Connect** on the Claude Desktop row writes the bundle (empty `url`) to the app's data folder and opens it with the
  OS (the opener plugin's `open_path`). Claude Desktop shows its install dialog, with nothing to fill in.
- **When no app opens `.mcpb` files** (Claude Desktop absent or too old to know them), Connect falls back to the config
  file, as today.
- **The row's status no longer reads Claude Desktop's files.** The bridge names itself in a request header
  (`X-Piwi-Client: mcpb/<version>`), the server keeps the time of the last request carrying it, and the row shows
  "Used by Claude Desktop 3 minutes ago" or "Installed? Not used yet". This tells the truth whatever folder Claude
  Desktop uses, and covers a bundle installed by hand.
- **The old entry goes once the bundle answers.** The first request from the bundle makes the app remove its
  `piwi-desktop` entry from the config file it detects, so Claude Desktop does not list the tools twice.
  `heal_configured_clients` keeps healing the entries of users who never switch.
- `piwi-desktop mcp-stdio` stays: config files already name it, and the guide forbids removing it.

### Security

- **The API key is stored by Claude Desktop in the OS keychain** and reaches the script through its environment, never
  through its arguments (a process listing shows arguments).
- **The key goes only to the URL it was entered with.** The script never sends it to the desktop app, and never follows
  a redirect to another host with it.
- **In desktop mode no secret is stored anywhere new**: the token is read from the discovery file each time, as the
  reporter and `mcp_stdio.rs` read it.
- **The download route serves no secret**: the bundle carries the instance's URL only, so it can be served to any
  signed-in user, behind the same access rule as the MCP page.

## Alternatives considered

- **Keep detecting the folder** (the stopgap). It works today, and the next move of the folder breaks it without an
  error, as the last one did.
- **Tell users to open Developer → Edit Config.** It opened the wrong file on Store installs
  ([#26073][issue-edit-config]).
- **A custom connector** (Settings → Connectors → Add custom connector, the `/mcp` URL). Fine for an instance reachable
  from the internet, and already in the docs; to our knowledge the connection starts from Anthropic's servers, so it
  cannot reach the desktop app on `127.0.0.1` or an instance on a private network.
- **A `binary` bundle running `piwi-desktop.exe mcp-stdio`.** The specification describes a command inside the bundle;
  a path outside it is not documented. The executable's path also differs between the per-user `.exe` and the
  per-machine `.msi` installs, and the bundle would not serve hosted instances.
- **The Rust bridge compiled into the bundle.** One binary per OS and architecture to build, sign and notarize, for a
  job Claude Desktop's own Node already does.
- **A "Choose the file…" button on the desktop row.** A cheap way out when detection guesses wrong, but it keeps the
  edit-a-file model. Worth adding whatever is decided here (open question).

## Rollout

1. **Check on real installs**, with a bundle built by hand from the outline above, on a Windows Store install, a
   Windows classic install and macOS:
   - the install dialog: the two settings, the default URL, the masked key;
   - the bridge runs on Claude Desktop's Node with no Node on the PATH, and reaches a hosted instance and the desktop
     app;
   - where the bundle is installed, and whether Claude Desktop needs a restart to start it;
   - opening a newer version of the same bundle: does it update in place, keep the settings and the key?
   - how an unsigned bundle is presented;
   - whether `fetch` in Claude Desktop's Node follows `HTTPS_PROXY`.

   The answers go into this proposal before step 2.

2. **The workspace**: the script, its tests, the manifest template, the build.
3. **Hosted delivery**: the route, the button on the MCP page, the docs (`features/mcp.md`), the demo, the screenshot
   of the `mcp-client-setup` scene.
4. **Desktop delivery**: Connect through the bundle, the fallback, the last-used status, the removal of the old entry,
   the docs (`features/desktop.md`).
5. **Move this proposal to `adr/`.**

## Tests

- The script, against a stub HTTP server (as `mcp_stdio.rs`'s tests do): a request forwarded and its reply written on
  one line; a notification answered with nothing; the desktop app absent, then started within the retry window; a 401;
  the key sent to the configured URL and never to the discovery file's; a discovery file with a dead `pid`.
- The manifest: `mcpb validate` on the built bundle, in the workspace's tests.
- The route: the downloaded zip holds the manifest with this instance's URL as the default, and the script.
- What only Claude Desktop can show (the dialog, the keychain, updates) stays a manual check, as
  [`real-editor-checks.md`](real-editor-checks.md) records for the editors.

## Open questions

- **License side.** MIT, like the reporter that runs on users' machines, or FSL-1.1-MIT, like the desktop app and the
  editor service? FSL would let the script reuse the editor's proxy handling (`packages/editor/src/http.ts`); MIT code
  cannot take FSL code.
- **Proxies.** If Claude Desktop's Node ignores `HTTPS_PROXY`, the script needs undici's `EnvHttpProxyAgent`, as the
  editor service has, which adds a dependency to the bundle.
- **Signing.** Which certificate signs the bundle, and whether an unsigned one is acceptable for a self-hosted tool.
- **OAuth.** The first version takes an API key. Signing in through the instance's OAuth from the script would replace
  `mcp-remote` entirely, at the cost of a browser flow and a token store in the script.
- **The variable names.** `PIWI_API_KEY` means the same as the reporter's; `PIWI_MCP_URL` is new, and differs from the
  reporter's `PIWI_DASHBOARD_URL` because it carries the `/mcp` path and `?modules`.
- **The "Choose the file…" button** on the desktop row: ship it now, as a way out of a wrong guess, or only if the
  bundle is not adopted.

[anthropic-post]: https://www.anthropic.com/engineering/desktop-extensions
[himalaya]: https://data-wise.github.io/himalaya-mcp/reference/desktop-extensions
[issue-edit-config]: https://github.com/anthropics/claude-code/issues/26073
[mcpb-manifest]: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
