import type { MaybeRefOrGetter } from 'vue';
import type { TraceInfo } from '~~/types/api';

/** A stored trace's file name when it is a content hash rather than a name anyone gave it. */
const HASHED_NAME_RE = /^[0-9a-f]{32,}\.zip$/i;

/**
 * Opening and downloading one stored trace: the viewer URL, the download URL,
 * a readable name, and click handlers that route both through the desktop
 * shell where `target="_blank"` is inert (a new app window keeps the
 * access-token cookie; the archive is saved through the shell). On the web
 * the handlers leave the anchors to open a tab and download as usual.
 */
export function useTraceLinks(trace: MaybeRefOrGetter<TraceInfo | null | undefined>) {
  const config = useRuntimeConfig();
  const base = computed(() => (config.app?.baseURL ?? '/').replace(/\/$/, ''));
  const current = computed(() => toValue(trace) ?? null);

  // Demo mode: the sample trace is a committed static asset. The trace viewer
  // fetches through its own service worker (bypassing the demo's API-emulating
  // one), so it must be pointed at the static URL, not /api/files/.
  const isDemoStaticAsset = computed(
    () => !!config.public.demoMode && Boolean(current.value?.filePath.startsWith('demo/')),
  );

  const fileName = computed(() => {
    const path = current.value?.filePath ?? '';
    return path.split('/').pop() || path;
  });
  /** The name to show: the file's own, or "Playwright trace" for a content-addressed one. */
  const name = computed(() => (HASHED_NAME_RE.test(fileName.value) ? 'Playwright trace' : fileName.value));

  /**
   * Why the viewer cannot open this trace, or null when it can: in the demo, a
   * trace that is not one of its static samples (a run imported into the demo)
   * lives only in the demo's in-browser database, which the viewer cannot read.
   */
  const viewUnavailable = computed(() =>
    current.value && config.public.demoMode && !isDemoStaticAsset.value
      ? 'The demo opens only its sample traces in the viewer: download this one to open it'
      : null,
  );

  const viewUrl = computed(() =>
    current.value && !viewUnavailable.value
      ? getTraceViewerUrl(current.value.filePath, config.app?.baseURL, isDemoStaticAsset.value)
      : null,
  );
  const downloadUrl = computed(() => {
    const path = current.value?.filePath;
    if (!path) return null;
    return isDemoStaticAsset.value ? `${base.value}/${path}` : `${base.value}/api/files/${getFileApiPath(path)}`;
  });

  const { isDesktop, openWindow } = useDesktopWindow();
  const { download } = useDesktopDownload();

  function onView(event: MouseEvent) {
    if (!isDesktop || !viewUrl.value) return;
    event.preventDefault();
    openWindow(viewUrl.value);
  }
  function onDownload(event: MouseEvent) {
    if (!isDesktop || !downloadUrl.value) return;
    event.preventDefault();
    download(downloadUrl.value, HASHED_NAME_RE.test(fileName.value) ? 'trace.zip' : fileName.value, { binary: true });
  }

  return { name, viewUrl, viewUnavailable, downloadUrl, onView, onDownload };
}
