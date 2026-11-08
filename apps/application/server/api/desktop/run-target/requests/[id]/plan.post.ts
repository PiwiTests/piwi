import { runTargetRoute } from '../../../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: check a run request again (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Runs the checks of a request the window asks about again, after the person linked its folder, and answers the request with its new checks and command. 404 for a request no longer asked about.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'plan'));
