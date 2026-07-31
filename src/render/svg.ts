import type { Edge, Graph, Node } from "../model.ts";
import {
  LEVEL,
  OUTLINE,
  SATURATION,
  SHAPE,
  gridLayout,
  hexLayout,
  hueMap,
  isCommon,
  organicLayout,
} from "../view/layout.ts";

/**
 * Draws the graph straight to SVG.
 *
 * The coordinates are a pure function, so no browser is involved — CI needs no
 * headless Chrome, and the same graph always produces the same file, which is
 * what makes two branches comparable.
 * Shape, colour and line rules come from the same definitions as the web UI.
 */

const BG = "#0e1116";
const FG = "#e6edf3";
const MUTED = "#8b949e";
const DIM = "#6e7681";
const RULE = "#30363d";
const ADDED = "#f0883e";
const MODIFIED = "#a371f7";
const VIOLATION = "#f85149";
/**
 * Font stack. The tail is for Linux CI containers: with no matching font at all
 * the rasterizer drops every glyph, and the picture becomes quietly useless.
 */
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial," +
  " 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', sans-serif";

const hsl = (h: number, s: number, l: number) => `hsl(${h},${s}%,${l}%)`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Estimated text width — SVG offers no measurement, so overflow is truncated. */
function fit(text: string, maxPx: number, fontPx: number): string {
  const w = (s: string) =>
    [...s].reduce(
      (a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 1.0 : /[A-Z]/.test(c) ? 0.62 : 0.5),
      0,
    ) * fontPx;
  if (w(text) <= maxPx) return text;
  let out = text;
  while (out.length > 1 && w(`${out}…`) > maxPx) out = out.slice(0, -1);
  return `${out}…`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Placed extends Box {
  n: Node;
}
interface Pt {
  x: number;
  y: number;
}

const sizeOf = (n: Node): { w: number; h: number } =>
  n.component === "Entity" ? { w: 190, h: 36 } : { w: 182, h: 32 };

/** Node shape. Saturation alone does not separate the four core components. */
function shapePath(p: Placed): string {
  const { x, y, w, h } = p;
  const l = x - w / 2;
  const t = y - h / 2;
  switch (SHAPE[p.n.component]) {
    case "barrel": // Entity — a barrel, rounded on both ends
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}"/>`;
    case "rectangle": // Service
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}"/>`;
    case "cut-rectangle": {
      // Port — corners cut off
      const c = 8;
      const pts = [
        [l + c, t],
        [l + w - c, t],
        [l + w, t + c],
        [l + w, t + h - c],
        [l + w - c, t + h],
        [l + c, t + h],
        [l, t + h - c],
        [l, t + c],
      ];
      return `<polygon points="${pts.map(([a, b]) => `${a},${b}`).join(" ")}"/>`;
    }
    case "rhomboid": {
      // Event — a slanted parallelogram
      const s = 9;
      return `<polygon points="${l + s},${t} ${l + w},${t} ${l + w - s},${t + h} ${l},${t + h}"/>`;
    }
    default:
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" rx="5" ry="5"/>`;
  }
}

const qbez = (a: Pt, c: Pt, b: Pt, t: number): Pt => ({
  x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t ** 2 * b.x,
  y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t ** 2 * b.y,
});

const inside = (p: Pt, b: Box, pad = 0): boolean =>
  Math.abs(p.x - b.x) <= b.w / 2 + pad && Math.abs(p.y - b.y) <= b.h / 2 + pad;

/** Trim the line at both node borders, or the arrowhead ends up buried in a box. */
function trim(a: Pt, c: Pt, b: Pt, ab: Box, bb: Box): { t0: number; t1: number } | undefined {
  const N = 120;
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    if (!inside(qbez(a, c, b, t), ab, 1)) {
      t0 = t;
      break;
    }
  }
  for (let i = 0; i <= N; i++) {
    const t = 1 - i / N;
    if (!inside(qbez(a, c, b, t), bb, 3)) {
      t1 = t;
      break;
    }
  }
  return t1 - t0 < 0.02 ? undefined : { t0, t1 };
}

