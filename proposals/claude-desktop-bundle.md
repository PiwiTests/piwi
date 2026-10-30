# Claude Desktop through an MCP bundle

A proposal to connect Claude Desktop to Piwi with **MCP bundles** (`.mcpb` files, which Claude Desktop installs itself)
instead of writing an entry into `claude_desktop_config.json`. Neither the desktop app nor the docs would then need to
know where Claude Desktop keeps that file, a location that has changed twice on Windows. It covers the desktop app's
one-click connect and the hosted instance's setup snippet; the other MCP clients keep their config files.

**Status.** Proposed; no Piwi code is built for it. A stopgap shipped first: the desktop app's detection
(`claude_desktop_dirs` and `pick_config_dir` in `apps/desktop/src-tauri/src/mcp_clients.rs`) knows the three Windows
folders below and follows the `.user-data-left.<name>` file Claude Desktop leaves when it moves its data, and the MCP
page and `apps/docs/features/mcp.md` list the folders. Rollout step 1 is under way with a test kit kept outside the
repository: one bundle in two versions, with a `piwi_bundle_diagnostics` tool, whose manifest `mcpb validate` accepts
and whose bridge answers the kit's own checks (a hosted instance, the desktop app found or absent, an unreachable URL, a
redirect, a refused key) on Node 20 and 22. The checks on real Claude Desktop installs are pending. Nothing here is on
[`ROADMAP.md`](../ROADMAP.md) yet.

**Summary.** Piwi already has a **bridge**: a process Claude Desktop starts over stdio, which forwards each JSON-RPC
message to Piwi's `/mcp` endpoint over HTTP (`piwi-desktop mcp-stdio` for the desktop app, `npx mcp-remote` for a hosted
instance). The proposal packages one bridge, written in JavaScript, as two fixed bundles: `piwi-desktop.mcpb`, which
finds the desktop app through its discovery file, and `piwi.mcpb`, which asks for a hosted instance's URL and API key.
Claude Desktop runs them with the Node it ships, asks for the settings in its own install dialog, keeps the API key in
the OS keychain, and stores the bundle in its own data folder, wherever that is. Both files are the same for every user,
so each can be signed once.

## The problem

Claude Desktop reads the MCP servers it starts as local commands from `claude_desktop_config.json`, and on Windows that
file has had three homes:

