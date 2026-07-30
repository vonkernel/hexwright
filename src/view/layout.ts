import type { Component, Graph, Node } from "../model.ts";

/**
 * Coordinates. Deterministic, so the same graph always lands in the same place —
 * which is what makes two branches comparable.
 *
 * The hexagonal layout gives each domain concentric rings, stacked from the
 * centre outward: Entity, Service, UseCase, Port, DTO and VO.
 * The rings themselves are placed by a coupling-driven force, so entangled
 * domains sit close together.
 */

/** Ring level — lower is closer to the domain's centre. */
export const LEVEL: Record<Component, number> = {
  Entity: 0,
  Service: 1,
  Event: 1,
  UseCase: 2,
  Port: 3,
  DTO: 4,
  VO: 4,
  Error: 4,
  Shared: 4,
  Adapter: 5,
};

/** Saturation: dark at the core, lighter outward. 0 leaves the background unpainted. */
export const SATURATION: Record<Component, number> = {
  Entity: 95,
  Service: 72,
  Event: 60,
  UseCase: 48,
  Port: 30,
  DTO: 0,
  VO: 0,
  Error: 0,
  Shared: 22,
  Adapter: 18,
};

/** Shape. Saturation alone does not separate the four core components. */
export const SHAPE: Record<Component, string> = {
  Entity: "barrel",
  Service: "rectangle",
  UseCase: "round-rectangle",
  Port: "cut-rectangle",
  Event: "rhomboid",
  DTO: "round-rectangle",
  VO: "round-rectangle",
  Error: "round-rectangle",
  Shared: "round-rectangle",
  Adapter: "round-rectangle",
};

export const CORE: Component[] = ["Entity", "Service", "UseCase", "Port", "Event"];

/** Components drawn as an outline with no fill. */
export const OUTLINE: Component[] = ["DTO", "VO", "Error"];

/**
 * The hue band domains may use. Everything outside it — red, orange, pink-red —
 * is reserved for status: mixing a domain hue with violation #f85149 or added
 * #f0883e destroys the at-a-glance reading.
 */
const HUE_FLOOR = 42;
const HUE_CEIL = 338;
/** Minimum separation between two domain hues. */
const HUE_SEP = 15;

/** Name hash to hue, spread by the golden ratio so neighbouring names differ. */
function rawHue(domain: string): number {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) | 0;
  const frac = Math.abs((h * 0.6180339887) % 1);
  return Math.round(HUE_FLOOR + frac * (HUE_CEIL - HUE_FLOOR));
}

const circDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/**
 * Domain to hue. Assigned by name hash, but nudged to a free slot when it lands
 * too close to one already taken.
 *
 * With a dozen-plus domains, hashing alone collides within a degree or two by
 * chance and "colour means domain" stops holding. Processing in name order keeps
 * the assignment stable for a given set of domains.
 */
export function hueMap(domains: Iterable<string>): (domain: string) => number {
  const names = [...new Set(domains)].filter((d) => !isCommon(d)).sort();
  const taken: number[] = [];
  const out = new Map<string, number>();
  const span = HUE_CEIL - HUE_FLOOR;
  for (const d of names) {
    const start = rawHue(d);
    let hue = start;
    for (let step = 0; step < span; step++) {
      const cand = HUE_FLOOR + ((start - HUE_FLOOR + step) % span);
      if (taken.every((t) => circDist(t, cand) >= HUE_SEP)) {
        hue = cand;
        break;
      }
    }
    taken.push(hue);
    out.set(d, hue);
  }
  return (d) => (isCommon(d) ? 0 : (out.get(d) ?? rawHue(d)));
}

export const isCommon = (domain: string): boolean => domain === "common" || domain === "shared";

const NODE_W = 190;
const NODE_H = 40;
const RING_GAP = 230;
const ARC = 268;
/** Gap left between domain boxes. A box is the compound border plus its label. */
const DOMAIN_GAP = 130;
const BOX_PAD = 34;
const LABEL_H = 30;

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

/** One domain laid out: relative positions, and the half-extents of the box drawn around them. */
interface Cluster {
  pos: Map<string, [number, number]>;
  hw: number;
  hh: number;
}