interface EdgeStyle {
  width: number;
  dash: string;
  bow: number;
  arrow: "vee" | "triangle";
  scale: number;
}

const EDGE: Record<string, EdgeStyle> = {
  DEPENDS_ON: { width: 1.9, dash: "", bow: 0, arrow: "vee", scale: 0.95 },
  IMPLEMENTS: { width: 2.2, dash: "9 5", bow: 42, arrow: "triangle", scale: 1.35 },
  EXTENDS: { width: 3.4, dash: "3 3", bow: 58, arrow: "triangle", scale: 1.6 },
};

function arrowHead(tip: Pt, dir: Pt, st: EdgeStyle, color: string): string {
  const len = 11 * st.scale;
  const half = 4.6 * st.scale;
  const nx = -dir.y;
  const ny = dir.x;
  const bx = tip.x - dir.x * len;
  const by = tip.y - dir.y * len;
  const p1 = `${bx + nx * half},${by + ny * half}`;
  const p2 = `${bx - nx * half},${by - ny * half}`;
  if (st.arrow === "vee") {
    // an open V, unfilled
    return `<path d="M${p1} L${tip.x},${tip.y} L${p2}" fill="none" stroke="${color}" stroke-width="${st.width * 1.3}" stroke-linecap="round"/>`;
  }
  // a hollow triangle, filled with the background so the line does not show through
  return `<polygon points="${tip.x},${tip.y} ${p1} ${p2}" fill="${BG}" stroke="${color}" stroke-width="${st.width}"/>`;
}

export interface RenderOptions {
  layout?: "hex" | "grid" | "organic";
  /** View description printed in the header. */
  viewLabel?: string;
  showIdentifiers?: boolean;
}

/**
 * Choose the grid width. This is an image, not a screen, so wide costs: a PR
 * comment scales to its own width. Pick whichever candidate lands nearest 4:3
 * and get something tall. gridLayout is pure, so trying a few is free.
 */
function gridWidthFor(g: Graph): number {
  const TARGET = 4 / 3;
  let best = 3000;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const w of [900, 1200, 1500, 1900, 2400, 3000, 3800]) {
    const pos = gridLayout(g, w);
    if (!pos.length) continue;
    const xs = pos.map((p) => p.x);
    const ys = pos.map((p) => p.y);
    const gw = Math.max(...xs) - Math.min(...xs) + 300;
    const gh = Math.max(...ys) - Math.min(...ys) + 200;
    const err = Math.abs(gw / gh - TARGET);
    if (err < bestErr) {
      bestErr = err;
      best = w;
    }
  }
  return best;
}

