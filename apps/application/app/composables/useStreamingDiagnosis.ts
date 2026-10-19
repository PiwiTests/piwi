import type { FailureDiagnosis } from '~~/server/database/schema';
import type { DiagnosisStage } from '#shared/ai-diagnosis';

/**
 * Reactive state for a streaming AI diagnosis session.
 * Uses fetch() + POST with a ReadableStream response instead of EventSource
 * (which only supports GET) so we can send request body params.
 */

export type StreamStatus = 'idle' | 'streaming' | 'complete' | 'error' | 'cancelled';

export interface DiagnosisStreamBody {
  additionalContext?: string;
  images?: Array<{ name: string; mediaType: string; data: string }>;
  baseCommit?: string;
  selectedCommitShas?: string[];
  force?: boolean;
  scope?: 'cluster' | 'execution';
  testRunsCaseId?: number;
}

export interface UseStreamingDiagnosisReturn {
  thinkingText: Ref<string>;
  stage: Ref<DiagnosisStage | null>;
  status: Ref<StreamStatus>;
  result: Ref<FailureDiagnosis | null>;
  error: Ref<string | null>;
  startStream: (body?: DiagnosisStreamBody) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

/** How often, and how long, a diagnosis another request is running is checked on. */
const RUNNING_POLL_MS = 3_000;
const RUNNING_WAIT_MS = 10 * 60_000;

/** The text of a response body, whatever shape `$fetch.raw` gave it. */
async function bodyText(raw: unknown): Promise<string> {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
  }
  if (typeof (raw as ReadableStream).getReader === 'function') return new Response(raw as ReadableStream).text();
  return '';
}

/** The message of an API error response, else a sentence naming its status. */
export function refusalMessage(statusCode: number, text: string): string {
  try {
    const message = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  } catch {
    // Not JSON: the status says enough.
  }
  return `The diagnosis could not start (HTTP ${statusCode})`;
}