/** Concentric rings for one domain; each radius grows with that ring's node count. */
function concentric(nodes: Node[]): Cluster {
  const rings = new Map<number, Node[]>();
  for (const n of nodes) {
    const lv = LEVEL[n.component];
    rings.set(lv, [...(rings.get(lv) ?? []), n]);
  }
  const pos = new Map<string, [number, number]>();
  let prev = 0;
  for (const lv of [...rings.keys()].sort((a, b) => a - b)) {
    const ring = rings.get(lv) as Node[];
    const need = (ring.length * ARC) / (2 * Math.PI);
    const r = lv === 0 && ring.length === 1 ? 0 : Math.max(prev + RING_GAP, need, 170);
    ring.forEach((n, i) => {
      if (r === 0) pos.set(n.id, [0, 0]);
      else {
        const a = (2 * Math.PI * i) / ring.length - Math.PI / 2;
        pos.set(n.id, [r * Math.cos(a), r * Math.sin(a)]);
      }
    });
    prev = r;
  }
  // Size the box from the actual node positions, not the radius: a ring with a
  // couple of nodes has a big circle and a small box. Placement then matches
  // what is drawn.
  let hw = 0;
  let hh = 0;
  for (const [x, y] of pos.values()) {
    hw = Math.max(hw, Math.abs(x));
    hh = Math.max(hh, Math.abs(y));
  }
  return { pos, hw: hw + NODE_W / 2 + BOX_PAD, hh: hh + NODE_H / 2 + BOX_PAD + LABEL_H / 2 };
}

/**
 * Place domain boxes by coupling — push when they overlap, pull when entangled.
 *
 * Separation is axis-aligned rectangles, not circles. What gets drawn is a
 * compound rectangle, so separating circles leaves corners overlapping and a
 * node appears to sit inside someone else's box. A final pass separates until
 * nothing overlaps, making that an invariant.
 */
function placeDomains(g: Graph, box: Map<string, { hw: number; hh: number }>, gap = DOMAIN_GAP) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const link = new Map<string, number>();
  for (const e of g.edges) {
    const a = byId.get(e.src)?.domain;
    const b = byId.get(e.dst)?.domain;
    if (!a || !b || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    link.set(k, (link.get(k) ?? 0) + 1);
  }

  const size = (d: string) => box.get(d) ?? { hw: 0, hh: 0 };
  const area = (d: string) => size(d).hw * size(d).hh;
  // Largest domains innermost; the small ones fill the gaps
  const doms = [...box.keys()].sort((a, b) => area(b) - area(a));

  const P = new Map<string, [number, number]>();
  let r = 0;
  let ang = 0;
  doms.forEach((d, i) => {
    if (i === 0) {
      P.set(d, [0, 0]);
      return;
    }
    r += Math.hypot(size(d).hw, size(d).hh) * 0.95;
    ang += 2.399963; // golden angle — fewer initial overlaps
    P.set(d, [r * Math.cos(ang), r * Math.sin(ang)]);
  });

  /** Separate overlapping pairs along the minimum-translation axis. Returns the
   * largest overlap left. */
  const separate = (step: number): number => {
    let worst = 0;
    for (let i = 0; i < doms.length; i++) {
      const a = doms[i] as string;
      for (let j = i + 1; j < doms.length; j++) {
        const b = doms[j] as string;
        const pa = P.get(a) as [number, number];
        const pb = P.get(b) as [number, number];
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const ox = size(a).hw + size(b).hw + gap - Math.abs(dx);
        const oy = size(a).hh + size(b).hh + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        worst = Math.max(worst, Math.min(ox, oy));
        const shift = Math.min(ox, oy) * step;
        if (ox < oy) {
          const s = dx >= 0 ? 1 : -1;
          pa[0] -= s * shift;
          pb[0] += s * shift;
        } else {
          const s = dy >= 0 ? 1 : -1;
          pa[1] -= s * shift;
          pb[1] += s * shift;
        }
      }
    }
    return worst;
  };

  // Phase 1 — pull by coupling while separating
  for (let iter = 0; iter < 400; iter++) {
    for (let i = 0; i < doms.length; i++) {
      const a = doms[i] as string;
      for (let j = i + 1; j < doms.length; j++) {
        const b = doms[j] as string;
        const w = link.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
        const pa = P.get(a) as [number, number];
        const pb = P.get(b) as [number, number];
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const dist = Math.hypot(dx, dy) || 1;
        const ox = size(a).hw + size(b).hw + gap - Math.abs(dx);
        const oy = size(a).hh + size(b).hh + gap - Math.abs(dy);
        if (ox > 0 && oy > 0) continue; // overlapping pairs are separate()'s job
        const slack = -Math.min(ox, oy);
        const pull = Math.min(slack * (w ? 0.06 * Math.log1p(w) : 0.006), 90);
        P.set(a, [pa[0] + (dx / dist) * pull, pa[1] + (dy / dist) * pull]);
        P.set(b, [pb[0] - (dx / dist) * pull, pb[1] - (dy / dist) * pull]);
      }
    }
    separate(0.5);
    for (const d of doms) {
      const p = P.get(d) as [number, number];
      p[0] -= p[0] * 0.004; // weak gravity toward the origin
      p[1] -= p[1] * 0.004;
    }
  }

  // Phase 2 — drop the pull and separate until nothing overlaps
  for (let iter = 0; iter < 600 && separate(0.5) > 0.5; iter++);
  return P;
}

