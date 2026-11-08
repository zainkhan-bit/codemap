/**
 * Optional PNG rasterizer. Isolated in its own package because it carries a native
 * (prebuilt, per-platform) dependency; the application loads it lazily and falls back to a
 * clear error when it is unavailable. Input is CodeMap's own SVG; no files or network are touched.
 */
import { Resvg } from "@resvg/resvg-js";

export interface RasterizeOptions {
  /** Output scale relative to the SVG's size (default 2 for crisp text). */
  scale?: number;
  /** Refuse to produce images wider or taller than this many pixels (default 16 384). */
  maxDimension?: number;
}

export class RasterizeError extends Error {}

export function rasterizeSvg(svg: string, opts: RasterizeOptions = {}): Uint8Array {
  const scale = opts.scale ?? 2;
  const max = opts.maxDimension ?? 16_384;
  const m = /<svg[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg);
  if (m && Math.max(Number(m[1]), Number(m[2])) * scale > max) {
    throw new RasterizeError(`diagram is too large to rasterize (${m[1]}×${m[2]} at ${scale}x exceeds ${max}px); export SVG instead or narrow it with --path`);
  }
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    background: "#ffffff",
    font: { loadSystemFonts: true, defaultFontFamily: "monospace" },
  });
  const png = resvg.render().asPng();
  if (png.length === 0) throw new RasterizeError("rasterizer produced an empty image");
  return new Uint8Array(png);
}
