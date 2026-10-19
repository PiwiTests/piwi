import { subscribeDemoEvents } from '~/demo/run-events';
import { useDiagnosisNotification } from './useDiagnosisNotification';
import { useBrowserNotificationCookie } from './useBrowserNotificationCookie';

let sharedSource: EventSource | null = null;
let _demoUnsubscribe: (() => void) | null = null;
let started = false;
let _windowFocused = true;
/** The router and the base path the app is served at (`/demo/` in the demo), read when the stream starts. */
let _router: ReturnType<typeof useRouter> | null = null;
let _baseURL = '/';

if (import.meta.client) {
  window.addEventListener('focus', () => {
    _windowFocused = true;
  });
  window.addEventListener('blur', () => {
    _windowFocused = false;
  });
  _windowFocused = document.hasFocus();
}
let _cookie: ReturnType<typeof useBrowserNotificationCookie> | null = null;

interface NotificationEventData {
  type: string;
  projectId?: number;
  projectName?: string;
  runId?: number;
  status?: string;
  failedTests?: number;
  totalTests?: number;
  branch?: string;
  signature?: string;
  title?: string | null;
  verification?: string;
  clusterId?: number;
  executionId?: number;
  summary?: string | null;
  rootCause?: string | null;
  category?: string | null;
  confidence?: string | null;
  topFailures?: { title: string }[];
  affectedCases?: number;
  snapshotId?: number;
  tests?: { title: string }[];
  reason?: string;
}

function renderBody(data: NotificationEventData): string {
  const lines: string[] = [];
  switch (data.type) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike':
    case 'perf.regression': {
      const name = data.projectName ?? `Project #${data.projectId}`;
      const branchSuffix = data.branch && data.type !== 'perf.regression' ? ` on ${data.branch}` : '';
      if (data.type === 'run.finished') lines.push(`${name}${branchSuffix}: ${data.status ?? 'finished'}`);
      else if (data.type === 'run.failed')
        lines.push(`${name}${branchSuffix}: ${data.failedTests ?? 0}/${data.totalTests ?? 0} tests failed`);
      else if (data.type === 'run.interrupted')
        lines.push(`${name}${branchSuffix}: interrupted before it finished, the reporter stopped sending`);
      else if (data.type === 'run.failed.default_branch')
        lines.push(`${name}: ${data.failedTests ?? 0} failures on default branch`);
      else if (data.type === 'flakiness.spike') lines.push(`${name}: flakiness spike detected`);
      else if (data.type === 'perf.regression') lines.push(`${name}: performance regression detected`);
      if (data.failedTests) lines.push(`${data.failedTests} failed, ${data.totalTests} total`);
      if (data.topFailures?.length) {
        const [first, ...rest] = data.topFailures;
        lines.push(rest.length ? `${first!.title} +${rest.length} more` : first!.title);
      }
      break;
    }
    case 'cluster.new':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: new failure cluster`);
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'cluster.fixed':
      lines.push(
        `${data.projectName ?? `Project #${data.projectId}`}: ${data.verification === 'diagnosis-verified' ? 'diagnosis verified' : 'cluster stopped failing'}`,
      );
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'cluster.regressed':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: a fixed cluster is failing again`);
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'bug.looks_fixed':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: a test marked to fail now passes`);
      if (data.tests?.length) lines.push(data.tests.map((t) => t.title).join(', '));
      break;
    case 'environment.incident':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: environment incident`);
      if (data.reason) lines.push(data.reason);
      break;
    case 'report.ready':
      lines.push(`Your quality report is ready: ${data.title ?? 'open it in Piwi'}`);
      break;
    case 'diagnosis.completed':
      lines.push(data.summary || data.rootCause || '');
      if (data.category) lines.push(`Category: ${data.category}`);
      if (data.confidence) lines.push(`Confidence: ${data.confidence}`);
      break;
  }
  return lines.filter(Boolean).join('\n');
}

function getLink(data: NotificationEventData): string | null {
  if (data.snapshotId) return `/reports/${data.snapshotId}`;
  if (data.type === 'diagnosis.completed' && data.executionId) return `/test-run-cases/${data.executionId}`;
  if (data.clusterId) return `/failure-clusters/${data.clusterId}`;
  if (data.runId && data.projectId) return `/test-runs/${data.runId}`;
  return null;
}

let _diagnosisActive: ReturnType<typeof useDiagnosisNotification>['active'] | null = null;

function handleEvent(data: NotificationEventData) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && _windowFocused) return;

  if (data.type === 'diagnosis.completed' && _diagnosisActive && !_diagnosisActive.value) {
    return;
  }

  if (_cookie && data.projectId != null) {
    if (!_cookie.isEventSubscribed(data.projectId, data.type)) return;
  }

  const body = renderBody(data);
  if (!body) return;

  // Use type + key id for dedup tag
  const dedupKey = data.snapshotId ?? data.executionId ?? data.clusterId ?? data.runId ?? data.signature ?? data.type;
  const tag = `piwi-${data.type}-${dedupKey}`;

  const notification = new Notification('Piwi Dashboard', {
    body,
    tag,
    icon: `${_baseURL.replace(/\/$/, '')}/logo.svg`,
  });

  const link = getLink(data);
  if (link) {
    notification.onclick = () => {
      window.focus();
      void _router?.push(link);
      notification.close();
    };
  } else {
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }
}

async function checkBrowserSubscriptions(): Promise<boolean> {
  if (useRuntimeConfig().public.demoMode) return true;
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;

  try {
    const res = await $fetch<{ items: Array<{ type: string }> }>('/api/channels');
    return res.items.some((c) => c.type === 'browser');
  } catch {
    return false;
  }
}

async function shouldConnect(): Promise<boolean> {
  const config = useRuntimeConfig();

  if (config.public.demoMode) return true;

  if (config.public.authEnabled) {
    return checkBrowserSubscriptions();
  }

  return true;
}

function connectDemo() {
  _demoUnsubscribe = subscribeDemoEvents((message) => {
    if (message.scope === 'notification') {
      handleEvent(message.event as unknown as NotificationEventData);
    }
  });
}

function connectLive() {
  sharedSource = new EventSource('/api/notifications/stream');

  sharedSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleEvent(data as NotificationEventData);
    } catch {
      /* ignore */
    }
  };

  sharedSource.onerror = () => {
    // EventSource auto-reconnects
  };
}

export function useNotificationStream() {
  if (!import.meta.client || started) return;
  started = true;

  const { active } = useDiagnosisNotification();
  _diagnosisActive = active;

  const config = useRuntimeConfig();
  _router = useRouter();
  _baseURL = config.app.baseURL || '/';

  if (!config.public.authEnabled) {
    _cookie = useBrowserNotificationCookie();
  }

  shouldConnect().then((subscribed) => {
    if (!subscribed) return;

    if (config.public.demoMode) {
      connectDemo();
    } else {
      connectLive();
    }
  });
}
