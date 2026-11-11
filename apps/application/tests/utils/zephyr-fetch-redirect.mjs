/**
 * Preloaded into a spawned test server (`node --import`): every `fetch` to a Zephyr Scale regional host goes to the
 * mock named by `PIWI_E2E_ZEPHYR_MOCK` instead. The server never takes a Zephyr host from a setting, so this is the
 * only seam; the client code under test runs unchanged, and nothing reaches the real service.
 */
const mock = process.env.PIWI_E2E_ZEPHYR_MOCK;
const HOST = /^https:\/\/(?:[a-z]{2}\.)?api\.zephyrscale\.smartbear\.com\/v2(?=[/?]|$)/;

if (mock && !globalThis.__piwiZephyrRedirect) {
  globalThis.__piwiZephyrRedirect = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (typeof url === 'string' && HOST.test(url)) {
      return realFetch(url.replace(HOST, `${mock}/v2`), init);
    }
    return realFetch(input, init);
  };
}
