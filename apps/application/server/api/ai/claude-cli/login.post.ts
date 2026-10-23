import { requireAuth } from '../../../utils/auth';
import { claudeCliEnabled, runClaudeLogin } from '../../../utils/ai-claude-cli';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Sign in to the local Claude CLI',
    description:
      'Runs `claude auth login`, which opens the browser OAuth flow, and streams its progress as Server-Sent Events: `event: log` lines (including the sign-in URL), then a final `event: done` with `{ success }`. Desktop app only. Requires `settings:manage` (administrators only).',
    'x-required-permission': 'settings:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  if (!claudeCliEnabled()) {
    throw apiError({
      statusCode: 400,
      message:
        'The local Claude CLI is only available in the Piwi desktop app, or on a server with PIWI_CLAUDE_CLI_PATH set',
    });
  }

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const encoder = new TextEncoder();
  let disconnected = false;
  event.node.req.on('close', () => {
    disconnected = true;
  });

  return new ReadableStream({
    async start(controller) {
      const send = (ev: string, data: unknown) => {
        if (disconnected) return;
        try {
          controller.enqueue(encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream closed
        }
      };

      try {
        // Surface any URL the CLI prints so the UI can offer it if the browser did not open.
        const urlPattern = /(https?:\/\/\S+)/;
        const result = await runClaudeLogin((line) => {
          const url = line.match(urlPattern)?.[1] ?? null;
          send('log', { line, url });
        });
        send('done', { success: result.success, error: result.error });
      } catch (err) {
        send('done', { success: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
});
