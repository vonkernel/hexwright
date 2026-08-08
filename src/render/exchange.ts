import type { Exchange } from "../interface.ts";
import { hueMap } from "../view/layout.ts";
import { BG, DIM, FG, FONT, MUTED, RULE, esc, fit, textWidth } from "./paint.ts";

/**
 * The interface view, drawn straight to SVG.
 *
 * Three columns with the provider's contract in the middle, because the sentence
 * being answered has three parts: this consumer, which implements that on its own
 * side, calls these operations, which those classes implement. A force layout would
 * scatter that; the columns are the answer's own shape.
 *
 * Colours and type come from the same place as the graph renderer. The two pictures
 * are read side by side and must not disagree about what a colour means.
 */

const W = 1280;
const LEFT = 40; // consumer column, right-aligned at LEFT + LEFT_W
const LEFT_W = 300;
const CX = 470; // contract box
const CW = 380;
const RX = 900; // implementations
const ROW = 21;
const HEAD = 30;
const GAP = 40;

/** Consumer and provider get their own domain hues, as everywhere else. */
export function renderExchange(x: Exchange): string {
  const hueOf = hueMap([x.provider, x.consumer]);
  const prov = `hsl(${hueOf(x.provider)},62%,60%)`;
  const cons = `hsl(${hueOf(x.consumer)},62%,62%)`;
  const provDim = `hsl(${hueOf(x.provider)},28%,14%)`;

  const parts: string[] = [];
  let y = 132;

  for (const c of x.contracts) {
    const opRows = new Map<string, number>();
    const boxH = HEAD + c.operations.length * ROW + 14;

    parts.push(
      `<rect x="${CX}" y="${y}" width="${CW}" height="${boxH}" rx="8" fill="${provDim}" stroke="${prov}" stroke-width="1.8"/>`,
      `<text x="${CX + 16}" y="${y + 21}" font-size="14" font-weight="bold" fill="${prov}">${esc(fit(c.iface.name, CW - 110, 14))}</text>`,
      `<text x="${CX + CW - 16}" y="${y + 21}" font-size="10" text-anchor="end" fill="${DIM}">${esc(c.iface.component)}</text>`,
      `<line x1="${CX}" y1="${y + HEAD - 2}" x2="${CX + CW}" y2="${y + HEAD - 2}" stroke="${RULE}"/>`,
    );
    c.operations.forEach((op, i) => {
      const ry = y + HEAD + i * ROW + 14;
      opRows.set(op.sig, ry);
      // Offered and never called: kept, dimmed. It answers whether the consumer is
      // using the right part of the contract.
      parts.push(
        `<circle cx="${CX + 18}" cy="${ry - 4}" r="3" fill="${op.used ? prov : "none"}" stroke="${op.used ? prov : DIM}"/>`,
        `<text x="${CX + 30}" y="${ry}" font-size="11.5" fill="${op.used ? FG : DIM}">${esc(fit(op.sig, CW - 46, 11.5))}</text>`,
      );
    });

    // -- consumers, right-aligned so the names sit against the arrows
    let cy = y + HEAD + 8;
    for (const u of c.consumers) {
      const edge = LEFT + LEFT_W;
      parts.push(
        `<text x="${edge}" y="${cy}" font-size="12.5" text-anchor="end" fill="${cons}" font-weight="bold">${esc(fit(u.type.name, LEFT_W, 12.5))}</text>`,
        `<text x="${edge}" y="${cy + 14}" font-size="10.5" text-anchor="end" fill="${DIM}">${
          u.implementsTypes.length
            ? esc(fit(`: ${u.implementsTypes.map((t) => t.name).join(", ")}`, LEFT_W, 10.5))
            : "—"
        }</text>`,
      );
      let my = cy + 28;
      for (const f of u.from) {
        const label = f.method || "outside any method";
        parts.push(
          `<text x="${edge}" y="${my}" font-size="10" text-anchor="end" fill="${MUTED}">${esc(fit(label, LEFT_W - 8, 10))}</text>`,
        );
        // One line per operation this method reaches, landing on that row.
        for (const t of f.to) {
          const ry = opRows.get(t);
          if (ry === undefined) continue;
          const x1 = edge + 10;
          parts.push(
            `<path d="M${x1},${my - 3} C${(x1 + CX) / 2},${my - 3} ${(x1 + CX) / 2},${ry - 4} ${CX - 7},${ry - 4}" fill="none" stroke="${cons}" stroke-width="1.4" opacity="0.8"/>`,
            `<path d="M${CX - 6},${ry - 4} l-7,-3.4 l0,6.8 z" fill="${cons}"/>`,
          );
        }
        my += 14;
      }
      cy = Math.max(my + 12, cy + 46);
    }

    // -- implementations. None is information: elsewhere, or not yet.
    if (c.implementations.length) {
      c.implementations.forEach((im, i) => {
        const iy = y + HEAD + i * (ROW + 4) + 8;
        parts.push(
          `<path d="M${RX + 16},${iy - 4} L${CX + CW + 8},${iy - 4}" stroke="${prov}" stroke-width="1.4" stroke-dasharray="7 4" opacity="0.8" fill="none"/>`,
          `<path d="M${CX + CW + 6},${iy - 4} l9,-4.5 l0,9 z" fill="none" stroke="${prov}" stroke-width="1.3"/>`,
          `<text x="${RX + 24}" y="${iy}" font-size="12.5" fill="${prov}">${esc(fit(im.name, W - RX - 64, 12.5))}</text>`,
        );
      });
    } else {
      parts.push(
        `<text x="${RX + 24}" y="${y + HEAD + 8}" font-size="11" fill="${DIM}">no implementation here</text>`,
        `<text x="${RX + 24}" y="${y + HEAD + 23}" font-size="10" fill="${DIM}">another module, or not yet</text>`,
      );
    }

    y = Math.max(cy, y + boxH, y + HEAD + c.implementations.length * (ROW + 4)) + GAP;
  }

  // -- what is held by id rather than called
  if (x.idReferences.length) {
    parts.push(
      `<line x1="${LEFT}" y1="${y - 14}" x2="${W - LEFT}" y2="${y - 14}" stroke="${RULE}"/>`,
      `<text x="${LEFT}" y="${y + 6}" font-size="11" fill="${MUTED}">held by id, not called — a reference to the aggregate, no contract between them</text>`,
    );
    y += 22;
    for (const r of x.idReferences) {
      parts.push(
        `<text x="${LEFT}" y="${y}" font-size="12" fill="${cons}">${esc(r.from.name)}</text>`,
        `<text x="${LEFT + textWidth(r.from.name, 12) + 10}" y="${y}" font-size="12" fill="${DIM}">→</text>`,
        `<text x="${LEFT + textWidth(r.from.name, 12) + 28}" y="${y}" font-size="12" fill="${prov}">${esc(r.to.name)}</text>`,
      );
      y += 19;
    }
    y += 8;
  }

  // -- nothing at all is an answer, and it gets a sentence
  if (x.empty) {
    parts.push(
      `<text x="${LEFT}" y="${y + 10}" font-size="14" fill="${FG}">${esc(x.consumer)} uses nothing from ${esc(x.provider)}.</text>`,
      `<text x="${LEFT}" y="${y + 34}" font-size="11.5" fill="${DIM}">No contract is called and no aggregate is referenced by id. Try the other direction.</text>`,
    );
    y += 56;
  }

  const H = y + 34;
  const head = [
    `<text x="${LEFT}" y="42" font-size="18" font-weight="bold" fill="${FG}">${esc(x.consumer)} → ${esc(x.provider)}</text>`,
    `<text x="${LEFT}" y="66" font-size="12.5" fill="${MUTED}">what ${esc(x.consumer)} uses from ${esc(x.provider)}</text>`,
    `<text x="${LEFT + LEFT_W}" y="105" font-size="11" text-anchor="end" fill="${cons}" font-weight="bold">CONSUMER · ${esc(x.consumer)}</text>`,
    `<text x="${CX + 16}" y="105" font-size="11" fill="${prov}" font-weight="bold">PROVIDES</text>`,
    `<text x="${RX + 16}" y="105" font-size="11" fill="${prov}" font-weight="bold">IMPLEMENTED BY</text>`,
    `<line x1="${LEFT}" y1="114" x2="${W - LEFT}" y2="114" stroke="${RULE}"/>`,
    `<text x="${LEFT}" y="${H - 12}" font-size="10.5" fill="${DIM}">filled = called · hollow = offered, unused · a line runs from the method that calls it</text>`,
  ].join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H)}" viewBox="0 0 ${W} ${Math.round(H)}" font-family="${FONT}">`,
    `<rect width="100%" height="100%" fill="${BG}"/>`,
    head,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}
