# Security policy

Piwi Dashboard is a self-hosted application that can store sensitive material on your behalf — AI provider API keys, SCM access tokens, webhook secrets, user credentials, and the contents of your test artifacts. We take reports about anything that could expose that data seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/PiwiTests/piwi/security/advisories/new) ("Report a vulnerability" on the repository's Security tab). You'll get an acknowledgment as soon as the report is seen — normally within a few days — and we'll keep you informed as the fix progresses.

Please include, where possible:

- The version you tested (`0.x.y`, or the `/api/version` output) and how it was deployed (Docker, source).
- Reproduction steps or a proof of concept.
- The impact you believe it has (what an attacker gains).

If you can't use GitHub's private reporting, open a regular issue that says only "security report — please reach out" without details, and a maintainer will contact you.

## Scope

Reports we especially care about:

- Authentication or authorization bypass (roles, project-level permissions, API keys, stream tokens).
- Exposure of stored secrets (AI keys, SCM tokens, webhook secrets) or of other projects' data.
- Injection of any kind (SQL, XSS through stored test results/error messages/attachments, SSRF via configured URLs).
- Path traversal in file storage or the `/api/files/*` routes.

Out of scope: reports that require an already-compromised host, denial of service by an authenticated reporter flooding its own instance, and issues in third-party dependencies without a demonstrated impact here (though heads-ups are welcome).

## Supported versions

Piwi Dashboard is pre-1.0: fixes land on `main` and ship in the next release. Only the **latest release** is supported — please reproduce on the current version before reporting.

## Hardening your deployment

The [production checklist](https://piwitests.dev/operate/production-checklist) lists everything to set before you expose an instance: authentication, the encryption key, HTTPS, the trust-proxy flag, backups and a pinned version. Keep the container up to date.