| Folder                                                                    | Build                                                                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `%APPDATA%\Claude\`                                                       | the classic installer                                                                                                  |
| `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` | MSIX installs (Microsoft Store, WinGet, the MSIX installer): Windows redirects their writes aimed at `%APPDATA%` there |
| `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`                        | recent builds; each folder they moved out of keeps an empty `.user-data-left.<folder>` file                            |

The mapping is approximate: reports on [anthropics/claude-code#26073][issue-edit-config] include an MSIX build that kept
using `%APPDATA%\Claude\` because the folder existed before the install, and a third-party (3P) mode that uses
`%LOCALAPPDATA%\Claude-3p`. What follows from it:

- **An entry written to the wrong copy is ignored without a word.** Claude Desktop reads one copy and says nothing about
  the others. Before the stopgap, the desktop app wrote to the package folder of a build that had moved to
  `Claude-Data`, and showed the client as connected.
- **Claude Desktop's own Developer → Edit Config is not a reliable pointer.** On an MSIX install it opened
  `%APPDATA%\Claude\` while the app read the package copy ([#26073][issue-edit-config], open).
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

`mcp_stdio.rs` handles one message at a time, waits up to 180 seconds for a reply, and retries a message for 8 seconds
whatever failed, including a connection that broke after the request was sent, which can run a write tool twice.

## MCP bundles

What the format and Claude Desktop provide, from the [MCPB specification][mcpb-manifest], the
[MCPB command line][mcpb-cli] and [Anthropic's announcement][anthropic-post]. The points marked _to check_ are what
rollout step 1 verifies.

- **A `.mcpb` file is a zip** holding a `manifest.json` and the server's files. Opening it (double-click, or a drop on
  Settings → Extensions) shows Claude Desktop's install dialog: name, description, the settings to fill in, Install. A
  third party reports that Claude Desktop starts extensions at its own startup ([himalaya-mcp][himalaya]), so an install
  may need a restart: _to check_.
- **`server.type: "node"`** runs `mcp_config.command`, `args` and `env`, with `${__dirname}` (the bundle's folder once
  installed) and `${user_config.<key>}` replaced. Claude Desktop ships its own Node for the Chat tab; a user report says
  the Code and Cowork tabs start `node` from the PATH instead, and fail without one
  ([anthropics/claude-code#35175][issue-node]): _to check_ per tab.
- **An optional setting left blank reaches the script as its literal `${user_config.<key>}` placeholder**: the MCPB
  reference code (`getMcpConfigForManifest`) only defines settings that have a default or a stored value, and leaves an
  undefined placeholder as it is.
- **`user_config`** declares the settings the dialog asks for (`string`, `number`, `boolean`, `directory`, `file`, each
  with `required` and `default`); every manifest version requires a `title` and a `description` on each. A `string`
  marked `sensitive` is masked and stored in the OS keychain.
- **`compatibility`** names the platforms (`darwin`, `win32`) and a minimum Claude Desktop version.
- **`manifest_version`**: the specification calls 0.3 current, while the command line (2.1.2) marks its 0.3 schema as a
  work in progress and defaults to 0.2. Which versions Claude Desktop accepts: _to check_.
- **Claude Desktop keeps the bundle in its own data folder**: `Claude Extensions/<id>/`, with its settings in
  `Claude Extensions Settings/<id>.json`, as a third party observed on macOS ([himalaya-mcp][himalaya]). _To check_ on
  Windows. Either way, finding that folder is Claude Desktop's job, not Piwi's.
- **A bundle installed from a file does not update itself**: only extensions from Anthropic's directory do. A user
  reinstalls a newer file by hand, so every version of the bridge stays in use somewhere.
- **Organizations can turn extensions off** (`isDesktopExtensionEnabled`), and turn local MCP servers off altogether
  (`isLocalDevMcpEnabled`), which closes the config-file route too. Team and Enterprise owners can also keep an
  allowlist of extensions, which takes an admin upload of each version ([enterprise configuration][enterprise]).
- **The `@anthropic-ai/mcpb` command line** validates a `manifest.json` (`mcpb validate`, not the packed file), packs
  (`mcpb pack`), signs and verifies (`mcpb sign`, `mcpb verify`: X.509, detached signature) a bundle. The signature
  covers every byte of the zip. Its verification, which the MCPB README says Claude Desktop uses, accepts a signature
  only when the certificate chains to the OS trust store: a self-signed bundle (`mcpb sign --self-signed`) reads as
  unsigned. How Claude Desktop presents an unsigned bundle: _to check_.

## Design

### Two fixed bundles

Claude Desktop identifies an installed extension by its manifest, so one name per mode keeps the two apart, as the
`piwi-desktop` and `piwi` config entries are today. Neither bundle carries anything specific to one user or one
instance, so each is one file per release, signed once.

| Bundle              | `name`         | Settings                                                                      | Reaches                                                          |
| ------------------- | -------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `piwi-desktop.mcpb` | `piwi-desktop` | none                                                                          | the desktop app on this computer, through `~/.piwi/desktop.json` |
| `piwi.mcpb`         | `piwi`         | `url` (string, required, no default), `api_key` (string, sensitive, optional) | the hosted instance at `url`                                     |

Installing `piwi.mcpb` a second time, for another instance, replaces the first one's settings. One Claude Desktop thus
reaches one hosted instance through the bundle; a second instance uses the `mcp-remote` entry or a custom connector.

The hosted bundle's manifest, in outline:

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
      "description": "Your instance's MCP URL, as its MCP server page shows it (https://piwi.example.com/mcp).",
      "required": true
    },
    "api_key": {
      "type": "string",
      "title": "API key",
      "description": "Only for an instance that asks for one (pd_…).",
      "sensitive": true,
      "required": false
    }
  },
  "tools_generated": true,
  "prompts_generated": true,
  "compatibility": { "platforms": ["darwin", "win32"] }
}
```

`tools_generated` and `prompts_generated` say the tools and the prompts come from the server at run time: the catalog
depends on the instance, its declined capabilities and `?modules`, and `/mcp` serves prompts (`MCP_PROMPT_DEFS`), so the
manifest lists none. `compatibility.claude_desktop` gets the lowest version step 1 finds working.

### The bridge script

One script serves both bundles; it reads the discovery file when `PIWI_MCP_URL` is unset or still its placeholder.

- Newline-delimited JSON-RPC on stdin and stdout; each message is one `POST` to the MCP URL with
  `Accept: application/json`, and the reply is written back as one line.
- **Messages are handled concurrently** and each reply is written when it arrives: JSON-RPC matches replies to requests by
  `id`, so a slow tool call does not hold the others, and a cancellation reaches the server at once.
- A notification gets no reply; a failure is answered as a JSON-RPC error carrying the request's `id`.
- **A message is retried for 8 seconds only while nothing has reached the server**: the discovery file is missing, or
  the connection is refused. A connection that breaks after the request was sent is reported, never replayed.
- A 401 or 403 is not retried and says the key or the token was refused. A redirect is not followed and names the
  address it points to.
- **In desktop mode**, the discovery file is read on every message, as `mcp_stdio.rs` does, and a file whose `pid` is
  gone reads as no app, as the reporter's reader does. The token never leaves that file.
