import { describe, test, expect } from 'vitest';
import { fetchOpenApiManifest } from '../../server/utils/openapi-surface';

/**
 * The OpenAPI URL is admin-supplied, so the fetch goes through the SSRF guard
 * (`safeFetch` / `assertPublicHttpUrl`). A private, loopback, link-local or
 * non-http(s) target is refused before any request is made, and the best-effort
 * contract turns that refusal into a null rather than a throw.
 */
describe('fetchOpenApiManifest SSRF guard', () => {
  test('refuses a loopback / private / metadata host', async () => {
    expect(await fetchOpenApiManifest('http://localhost:3000/openapi.json')).toBeNull();
    expect(await fetchOpenApiManifest('http://127.0.0.1/openapi.json')).toBeNull();
    expect(await fetchOpenApiManifest('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await fetchOpenApiManifest('http://10.0.0.5/openapi.json')).toBeNull();
  });

  test('refuses a non-http(s) scheme', async () => {
    expect(await fetchOpenApiManifest('file:///etc/passwd')).toBeNull();
    expect(await fetchOpenApiManifest('ftp://example.com/spec.json')).toBeNull();
  });
});
