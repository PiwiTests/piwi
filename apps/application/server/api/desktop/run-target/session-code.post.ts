import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: a code for the window’s session (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends, which a webview’s `POST` always is (it carries `Origin`). Answers `{ code }`, a code that `GET /__piwi/session?code=…` takes once, within 30 seconds, for the window’s session cookie, so the access token is never in a URL.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'sessionCode'));
