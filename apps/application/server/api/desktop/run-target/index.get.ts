import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the connection to a team instance (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Answers `{ connection, requests }`: where the connection to the team instance this app takes run requests from stands (`none`, `signing-in` with the code and the page to allow the app on, `connecting`, `online`, `offline`, `revoked`), and the requests the window still asks the person about, with their checks and command. Never the key nor a request token.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'status'));
