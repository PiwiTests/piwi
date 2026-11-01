/**
 * Save a file to disk from the desktop shell.
 *
 * A `target="_blank"` / `download` link is inert in the Tauri webview — the
 * new-window request is dropped, so the file never lands anywhere (this is why
 * "download the OpenAPI spec" appears to do nothing in the desktop app). On the
 * desktop, `download` hands the URL to the shell, which requests it from its own
 * server with the app's token and streams it into the user's Downloads folder,
 * then reveals it: the file never crosses IPC or sits whole in the page, so an
 * archive of any size saves.
 *
 * Outside the desktop shell there is no bridge, so `download` falls back to a
 * normal navigation and the browser handles it — meaning callers can wire this
 * unconditionally and it does the right thing on web and desktop alike.
 *
 * `saveBlob` saves a file built in the page (a workbook, an image): its bytes
 * ride the bridge base64-encoded, since a byte array crosses Tauri's IPC as JSON
 * numbers, which multiplies its size.
 */

import { downloadBlob } from '~/utils/chart-export';

/** Base64 in chunks — spreading a multi-megabyte array blows the argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function useDesktopDownload() {
  const isDesktop = useIsDesktop();
  const toast = useToast();

  /** Save what `url` (a page of this dashboard) serves under `filename`, its bytes as they are. */
  async function download(url: string, filename: string): Promise<void> {
    const core = tauriCore();
    if (!core) {
      window.open(url, '_blank');
      return;
    }

    try {
      const path = await core.invoke<string>('desktop_download', {
        url: new URL(url, window.location.href).href,
        filename,
      });
      savedToast(path);
    } catch (error) {
      toast.add({ title: 'Download failed', description: errorMessage(error), color: 'error' });
    }
  }

  /** Save a file built in the page (a workbook, an image): a download link in a browser, the shell on desktop. */
  async function saveBlob(blob: Blob, filename: string): Promise<void> {
    const core = tauriCore();
    if (!core) {
      downloadBlob(blob, filename);
      return;
    }
    try {
      await saveThroughShell(core, filename, toBase64(new Uint8Array(await blob.arrayBuffer())), 'base64');
    } catch (error) {
      toast.add({ title: 'Download failed', description: errorMessage(error), color: 'error' });
    }
  }

  async function saveThroughShell(
    core: NonNullable<ReturnType<typeof tauriCore>>,
    filename: string,
    contents: string,
    encoding: 'base64' | 'utf8',
  ): Promise<void> {
    savedToast(await core.invoke<string>('desktop_save_download', { filename, contents, encoding }));
  }

  function savedToast(path: string): void {
    toast.add({
      title: 'Saved to Downloads',
      description: path,
      color: 'success',
      icon: 'i-lucide-download',
    });
  }

  return { isDesktop, download, saveBlob };
}
