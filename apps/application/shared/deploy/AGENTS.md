# Deployment snippets and manifests: agent guide

Rules for the configuration emitters (`shared/env-format*.ts`, `shared/deploy/`) and the one-click deploy manifests they
write. Read [`../../AGENTS.md`](../../AGENTS.md) first.

## Emitting configuration

Resolved values are rendered into deployment snippets by a family of pure `(entries, opts) => string` emitters:

- `shared/env-format-base.ts` — the shapes (`EnvEntry`, `EmitOptions`), the per-syntax quoting rules and the constants a
  deployment must agree on (`DATA_MOUNT`, `HEALTH_PATH`, default image). No emitter of its own.
- `shared/env-format.ts` — the generic formats (dotenv, shells, compose, `docker run`, Kubernetes, systemd) plus the
  `ENV_OUTPUT_FORMATS` registry, and the **only** module anything outside `shared/` should import.
- `shared/deploy/<provider>.ts` — one module per hosting platform (railway, render, fly, koyeb, coolify), each owning
  that provider's quirks and nothing else.

Adding a provider is: a new `shared/deploy/*.ts`, an entry in `ENV_OUTPUT_FORMATS`, a re-export from `env-format.ts`,
and — if it should ship a committed manifest — a line in `scripts/generate-deploy-manifests.mjs`. These are stateless
functions selected through a data registry, deliberately not classes: there is no per-provider state to hold, and the
registry already provides the polymorphism a factory would.

Modules under `shared/` import each other with `#shared/...` specifiers, never relative paths — that is what lets the
same files load unchanged in Vite, Vitest and plain Node (the generator script relies on the `imports` map in
`package.json`).

The manifests (`render.yaml`, `fly.toml`, `railway.json`, `deploy/**` at the repository root) are **generated and
committed**: Render and Fly read them from the repository. Edit `scripts/generate-deploy-manifests.mjs` or the
emitters here, then run `npm run app:generate:deploy`; a unit test fails if the committed files drift.