/** Hexagonal coordinates: concentric rings per domain, boxes placed by force. */
export function hexLayout(g: Graph): Positioned[] {
  const byDomain = new Map<string, Node[]>();
  for (const n of g.nodes) byDomain.set(n.domain, [...(byDomain.get(n.domain) ?? []), n]);

  const local = new Map<string, Map<string, [number, number]>>();
  const box = new Map<string, { hw: number; hh: number }>();
  for (const [d, ns] of byDomain) {
    const c = concentric(ns);
    local.set(d, c.pos);
    box.set(d, { hw: c.hw, hh: c.hh });
  }
  const centers = placeDomains(g, box);

  const out: Positioned[] = [];
  for (const [d, pos] of local) {
    const [cx, cy] = centers.get(d) ?? [0, 0];
    for (const [id, [x, y]] of pos) out.push({ id, x: Math.round(cx + x), y: Math.round(cy + y) });
  }
  return out;
}

const COL_W = NODE_W + 54;
const ROW_H = 74;

interface Block {
  d: string;
  items: Node[];
  cols: number;
  w: number;
  h: number;
}

/** One domain as a dense block, ordered the hexagonal way: inside out. */
function blockOf(d: string, ns: Node[]): Block {
  const items = [...ns].sort(
    (a, b) => LEVEL[a.component] - LEVEL[b.component] || a.name.localeCompare(b.name),
  );
  const cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(items.length / 2.2))));
  const rows = Math.ceil(items.length / cols);
  return { d, items, cols, w: cols * COL_W + 80, h: rows * ROW_H + 92 };
}

/**
 * Organic coordinates: a dense block inside each domain, coupling force between them.
 *
 * For a small subgraph such as a delta. Concentric rings make the box large and
 * mostly empty so the nodes look scattered; the grid orders domains without
 * regard to coupling so the lines cross the picture. Dense blocks placed by how
 * much they actually couple read as short lines — the same idea as the web UI's
 * "organic on hexagonal".
 */
export function organicLayout(g: Graph): Positioned[] {
  const byDomain = new Map<string, Node[]>();
  for (const n of g.nodes) byDomain.set(n.domain, [...(byDomain.get(n.domain) ?? []), n]);

  const blocks = [...byDomain].map(([d, ns]) => blockOf(d, ns));
  const box = new Map(blocks.map((b) => [b.d, { hw: b.w / 2, hh: b.h / 2 }]));
  // Tighter than on screen: this is an image, and whitespace costs when it scales down
  const centers = placeDomains(g, box, 70);

  const out: Positioned[] = [];
  for (const b of blocks) {
    const [cx, cy] = centers.get(b.d) ?? [0, 0];
    b.items.forEach((n, i) => {
      out.push({
        id: n.id,
        x: Math.round(cx - b.w / 2 + 40 + (i % b.cols) * COL_W + NODE_W / 2),
        y: Math.round(cy - b.h / 2 + 52 + Math.floor(i / b.cols) * ROW_H),
      });
    });
  }
  return out;
}

/**
 * Grid coordinates: domain blocks shelved left to right. For scanning like a list.
 *
 * maxWidth decides when a block wraps to the next row. For an image, shrink it
 * to get something tall rather than wide — a wide picture is scaled down to the
 * width of a PR comment until the labels are unreadable.
 */
export function gridLayout(g: Graph, maxWidth = 3000): Positioned[] {
  const byDomain = new Map<string, Node[]>();
  for (const n of g.nodes) byDomain.set(n.domain, [...(byDomain.get(n.domain) ?? []), n]);

  const blocks = [...byDomain.entries()]
    .map(([d, ns]) => blockOf(d, ns))
    .sort((a, b) => b.items.length - a.items.length);

  const MAXW = maxWidth;
  const out: Positioned[] = [];
  let y = 0;
  let x = 0;
  let rowH = 0;
  for (const b of blocks) {
    if (x + b.w > MAXW && x > 0) {
      y += rowH + 90;
      x = 0;
      rowH = 0;
    }
    b.items.forEach((n, i) => {
      out.push({
        id: n.id,
        x: Math.round(x + 40 + (i % b.cols) * (NODE_W + 54) + NODE_W / 2),
        y: Math.round(y + 52 + Math.floor(i / b.cols) * 74),
      });
    });
    x += b.w + 70;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}