/** Wait `ms`, or reject with an AbortError when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function useStreamingDiagnosis(clusterId: Ref<number> | number): UseStreamingDiagnosisReturn {
  const thinkingText = ref('');
  const stage = ref<DiagnosisStage | null>(null);
  const status = ref<StreamStatus>('idle');
  const result = ref<FailureDiagnosis | null>(null);
  const error = ref<string | null>(null);

  let abortController: AbortController | null = null;

  function cancel() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (status.value === 'streaming') {
      status.value = 'cancelled';
    }
  }

  function reset() {
    cancel();
    thinkingText.value = '';
    stage.value = null;
    status.value = 'idle';
    result.value = null;
    error.value = null;
  }

  async function startStream(body: DiagnosisStreamBody = {}): Promise<void> {
    // Reset state
    thinkingText.value = '';
    stage.value = null;
    error.value = null;
    result.value = null;
    status.value = 'streaming';

    const cid = unref(clusterId);
    abortController = new AbortController();
    const signal = abortController.signal;

    // Build query params
    const query = new URLSearchParams();
    if (body.force) query.set('force', 'true');

    const url = `/api/failure-clusters/${cid}/diagnose/stream${query.toString() ? '?' + query.toString() : ''}`;

    try {
      const response = await $fetch.raw(url, {
        method: 'POST',
        body: {
          additionalContext: body.additionalContext,
          images: body.images,
          baseCommit: body.baseCommit,
          selectedCommitShas: body.selectedCommitShas,
          scope: body.scope,
          executionId: body.testRunsCaseId,
        },
        responseType: 'stream',
        signal,
        // Do not throw on non-2xx — we read the body ourselves
        ignoreResponseError: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawBody = response._data ?? (response.body as any);
      if (!response.ok) {
        // Another request is already diagnosing: follow the stored diagnosis until it is done.
        if (response.status === 409) {
          await rawBody?.cancel?.().catch(() => {});
          await waitForRunningDiagnosis(cid, body, signal);
          return;
        }
        error.value = refusalMessage(response.status, await bodyText(rawBody));
        status.value = 'error';
        return;
      }
      if (!rawBody) {
        throw new Error('No response body from streaming endpoint');
      }

      // Some fetch implementations give us a ReadableStream directly
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      if (rawBody instanceof ReadableStream) {
        reader = rawBody.getReader();
      } else if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
        // Response was already buffered (non-streaming fallback or test mode)
        const decoder = new TextDecoder();
        const text = decoder.decode(rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody) : rawBody);
        parseSseBuffer(text);
        if (status.value === 'streaming') {
          status.value = 'error';
          error.value = 'Stream ended without a result event';
        }
        return;
      } else {
        // Try to treat as a Response-like object
        if (typeof rawBody?.getReader === 'function') {
          reader = rawBody.getReader();
        } else if (rawBody?.pipeThrough) {
          // TransformStream-based response
          const rs = rawBody;
          reader = rs.getReader();
        } else {
          throw new Error('Unsupported stream response format');
        }
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages from the buffer
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        let resultEventReceived = false;
        for (const msg of messages) {
          const parsed = parseSseMessage(msg);
          if (parsed) {
            if (parsed.event === 'result') {
              result.value = parsed.data as FailureDiagnosis;
              status.value = 'complete';
              resultEventReceived = true;
            } else if (parsed.event === 'thinking') {
              const d = parsed.data as { text: string };
              thinkingText.value += d.text;
            } else if (parsed.event === 'stage') {
              stage.value = (parsed.data as { stage: DiagnosisStage }).stage;
            } else if (parsed.event === 'error') {
              const d = parsed.data as { message: string };
              error.value = d.message;
              status.value = 'error';
            }
          }
        }

        if (resultEventReceived) break;
      }

      // Handle remaining buffer
      if (buffer.trim()) {
        const parsed = parseSseMessage(buffer.trim());
        if (parsed) {
          if (parsed.event === 'result') {
            result.value = parsed.data as FailureDiagnosis;
            status.value = 'complete';
          } else if (parsed.event === 'error') {
            error.value = (parsed.data as { message: string }).message;
            status.value = 'error';
          }
        }
      }

      if (status.value === 'streaming') {
        // Stream ended without result or error event
        if (!error.value) {
          status.value = 'complete';
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') {
        status.value = 'cancelled';
        return;
      }
      error.value = String((err as Error)?.message ?? err);
      status.value = 'error';
    } finally {
      abortController = null;
    }
  }

  /**
   * Check on the stored diagnosis another request is running, until it
   * completes or fails (or the wait runs out), and take its outcome.
   */
  async function waitForRunningDiagnosis(cid: number, body: DiagnosisStreamBody, signal: AbortSignal): Promise<void> {
    const url =
      body.scope === 'execution' && body.testRunsCaseId
        ? `/api/test-run-cases/${body.testRunsCaseId}/diagnosis`
        : `/api/failure-clusters/${cid}/diagnosis`;
    const deadline = Date.now() + RUNNING_WAIT_MS;
    while (Date.now() < deadline) {
      await pause(RUNNING_POLL_MS, signal);
      const { diagnosis } = await $fetch<{ diagnosis: FailureDiagnosis | null }>(url, { signal });
      if (diagnosis?.status === 'completed') {
        result.value = diagnosis;
        status.value = 'complete';
        return;
      }
      if (diagnosis?.status === 'failed' || !diagnosis) {
        error.value = diagnosis?.error || 'The diagnosis another request was running did not finish';
        status.value = 'error';
        return;
      }
    }
    error.value = 'The diagnosis another request is running is taking too long. Reload the page later.';
    status.value = 'error';
  }

  /**
   * Parse a single SSE message (one event block between \n\n separators).
   */
  function parseSseMessage(raw: string): { event: string; data: unknown } | null {
    if (!raw.trim()) return null;

    const lines = raw.split('\n');
    let eventType = 'message';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr += line.slice(6);
      } else if (line.startsWith(':')) {
        // Comment (heartbeat) — skip
      }
    }

    if (!dataStr) return null;

    try {
      return { event: eventType, data: JSON.parse(dataStr) };
    } catch {
      return { event: eventType, data: dataStr };
    }
  }

  /**
   * Parse a buffer of SSE text (multiple \n\n-separated messages) all at once.
   * Used for the non-streaming fallback path.
   */
  function parseSseBuffer(text: string): void {
    const messages = text.split('\n\n');
    for (const msg of messages) {
      const parsed = parseSseMessage(msg);
      if (parsed) {
        if (parsed.event === 'result') {
          result.value = parsed.data as FailureDiagnosis;
          status.value = 'complete';
        } else if (parsed.event === 'thinking') {
          const d = parsed.data as { text: string };
          thinkingText.value += d.text;
        } else if (parsed.event === 'stage') {
          stage.value = (parsed.data as { stage: DiagnosisStage }).stage;
        } else if (parsed.event === 'error') {
          error.value = (parsed.data as { message: string }).message;
          status.value = 'error';
        }
      }
    }
  }

  onScopeDispose(() => {
    cancel();
  });

  return {
    thinkingText,
    stage,
    status,
    result,
    error,
    startStream,
    cancel,
    reset,
  };
}
