export interface RunnerUpdateEntry {
  signature: string;
  url: string;
}

export interface RunnerUpdateManifest {
  version: string;
  pub_date: string;
  platforms: Record<string, RunnerUpdateEntry>;
}

export function runnerUpdateManifest(release: {
  version: string;
  pubDate: string;
  assets: { name: string; url: string }[];
  signatures: Record<string, string>;
  prefix?: string;
}): RunnerUpdateManifest;