- Every request carries `X-Piwi-Client: piwi-mcpb/<version>`.

It uses Node's global `fetch` and nothing else, bundled into one file, so the bundles have no `node_modules`. The
discovery file gains a fifth reader: the list in `apps/desktop/AGENTS.md` names it.

### Where the code lives

A new private workspace, `packages/mcp-bundle/` (`@piwitests/mcp-bundle`), holds the script, its tests, the two
manifests and the build that packs them. It is not published to npm. Like any workspace, it is listed in the root
`package.json` `workspaces` and takes two entries in `release-please-config.json`, and `knip.ts` names its entry point
if knip cannot infer it. Its license side is an open question below; MIT would also add it to the MIT list of the root
`AGENTS.md`, with its own `LICENSE` file.

### Delivery from a hosted instance

- The app ships the release's `piwi.mcpb` as a static file, so an instance without internet access serves it too, and
  the release on GitHub carries the same file.
- The Claude Desktop tab of the MCP page leads with a **Download for Claude Desktop** button and the MCP URL to paste,
  with its copy button: open the file, paste the URL and an API key (none when authentication is off), Install.
- The `mcp-remote` snippet stays below it, for what the bundle does not cover: signing in through OAuth instead of an API
  key, a second hosted instance, and an organization that turns extensions off. The folder list the stopgap added stays
  with that snippet.
- The demo shows the button disabled, as it shows the rest of the MCP page: the demo has no `/mcp` endpoint to reach.

### Delivery from the desktop app

