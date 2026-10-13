/**
 * `@piwitests/core` — pure, dependency-free cross-cutting logic shared by the
 * Piwi Dashboard app and the Playwright reporter.
 *
 * The package ships TypeScript source; each consumer transpiles it (the app via
 * Vite, the reporter by bundling it into `dist/` at build time). It must stay
 * browser/worker/server-safe: no `node:*` imports, no third-party dependencies,
 * no imports from `apps/application/` or `packages/reporter/`. Enforced by `tests/boundary.test.ts`.
 */
export * from './locator-healing-types';
export * from './locator-generation';
export * from './locator-fingerprint';
export * from './codeowners';
export * from './error-text';
export * from './error-parse';
export * from './describe-failure';
export * from './gate';
export * from './locator-methods';
export * from './status-classify';
export * from './mask';
export * from './step-analysis';
export * from './step-tree';
export * from './test-meta';
export * from './wire';
export * from './recording';
export * from './function-match';
export * from './codegen';
export * from './locator-chain';
export * from './step-locators';
export * from './locator-index';
export * from './locator-text-match';
export * from './diff-anchors';
export * from './locator-break';
export * from './locator-edit';
export * from './dotenv';
export * from './source-map';
export * from './code-reach';
export * from './coverage';
export * from './line-diff';
export * from './editor-send';
export * from './file-routes';
export * from './error-signature';
export * from './flake-plan';
export * from './flake-verdict';
