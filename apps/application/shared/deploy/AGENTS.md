# Deployment snippets and manifests: agent guide

Rules for the configuration emitters (`shared/env-format*.ts`, `shared/deploy/`) and the one-click deploy manifests they
write. Read [`../../AGENTS.md`](../../AGENTS.md) first.

## Emitting configuration

The emitters turn resolved values into deployment snippets: pure `(entries, opts) => string` functions.

- `shared/env-format-base.ts`: the shapes (`EnvEntry`, `EmitOptions`), the quoting rules of each syntax, and the
  constants a deployment must agree on (`DATA_MOUNT`, `HEALTH_PATH`, the default image). No emitter of its own.
- `shared/env-format.ts`: the generic formats (dotenv, shells, Compose, `docker run`, Kubernetes, systemd), the
  `ENV_OUTPUT_FORMATS` registry, and the re-exports of the two other layers. Import the emitters from here.
- `shared/deploy/<provider>.ts`: one module per hosting platform (railway, render, fly, koyeb, coolify), holding that
  platform's quirks and nothing else.

Rules:

- **Adding a provider** is a new `shared/deploy/*.ts`, an entry in `ENV_OUTPUT_FORMATS`, a re-export from
  `env-format.ts`, and, when it ships a committed manifest, a line in `scripts/generate-deploy-manifests.mjs`. Keep
  each one a stateless function picked from the data registry, not a class: there is no state per provider to hold.
- **The emitters stay dependency-free and browser-safe** (no third-party import, no Node API): the docs site's
  configuration wizard (`apps/docs/.vitepress/theme/components/EnvWizard.vue`) imports `#shared/env-format`, and
  `scripts/generate-deploy-manifests.mjs` runs them under plain Node. `tests/unit/env-format.test.ts` checks their
  output.
- **They import each other with `#shared/...` specifiers, never relative paths**: the `imports` map of `package.json`
  is what lets the same files load unchanged in Vite, Vitest and plain Node.
- **The manifests are generated and committed** (`render.yaml`, `fly.toml`, `railway.json`, `deploy/**` at the
  repository root): Render and Fly read them from the repository. Edit `scripts/generate-deploy-manifests.mjs` or the
  emitters, then run `npm run app:generate:deploy`; `tests/unit/deploy-manifests.test.ts` fails when the committed
  files drift.
