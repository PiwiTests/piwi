/**
 * Turns a collected bundle into the bytes of a downloadable file.
 *
 * Server and demo both call this: the only thing they supply differently is an
 * `ExportAssetReader`. Size budgeting and the ZIP layout live here so the two
 * cannot drift.
 */
import { consoleLine } from './fields';
import { renderExportHtml } from './render-html';
import { renderExportMarkdown } from './render-markdown';
import { renderExportPdf } from './render-pdf';
import { buildExportZip, type ExportZipEntry } from './zip';
import type {
  ExportAsset,
  ExportAssetReader,
  ExportBudget,
  ExportBundle,
  ExportFormat,
  ExportOmissionReason,
} from './types';

export interface BuildExportOptions {
  reader: ExportAssetReader;
  budget: ExportBudget;
}

export interface BuiltExport {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();

/** Base64 in chunks — `String.fromCharCode(...bytes)` blows the argument limit on real media. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Media that is already compressed; deflating it again is wasted work. */
function isPrecompressed(asset: ExportAsset): boolean {
  return asset.kind !== 'attachment' || /\.(png|jpe?g|gif|webp|webm|mp4|zip|gz)$/i.test(asset.storagePath);
}

function slugifyFileName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'export'
  );
}

/** `piwi-cluster-12-timeout-on-pay.pdf`; a run is named after its project and branch: `piwi-run-4-shop-main.pdf`. */
export function exportFileName(bundle: ExportBundle, format: ExportFormat, id: number): string {
  const ext = format === 'md' ? 'md' : format;
  const name =
    bundle.kind === 'run'
      ? [bundle.project?.label || bundle.project?.name, bundle.run?.detail.branch].filter(Boolean).join(' ') || 'run'
      : bundle.title;
  return `piwi-${bundle.kind}-${id}-${slugifyFileName(String(name))}.${ext}`;
}

const KIND_LABELS: Record<ExportBundle['kind'], string> = {
  execution: 'test execution',
  cluster: 'failure cluster',
  run: 'test run',
};

/**
 * Read every asset once, honoring the total budget. Assets that do not fit are
 * recorded on the bundle's `omitted` list rather than dropped silently.
 */
async function readAssets(
  bundle: ExportBundle,
  opts: BuildExportOptions,
  accept: (asset: ExportAsset, bytes: number) => true | ExportOmissionReason,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  let used = 0;

  for (const exportCase of bundle.cases) {
    for (const asset of exportCase.assets) {
      const declared = asset.size ?? 0;
      const verdict = accept(asset, declared);
      if (verdict !== true) {
        bundle.omitted.push({ name: asset.name, kind: asset.kind, bytes: asset.size, reason: verdict });
        continue;
      }
      if (used + declared > opts.budget.maxTotalBytes) {
        bundle.omitted.push({ name: asset.name, kind: asset.kind, bytes: asset.size, reason: 'budget-exhausted' });
        continue;
      }

      let bytes: Uint8Array | null = null;
      try {
        bytes = await opts.reader.read(asset);
      } catch {
        bytes = null;
      }
      if (!bytes) {
        bundle.omitted.push({ name: asset.name, kind: asset.kind, bytes: asset.size, reason: 'unreadable' });
        continue;
      }
      // The declared size can be stale; re-check against the real bytes.
      if (used + bytes.length > opts.budget.maxTotalBytes) {
        bundle.omitted.push({ name: asset.name, kind: asset.kind, bytes: bytes.length, reason: 'budget-exhausted' });
        continue;
      }
      used += bytes.length;
      out.set(asset.storagePath, bytes);
    }
  }

  return out;
}

