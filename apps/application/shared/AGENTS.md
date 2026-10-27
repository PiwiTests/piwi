# Shared modules: agent guide

`shared/` holds the types, constants and pure helpers the app, the server and the demo share. Import it as
`#shared/...` (the rules of [`../AGENTS.md`](../AGENTS.md)). Each file belongs to a subsystem, and so do its rules:
before changing one of these files, read the guide its row names.

| Editing…                                                                                 | Rules in                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `types.ts` (the wire contract the reporter sends)                                        | [`../server/api/test-runs/AGENTS.md`](../server/api/test-runs/AGENTS.md#adding-a-field-to-test-run-data)           |
| `handlers/` (the queries the server and the demo share)                                  | [`../server/database/AGENTS.md`](../server/database/AGENTS.md), then the guide of the subsystem the handler serves |
| `mcp-tools.ts`                                                                           | [`../server/utils/mcp/AGENTS.md`](../server/utils/mcp/AGENTS.md)                                                   |
| `assistant*.ts`, `handlers/assistant*.ts`                                                | [`../server/utils/assistant/AGENTS.md`](../server/utils/assistant/AGENTS.md)                                       |
| `error-fingerprint.ts`, `scm-urls.ts`, `locator-healing.ts`, `snapshot-picker-extras.ts` | [`../server/utils/AGENTS.md`](../server/utils/AGENTS.md)                                                           |
| `permissions.ts`                                                                         | [`../server/api/AGENTS.md`](../server/api/AGENTS.md#authentication--authorization)                                 |
| `piwi-env-vars.ts`                                                                       | [`../AGENTS.md`](../AGENTS.md#rules-for-every-change)                                                              |
| `help-content.ts`, `settings-metadata.ts`                                                | [`../app/AGENTS.md`](../app/AGENTS.md)                                                                             |
| `env-format*.ts`, `deploy/`                                                              | [`deploy/AGENTS.md`](deploy/AGENTS.md)                                                                             |
| `guide-anchors/`                                                                         | [`guide-anchors/AGENTS.md`](guide-anchors/AGENTS.md)                                                               |
| `demo/`                                                                                  | [`../app/demo/AGENTS.md`](../app/demo/AGENTS.md)                                                                   |
