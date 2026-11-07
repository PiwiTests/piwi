import { getDatabase } from '../../database';
import { startDeviceConnect, CONNECT_RATE_LIMITS, type ConnectClient } from '../../utils/extension-connect';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';
import { publicBaseUrl } from '../../utils/public-base-url';

defineRouteMeta({
  openAPI: {
    tags: ['Extension'],
    summary: 'Start connecting the browser extension, an editor or a run target',
    description:
      'Starts an RFC 8628 device authorization for Piwi Picker, the VS Code extension, the JetBrains plugin or a run target (the desktop app, Piwi Runner). Answers a device code for the client to poll `/api/extension/connect/token` with, and a user code with the page where a signed-in user allows or denies the connection. The request expires after 10 minutes. Body: `{ browser?, os? }` from Piwi Picker, `{ editor, os? }` from an editor, or `{ target: "desktop" | "runner", device, os? }` from a run target, which name the connecting client. The key of a run target holds `run:receive` alone: it receives its owner’s run requests and nothing else. Rate-limited per client address.',
    security: [],
    responses: {
      200: {
        description: 'The started request',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                deviceCode: { type: 'string' },
                userCode: { type: 'string', example: 'BCDF-GHJK' },
                verificationUrl: { type: 'string' },
                interval: { type: 'integer', description: 'Seconds between polls' },
                expiresIn: { type: 'integer', description: 'Seconds until the request expires' },
              },
            },
          },
        },
      },
      429: { description: 'Too many requests from this address' },
    },
  },
});

export default eventHandler(async (event) => {
  const rateKey = `extension-connect:start:${rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, CONNECT_RATE_LIMITS.start.limit, CONNECT_RATE_LIMITS.start.windowMs)) {
    throw rateLimitedError(event, [rateKey]);
  }
  const body = ((await readBody(event).catch(() => null)) ?? {}) as ConnectClient;
  const started = await startDeviceConnect(await getDatabase(), {
    browser: body.browser,
    editor: body.editor,
    target: body.target,
    device: body.device,
    os: body.os,
  });
  const base = publicBaseUrl(event);
  return {
    ...started,
    verificationUrl: `${base}/extension/connect?code=${encodeURIComponent(started.userCode)}`,
  };
});
