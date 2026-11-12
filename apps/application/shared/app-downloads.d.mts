export type DownloadOs = 'windows' | 'macos' | 'linux';

export interface DownloadApp {
  id: 'desktop' | 'runner';
  name: string;
  prefix: string;
  summary: string;
  doc: string;
}

export interface DownloadPackage {
  os: DownloadOs;
  label: string;
  file: string;
}

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
  };
}

export const LATEST_RELEASE_URL: string;
export const LATEST_RELEASE_API: string;
export const DOWNLOAD_APPS: readonly DownloadApp[];
export const DOWNLOAD_PACKAGES: readonly DownloadPackage[];
export function assetName(app: DownloadApp, pkg: DownloadPackage): string;
export function downloadUrl(app: DownloadApp, pkg: DownloadPackage, files?: ReadonlySet<string> | null): string;
export function latestReleaseFiles(
  fetchFn: (url: string, init?: object) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<Set<string> | null>;
export function detectOs(nav: NavigatorLike): DownloadOs | null;
export function detectMacChip(nav: NavigatorLike): Promise<'arm' | 'x86' | null>;
export function downloadsMarkdown(appIds?: readonly string[]): string[];