export function renderSvg(g: Graph, opt: RenderOptions = {}): string {
  const layout = opt.layout ?? "hex";
  const hueOf = hueMap(g.nodes.map((n) => n.domain));
  const place =
    layout === "hex"
      ? hexLayout(g)
      : layout === "organic"
        ? organicLayout(g)
        : gridLayout(g, gridWidthFor(g));
  const coords = new Map(place.map((p) => [p.id, p]));

  const placed: Placed[] = g.nodes.map((n) => {
    const c = coords.get(n.id) ?? { x: 0, y: 0 };
    return { n, x: c.x, y: c.y, ...sizeOf(n) };
  });
  const at = new Map(placed.map((p) => [p.n.id, p]));

  // Domain boxes, sized from the actual extent of the visible nodes
  const domains = new Map<string, Box>();
  for (const p of placed) {
    const b = domains.get(p.n.domain);
    const x1 = Math.min(b ? b.x : Number.POSITIVE_INFINITY, p.x - p.w / 2);
    const y1 = Math.min(b ? b.y : Number.POSITIVE_INFINITY, p.y - p.h / 2);
    const x2 = Math.max(b ? b.w : Number.NEGATIVE_INFINITY, p.x + p.w / 2);
    const y2 = Math.max(b ? b.h : Number.NEGATIVE_INFINITY, p.y + p.h / 2);
    domains.set(p.n.domain, { x: x1, y: y1, w: x2, h: y2 }); // holding x1,y1,x2,y2 for now
  }
  const PAD = 26;
  const LABEL = 26;
  const boxes = [...domains].map(([d, b]) => ({
    d,
    x: b.x - PAD,
    y: b.y - PAD - LABEL,
    w: b.w - b.x + PAD * 2,
    h: b.h - b.y + PAD * 2 + LABEL,
  }));

  const parts: string[] = [];

  // -- domain boxes
  for (const b of boxes) {
    const hue = hueOf(b.d);
    const sat = isCommon(b.d) ? 0 : 26;
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10"` +
        ` fill="${hsl(hue, sat, 13)}" fill-opacity="0.5"` +
        ` stroke="${hsl(hue, sat + 19, 42)}" stroke-width="1.5"/>`,
      `<text x="${b.x + 14}" y="${b.y + 20}" font-size="19" font-weight="bold"` +
        ` fill="${hsl(hue, sat + 29, 62)}">${esc(b.d)}</text>`,
    );
  }

  // -- edges. Violations and additions are drawn last so they sit on top
  const hasDelta = g.nodes.some((n) => n.status === "added" || n.status === "modified");
  const order = (e: Edge) => (e.violation ? 2 : e.status === "added" ? 1 : 0);
  for (const e of [...g.edges].sort((a, b) => order(a) - order(b))) {
    const s = at.get(e.src);
    const d = at.get(e.dst);
    if (!s || !d) continue;
    const st = EDGE[e.rel] ?? (EDGE.DEPENDS_ON as EdgeStyle);
    const a = { x: s.x, y: s.y };
    const b = { x: d.x, y: d.y };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Control point perpendicular from the midpoint — the same shape as
    // Cytoscape's unbundled-bezier
    const c =
      st.bow === 0
        ? mid
        : {
            x: mid.x + (-(b.y - a.y) / len) * st.bow * 2,
            y: mid.y + ((b.x - a.x) / len) * st.bow * 2,
          };
    const cut = trim(a, c, b, s, d);
    if (!cut) continue;

    const hue = hueOf(s.n.domain);
    let color = hsl(hue, e.crossDomain ? 62 : 22, e.crossDomain ? 58 : 46);
    let op = e.crossDomain ? 0.8 : 0.62;
    // In a delta picture, dim the unchanged relations further: a new line lost
    // among them defeats the point. Keep them as context, push them back.
    if (hasDelta && e.status === "existing") op *= 0.45;
    let width = st.width;
    let dash = st.dash;
    if (e.identifierOnly) {
      dash = "1 4";
      op = 0.4;
    }
    if (e.status === "added") {
      color = ADDED;
      op = 1;
    }
    if (e.violation) {
      color = VIOLATION;
      op = 1;
      width = 3.4;
    }

    const N = 26;
    const pts: Pt[] = [];
    for (let i = 0; i <= N; i++) pts.push(qbez(a, c, b, cut.t0 + ((cut.t1 - cut.t0) * i) / N));
    const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    parts.push(
      `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}"` +
        (dash ? ` stroke-dasharray="${dash}"` : "") +
        ` opacity="${op}"/>`,
    );

    const tip = pts[N] as Pt;
    const prev = pts[N - 2] as Pt;
    const dl = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    parts.push(
      `<g opacity="${op}">${arrowHead(tip, { x: (tip.x - prev.x) / dl, y: (tip.y - prev.y) / dl }, { ...st, width }, color)}</g>`,
    );

    if (e.violation) {
      const m = qbez(a, c, b, (cut.t0 + cut.t1) / 2);
      const tw = e.violation.length * 5.2 + 8;
      parts.push(
        `<rect x="${m.x - tw / 2}" y="${m.y - 8}" width="${tw}" height="15" rx="3" fill="${BG}" fill-opacity="0.85"/>`,
        `<text x="${m.x}" y="${m.y + 3.5}" font-size="10" fill="${VIOLATION}" text-anchor="middle">${esc(e.violation)}</text>`,
      );
    }
  }

  // -- nodes
  for (const p of placed) {
    const n = p.n;
    const hue = hueOf(n.domain);
    const sat = isCommon(n.domain) ? 0 : SATURATION[n.component];
    const outline = OUTLINE.includes(n.component);
    const body = shapePath(p);
    const fill = outline ? "none" : hsl(hue, sat, 46 - sat * 0.07);
    let stroke = hsl(hue, outline ? 48 : sat, outline ? 52 : 70);
    let sw = outline ? 1.4 : n.component === "Entity" ? 2.6 : n.component === "Service" ? 1.8 : 1;
    if (n.status === "added") {
      stroke = ADDED;
      sw = 3;
    } else if (n.status === "modified") {
      stroke = MODIFIED;
      sw = 2.6;
    }
    // One dash pattern only — SVG rejects the element on a duplicate attribute
    const dashed = n.status === "modified" ? "7 4" : outline ? "4 3" : "";
    const attrs =
      ` fill="${fill}" stroke="${stroke}" stroke-width="${sw}"` +
      (dashed ? ` stroke-dasharray="${dashed}"` : "");
    parts.push(body.replace("/>", `${attrs}/>`));

    const bold = n.component === "Entity";
    const fs = bold ? 12 : 11;
    parts.push(
      `<text x="${p.x}" y="${p.y + fs * 0.36}" font-size="${fs}" text-anchor="middle"` +
        (bold ? ` font-weight="bold"` : "") +
        ` fill="${outline ? hsl(hue, hue ? 52 : 0, 72) : "#fff"}">${esc(fit(n.name, p.w - 20, fs))}</text>`,
    );
  }

  // -- extent
  const xs = boxes.flatMap((b) => [b.x, b.x + b.w]);
  const ys = boxes.flatMap((b) => [b.y, b.y + b.h]);
  const M = 40;
  const minX = Math.min(...xs) - M;
  const minY = Math.min(...ys) - M;
  const gw = Math.max(...xs) - minX + M;
  const gh = Math.max(...ys) - minY + M;

  const head = header(g, opt.viewLabel ?? "", gw);
  const legend = legendBlock(g, gw, head.h + gh, hueOf);
  const total = head.h + gh + legend.h;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(gw)}" height="${Math.round(total)}"`,
    ` viewBox="0 0 ${Math.round(gw)} ${Math.round(total)}" font-family="${FONT}">`,
    `<rect width="100%" height="100%" fill="${BG}"/>`,
    head.svg,
    `<g transform="translate(${-minX},${head.h - minY})">`,
    ...parts,
    "</g>",
    legend.svg,
    "</svg>",
    "",
  ].join("\n");
}

