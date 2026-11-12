export function renderAssetName(pattern: string, pkg: { arch: string; setup: string; ext: string }): string;
export function releaseFiles(build: {
  files: string[];
  target: string;
  pattern: string;
}): { from: string; name: string }[];
