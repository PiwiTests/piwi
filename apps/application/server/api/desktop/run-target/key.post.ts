import { runTargetRoute } from '../../../utils/run-target-route';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the key to keep (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends, which a webview’s `POST` always is (it carries `Origin`). Answers `{ instance, key }`, the key the device flow just gave, for the shell to keep in the OS keychain; 404 once it is kept, or with none. The window never reads it.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler((event) => runTargetRoute(event, 'keepKey'));
