import { fileApiUrl } from '~/utils';

/**
 * Open a stored report from the desktop shell.
 *
 * Report buttons are `target="_blank"` links, which the Tauri webview drops —
 * so in the desktop build they do nothing. This overrides the click there: an
 * interactive report (the Playwright HTML report, monocart) opens in a new app
 * window on the loopback origin (which keeps the access-token cookie so the
 * guarded file loads), and a `blob` archive — meant to be merged, not viewed —
 * is saved to disk instead. On the web the anchor is left untouched, so it opens
 * a new tab / downloads natively.
 */
export function useDesktopReportLink() {
  const config = useRuntimeConfig();
  const { isDesktop, openWindow } = useDesktopWindow();
  const { download } = useDesktopDownload();

  /** Open a report through the shell — a window for viewable reports, a disk save for a blob archive. */
  function openReport(report: { path: string; type: string }) {
    const url = fileApiUrl(report.path, null, config.app?.baseURL);
    if (report.type === 'blob') {
      download(url, report.path.split('/').pop() || 'report.zip');
    } else {
      openWindow(url);
    }
  }

  /** Click handler for an anchor-style report button: leaves the web anchor alone, overrides on desktop. */
  function onOpenReport(event: MouseEvent, report: { path: string; type: string }) {
    if (!isDesktop) return;
    event.preventDefault();
    openReport(report);
  }

  return { isDesktop, openReport, onOpenReport };
}
