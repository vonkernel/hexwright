/**
 * Colours, type and the small helpers every SVG here is drawn with.
 *
 * Two renderers share them — the graph and the interface view — and they have to
 * agree: a picture that says red means a violation in one image and something else
 * in another is worse than having only one image.
 */

export const BG = "#0e1116";
export const FG = "#e6edf3";
export const MUTED = "#8b949e";
export const DIM = "#6e7681";
export const RULE = "#30363d";
export const ADDED = "#f0883e";
export const MODIFIED = "#a371f7";
export const VIOLATION = "#f85149";

/**
 * Font stack. The tail is for Linux CI containers: with no matching font at all
 * the rasterizer drops every glyph, and the picture becomes quietly useless.
 */
export const FONT =
  "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial," +
  " 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', sans-serif";

export const hsl = (h: number, s: number, l: number) => `hsl(${h},${s}%,${l}%)`;

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Estimated text width — SVG offers no measurement, so overflow is truncated.
 *
 * The CJK branch matters: a Korean or Japanese type name is about twice the width
 * of a Latin one, and treating it as Latin overflows every box it lands in.
 */
export function textWidth(text: string, fontPx: number): number {
  return (
    [...text].reduce(
      (a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 1.0 : /[A-Z]/.test(c) ? 0.62 : 0.5),
      0,
    ) * fontPx
  );
}

/** Truncate to fit, with an ellipsis, or return it unchanged. */
export function fit(text: string, maxPx: number, fontPx: number): string {
  if (textWidth(text, fontPx) <= maxPx) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, fontPx) > maxPx) out = out.slice(0, -1);
  return `${out}…`;
}