function readmeText(bundle: ExportBundle): string {
  const lines = [
    `Piwi export — ${KIND_LABELS[bundle.kind]}`,
    `Title:     ${bundle.title}`,
    `Exported:  ${bundle.generatedAt}`,
    bundle.project ? `Project:   ${bundle.project.label || bundle.project.name}` : '',
    bundle.sourceUrl ? `Source:    ${bundle.sourceUrl}` : '',
    '',
    'Contents',
    '  report.html            The full report. Open it in any browser — no network needed.',
    '  data.json              Everything in the report, machine-readable.',
    '  evidence/<case>/       Screenshots, video, traces, logs per test execution.',
    '',
    'Trace archives (evidence/*/traces/*.zip) are Playwright traces. Open them at',
    'https://trace.playwright.dev or with `npx playwright show-trace <file>`.',
    '',
  ];
  if (bundle.omitted.length) {
    lines.push('Omitted from this export:');
    for (const o of bundle.omitted) lines.push(`  - ${o.name} (${o.kind}) — ${o.reason}`);
    lines.push('');
  }
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

export async function buildExport(
  bundle: ExportBundle,
  format: ExportFormat,
  id: number,
  opts: BuildExportOptions,
): Promise<BuiltExport> {
  const fileName = exportFileName(bundle, format, id);

  if (format === 'json' || format === 'md') {
    // Text formats reference evidence by name; nothing is read from storage.
    const text = format === 'json' ? JSON.stringify(bundle, null, 2) : renderExportMarkdown(bundle);
    return {
      fileName,
      contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      bytes: encoder.encode(text),
    };
  }

  if (format === 'html') {
    const bytesByPath = await readAssets(bundle, opts, (asset, declared) => {
      // A trace archive is only useful to a trace viewer, and inlining one
      // bloats the file for nothing.
      if (asset.kind === 'trace') return 'html-format';
      if (declared > opts.budget.maxInlineBytes) return 'too-large';
      return true;
    });

    const html = renderExportHtml(bundle, {
      assetUrl: (asset) => {
        const bytes = bytesByPath.get(asset.storagePath);
        if (!bytes) return null;
        return `data:${asset.contentType};base64,${toBase64(bytes)}`;
      },
    });
    return { fileName, contentType: 'text/html; charset=utf-8', bytes: encoder.encode(html) };
  }

  if (format === 'pdf') {
    // A real vector PDF, generated in pure JS so it works the same on the
    // server, the desktop shell and the demo — no browser print. Only
    // screenshots embed; other evidence is listed, exactly as the HTML report.
    const bytesByPath = await readAssets(bundle, opts, (asset, declared) => {
      // A PDF can only carry raster images; everything else is listed instead.
      if (asset.kind !== 'screenshot') return 'pdf-format';
      if (declared > opts.budget.maxInlineBytes) return 'too-large';
      return true;
    });

    const bytes = await renderExportPdf(bundle, {
      imageFor: (asset) => bytesByPath.get(asset.storagePath) ?? null,
    });
    return { fileName, contentType: 'application/pdf', bytes };
  }

  // ZIP — everything that fits the total budget, at full fidelity.
  const bytesByPath = await readAssets(bundle, opts, () => true);

  const entries: ExportZipEntry[] = [];
  for (const exportCase of bundle.cases) {
    for (const asset of exportCase.assets) {
      const bytes = bytesByPath.get(asset.storagePath);
      if (!bytes) continue;
      entries.push({ path: asset.zipPath, data: bytes, precompressed: isPrecompressed(asset) });
    }

    const d = exportCase.detail as Record<string, any>;
    if (Array.isArray(d.consoleLogs) && d.consoleLogs.length) {
      entries.push({
        path: `evidence/${exportCase.slug}/console.log`,
        data: (d.consoleLogs as Record<string, any>[]).map(consoleLine).join('\n'),
      });
    }
    if (Array.isArray(d.networkRequests) && d.networkRequests.length) {
      entries.push({
        path: `evidence/${exportCase.slug}/network.json`,
        data: JSON.stringify(d.networkRequests, null, 2),
      });
    }
    if (d.ariaSnapshot) {
      entries.push({ path: `evidence/${exportCase.slug}/aria-snapshot.txt`, data: String(d.ariaSnapshot) });
    }
    if (d.testSource) {
      entries.push({ path: `evidence/${exportCase.slug}/source.txt`, data: String(d.testSource) });
    }
    if (d.error) {
      entries.push({ path: `evidence/${exportCase.slug}/error.txt`, data: String(d.error) });
    }

    const fix = ((exportCase.diagnosis?.details as Record<string, any> | undefined)?.suggestedFix ?? null) as Record<
      string,
      any
    > | null;
    if (fix?.patch) {
      entries.push({ path: `diagnosis/${exportCase.slug}-suggested-fix.patch`, data: String(fix.patch) });
    }
  }

  const clusterFix = ((bundle.cluster?.diagnosis as Record<string, any> | undefined)?.details?.suggestedFix ??
    null) as Record<string, any> | null;
  if (clusterFix?.patch) {
    entries.push({ path: 'diagnosis/cluster-suggested-fix.patch', data: String(clusterFix.patch) });
  }

  // Rendered last: `omitted` is only complete once every asset has been read.
  const html = renderExportHtml(bundle, {
    assetUrl: (asset) => (bytesByPath.has(asset.storagePath) ? asset.zipPath : null),
  });
  entries.unshift(
    { path: 'report.html', data: html },
    { path: 'data.json', data: JSON.stringify(bundle, null, 2) },
    { path: 'README.txt', data: readmeText(bundle) },
  );

  return { fileName, contentType: 'application/zip', bytes: buildExportZip(entries) };
}