function header(g: Graph, viewLabel: string, w: number): { svg: string; h: number } {
  const add = g.nodes.filter((n) => n.status === "added").length;
  const mod = g.nodes.filter((n) => n.status === "modified").length;
  const viol = g.edges.filter((e) => e.violation).length;
  const bits = [`${g.nodes.length} types`, `${g.edges.length} relations`];
  if (add || mod) bits.push(`${add} added · ${mod} modified`);
  bits.push(viol ? `${viol} violation${viol > 1 ? "s" : ""}` : "no violations");

  return {
    h: 78,
    svg: [
      `<text x="26" y="30" font-size="17" font-weight="bold" fill="${FG}">${esc(g.project)}</text>`,
      `<text x="${esc(String(26 + g.project.length * 10 + 12))}" y="30" font-size="12" fill="${DIM}">${esc(g.ref)}</text>`,
      `<text x="26" y="52" font-size="12" fill="${MUTED}">${esc(viewLabel)}</text>`,
      `<text x="${w - 26}" y="30" font-size="12" text-anchor="end" fill="${viol ? VIOLATION : MUTED}">${esc(bits.join("  ·  "))}</text>`,
      `<line x1="0" y1="66" x2="${w}" y2="66" stroke="${RULE}"/>`,
    ].join("\n"),
  };
}