- **The Claude Desktop row offers two actions**: **Install in Claude Desktop**, which opens `piwi-desktop.mcpb` with the
  OS (the opener plugin's `open_path`), and **Write the config file instead**, today's Connect. `open_path` cannot tell
  whether an app took the file (macOS's `open` is spawned detached, and Windows asks the user to pick an app for an
  unknown extension), so the second action is always there rather than an automatic fallback.
- **The row's status reads the requests, not Claude Desktop's files.** The server keeps the time of the last request
  carrying `X-Piwi-Client`, and the row shows "Used 3 minutes ago" or "Not used yet". `mcp_stdio.rs` sends
  `X-Piwi-Client: piwi-desktop-bridge/<version>`, so a config-file entry shows its use the same way.
- **The config entry goes once the bundle is used.** When the status first shows a `piwi-mcpb` request, the window calls
  the shell's existing disconnect command for Claude Desktop, so the tools are not listed twice, and says to restart
  Claude Desktop, which reads its config at startup. When detection points at the wrong copy, the entry Claude Desktop
  reads stays and the tools show twice until the user removes it; the row says which file it edited.
- `piwi-desktop mcp-stdio` stays: config files already name it, and the guide forbids removing it.

### Security

- **The API key is stored by Claude Desktop in the OS keychain** and reaches the script through its environment, never
  through its arguments (a process listing shows arguments).
- **The key goes only to the configured URL**: never to the desktop app, never through a redirect. Claude Desktop
  stores it with the URL; changing the URL in the extension's settings sends the stored key to the new one, which the
  settings dialog shows side by side.
- **In desktop mode no secret is stored anywhere new**: the token is read from the discovery file each time, as the
  reporter and `mcp_stdio.rs` read it.
- **The bundles carry no secret and no address**, so they can be served to anyone, attached to releases and uploaded to
  an organization's allowlist once per version.

## Alternatives considered

- **Keep detecting the folder** (the stopgap). It works today, and the next move of the folder breaks it without an
  error, as the last one did.
- **Tell users to open Developer → Edit Config.** It opened the wrong file on MSIX installs
  ([#26073][issue-edit-config]).
- **A custom connector** (Settings → Connectors → Add custom connector, the `/mcp` URL). Fine for an instance reachable
  from the internet, and already in the docs; to our knowledge the connection starts from Anthropic's servers, so it
  cannot reach the desktop app on `127.0.0.1` or an instance on a private network.
- **One bundle stamped with each instance's URL.** Every instance would serve different bytes, which no Piwi signature
  can cover, and every copy would carry the same extension name: installing a second instance's bundle, or the desktop
  one, would replace the first, and an update could keep one instance's key for another's default URL.
- **A `binary` bundle running `piwi-desktop.exe mcp-stdio`.** The specification describes a command inside the bundle;
  a path outside it is not documented. The executable's path also differs between the per-user `.exe` and the
  per-machine `.msi` installs, and the bundle would not serve hosted instances.
- **The Rust bridge compiled into the bundle.** One binary per OS and architecture to build, sign and notarize, for a
  job Claude Desktop's own Node already does.
- **A "Choose the file…" button on the desktop row.** A cheap way out when detection guesses wrong, but it keeps the
  edit-a-file model. Worth adding whatever is decided here (open question).

## Rollout

1. **Check on real installs**, with bundles built by hand from the outline above, on a Windows MSIX install, a Windows
   classic install, a build that keeps its data in `Claude-Data`, and macOS:
   - the install dialog: the settings, the masked key, an unsigned bundle's warning;
   - whether Claude Desktop needs a restart to start a new extension;
   - the tools in the Chat tab, then in the Code and Cowork tabs, on a machine with no Node on the PATH;
   - which `manifest_version` the build accepts, and the lowest Claude Desktop version that runs the bundles;
   - opening a newer version of the same bundle: does it update in place, keep the settings and the key?
   - whether `fetch` in Claude Desktop's Node follows `HTTPS_PROXY`, and trusts a private certificate authority the OS
     trusts;
   - whether the prompts show;
   - after uninstalling an MSIX build and installing the classic one: which folder the classic build reads, and whether
     `Claude-Data` stays.

   The answers go into this proposal before step 2.

2. **The workspace**: the script, its tests, the two manifests, the build, and an entry in
   [`1.0-stabilization.md`](1.0-stabilization.md) for what installed bundles keep using: the names `piwi` and
   `piwi-desktop`, the settings keys `url` and `api_key`, the variables `PIWI_MCP_URL` and `PIWI_API_KEY`, and the
   `X-Piwi-Client` header.
3. **Hosted delivery**: the static file, the release asset, the button on the MCP page, the docs (`features/mcp.md`),
   the demo, the screenshot of the `mcp-client-setup` scene.
4. **Desktop delivery**: the two actions, the status from `X-Piwi-Client` (with the header added to `mcp_stdio.rs`), the
   removal of the config entry, the docs (`features/desktop.md`), and the move of this proposal to `adr/`.

## Tests

- The script, against a stub HTTP server (as `mcp_stdio.rs`'s tests do): a request forwarded and its reply written on
  one line; two requests answered out of order; a notification answered with nothing; the desktop app absent, then
  started within the retry window; a connection that breaks after the request was sent, reported and not replayed; a
  401; a redirect; the key sent to the configured URL and never to the discovery file's; a discovery file with a dead
  `pid`.
- The manifests: `mcpb validate` on each `manifest.json` before packing, in the workspace's tests.
- What only Claude Desktop can show (the dialog, the keychain, updates, the tabs) stays a manual check, as
  [`real-editor-checks.md`](real-editor-checks.md) records for the editors.

## Open questions

- **License side.** MIT, like the reporter that runs on users' machines, or FSL-1.1-MIT, like the desktop app and the
  editor service? FSL would let the script reuse the editor's proxy handling (`packages/editor/src/http.ts`); MIT code
  cannot take FSL code.
- **Proxies and certificate authorities.** If Claude Desktop's Node ignores `HTTPS_PROXY`, the script needs undici's
  `EnvHttpProxyAgent`, as the editor service has, which adds a dependency to the bundle. An instance behind a private
  certificate authority needs Node to trust it: `--use-system-ca` in `args` if Claude Desktop's Node knows the flag, or a
  `file` setting passed as `NODE_EXTRA_CA_CERTS`, whose placeholder Node would then try to load while it is blank.
- **Signing.** A signature counts only with a code-signing certificate from a public certificate authority. With two
  fixed bundles one certificate covers every user; buy one, or ship them unsigned, depending on what Claude Desktop
  shows for an unsigned bundle.
- **Plain `http://`.** Should the script refuse to send a key to a host other than this machine over plain `http://`?
  `mcp-remote` sends it; an instance on a private network often has no certificate.
- **OAuth.** The first version takes an API key. Signing in through the instance's OAuth from the script would replace
  `mcp-remote` entirely, at the cost of a browser flow and a token store in the script.
- **`privacy_policies`.** The specification asks for it when an extension connects to a service that processes user
  data. The hosted bundle connects only to the user's own instance; whether Claude Desktop asks for it anyway is a step 1
  question.
- **The variable names.** `PIWI_API_KEY` means the same as the reporter's; `PIWI_MCP_URL` is new, and differs from the
  reporter's `PIWI_DASHBOARD_URL` because it carries the `/mcp` path and `?modules`.
- **The "Choose the file…" button** on the desktop row: ship it now, as a way out of a wrong guess, or only if the
  bundles are not adopted.

[anthropic-post]: https://www.anthropic.com/engineering/desktop-extensions
[enterprise]: https://support.claude.com/en/articles/12622667-enterprise-configuration
[himalaya]: https://data-wise.github.io/himalaya-mcp/reference/desktop-extensions
[issue-edit-config]: https://github.com/anthropics/claude-code/issues/26073
[issue-node]: https://github.com/anthropics/claude-code/issues/35175
[mcpb-cli]: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
[mcpb-manifest]: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
