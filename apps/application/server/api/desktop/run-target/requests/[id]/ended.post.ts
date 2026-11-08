import { runTargetRoute } from '../../../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: a requested run ended (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ code, stopped }`, the exit code of the run’s Playwright process (null when it was killed) and whether a stop was asked for it. The server reports the run ended to the instance: `stopped` after a stop from the dashboard or the window, `passed` for 0, `failed` for 1, otherwise `error`.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'ended'));