function legendBlock(
  g: Graph,
  w: number,
  top: number,
  hueOf: (d: string) => number,
): { svg: string; h: number } {
  // Components in hexagonal order, so the legend itself teaches the inside-out reading
  const comps = [...new Set(g.nodes.map((n) => n.component))].sort((a, b) => LEVEL[a] - LEVEL[b]);
  const rels = [...new Set(g.edges.map((e) => e.rel))];
  const doms = [...new Set(g.nodes.map((n) => n.domain))].sort();
  const rows: string[] = [`<line x1="0" y1="${top}" x2="${w}" y2="${top}" stroke="${RULE}"/>`];
  let y = top + 26;

  // Components, drawn in their actual shape
  let x = 26;
  rows.push(`<text x="${x}" y="${y + 4}" font-size="11" fill="${DIM}">shape</text>`);
  x += 48;
  for (const c of comps) {
    const p: Placed = {
      n: { component: c, domain: "", name: "" } as Node,
      x: x + 16,
      y,
      w: 30,
      h: 15,
    };
    const outline = OUTLINE.includes(c);
    rows.push(
      shapePath(p).replace(
        "/>",
        ` fill="${outline ? "none" : MUTED}" stroke="${MUTED}" stroke-width="1.2"${outline ? ' stroke-dasharray="3 2"' : ""}/>`,
      ),
      `<text x="${x + 38}" y="${y + 4}" font-size="11" fill="${MUTED}">${c}</text>`,
    );
    x += 46 + c.length * 6.6;
  }

  // Relations — line style, curvature, arrowhead
  y += 26;
  x = 26;
  rows.push(`<text x="${x}" y="${y + 4}" font-size="11" fill="${DIM}">edge</text>`);
  x += 48;
  for (const r of rels) {
    const st = EDGE[r] as EdgeStyle;
    rows.push(
      `<path d="M${x},${y} L${x + 34},${y}" stroke="${MUTED}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""} fill="none"/>`,
      arrowHead({ x: x + 40, y }, { x: 1, y: 0 }, st, MUTED),
      `<text x="${x + 48}" y="${y + 4}" font-size="11" fill="${MUTED}">${r}</text>`,
    );
    x += 60 + r.length * 6.6;
  }
  rows.push(
    `<path d="M${x},${y} L${x + 34},${y}" stroke="${VIOLATION}" stroke-width="3.4" fill="none"/>`,
    `<text x="${x + 40}" y="${y + 4}" font-size="11" fill="${VIOLATION}">boundary violation</text>`,
  );
  x += 150;
  rows.push(
    `<rect x="${x}" y="${y - 7}" width="14" height="14" rx="3" fill="none" stroke="${ADDED}" stroke-width="3"/>`,
    `<text x="${x + 20}" y="${y + 4}" font-size="11" fill="${ADDED}">added</text>`,
    `<rect x="${x + 66}" y="${y - 7}" width="14" height="14" rx="3" fill="none" stroke="${MODIFIED}" stroke-width="2.6" stroke-dasharray="7 4"/>`,
    `<text x="${x + 86}" y="${y + 4}" font-size="11" fill="${MODIFIED}">modified</text>`,
  );

  // Domain colours
  y += 26;
  x = 26;
  rows.push(`<text x="${x}" y="${y + 4}" font-size="11" fill="${DIM}">domain</text>`);
  x += 48;
  for (const d of doms) {
    if (x > w - 160) {
      y += 20;
      x = 74;
    }
    rows.push(
      `<rect x="${x}" y="${y - 6}" width="11" height="11" rx="2" fill="${hsl(hueOf(d), isCommon(d) ? 0 : 60, 50)}"/>`,
      `<text x="${x + 16}" y="${y + 4}" font-size="11" fill="${MUTED}">${esc(d)}</text>`,
    );
    x += 24 + d.length * 6.6;
  }

  y += 24;
  rows.push(
    `<text x="26" y="${y + 4}" font-size="10" fill="${DIM}">` +
      "colour = domain · saturation = position in the hexagon (Entity darkest → outward lighter)" +
      " · coordinates are deterministic, so two branches line up</text>",
  );

  return { svg: rows.join("\n"), h: y + 22 - top };
}
