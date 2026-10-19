import { test, expect } from '@playwright/test';

test.describe('request guards', () => {
  test('a state-changing request a browser sends from another site is refused', async ({ request }) => {
    const res = await request.post('/api/settings/ai/models', {
      headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      data: JSON.stringify({ provider: 'anthropic', baseUrl: 'https://evil.example' }),
    });
    expect(res.status()).toBe(403);
  });

  test('the same request from the dashboard itself is not refused by the guard', async ({ request }) => {
    const res = await request.post('/api/settings/ai/models', {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
      data: { provider: 'claude-cli' },
    });
    expect(res.status()).toBe(200);
  });

  test('API responses carry no wildcard CORS header', async ({ request }) => {
    const res = await request.get('/api/projects', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('a link URL must be http(s)', async ({ request }) => {
    const res = await request.post('/api/links', {
      data: { entityType: 'test_case', entityId: 1, url: 'javascript:alert(document.domain)' },
    });
    expect(res.status()).toBe(400);
  });

  test('no other site may frame a dashboard page or an API response', async ({ request }) => {
    for (const path of ['/', '/api/health']) {
      const headers = (await request.get(path)).headers();
      expect(headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(headers['content-security-policy']).toBe("frame-ancestors 'self'");
    }
  });

  test('a stored-file path that names no project is refused', async ({ request }) => {
    const res = await request.get('/api/files/somewhere-else/secret.txt');
    expect(res.status()).toBe(404);
  });
});
