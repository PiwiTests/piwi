/**
 * The trend of a quality report as a PNG: the marks-only SVG of a `series`
 * block (`chartMarksSvg`) rasterized by `sharp`. The email attaches it by
 * content id and the share link serves it as `chart.png`. The SVG carries no
 * text at all, because the production image ships no fonts for the
 * rasterizer; the axis values, the dates and the legend are HTML text beside
 * the image.
 */
import { chartMarksSvg } from '#shared/reports/chart';
import type { ReportBlock } from '#shared/reports/types';

type SeriesBlock = Extract<ReportBlock, { kind: 'series' }>;

/** The share image's size in CSS pixels; the PNG is drawn at twice that for sharp screens. */
export const SHARE_CHART_WIDTH = 496;
export const SHARE_CHART_HEIGHT = 140;

/** Rasterize the chart's marks to a PNG at twice the CSS size. */
export async function chartPng(
  block: SeriesBlock,
  width = SHARE_CHART_WIDTH,
  height = SHARE_CHART_HEIGHT,
): Promise<Buffer> {
  const svg = chartMarksSvg(block, width, height);
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}
