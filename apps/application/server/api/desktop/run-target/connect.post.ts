import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: connect to a team instance (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body `{ instance }`, an http or https URL. Starts the device flow on that instance for a run target (`POST /api/extension/connect` with `target: "desktop"`), disconnecting any instance connected before, and answers the connection with the code the instance’s page shows and the page to open, where the person allows the app. Once allowed, the app connects, and the shell keeps its key in the OS keychain. 400 for a value that is not such a URL.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'connect'));
