import type { Graph, Node } from "../model.ts";
import { CORE } from "../view/layout.ts";

/**
 * Choosing what goes into the image.
 *
 * The whole graph is hundreds of nodes and unreadable as a picture. What a PR
 * review actually needs is what this branch built, so delta is the default.
 */
export type View = "delta" | "impact" | "core" | "all" | `domain:${string}`;

export interface Selection {
  graph: Graph;
  /** Human-readable description of the view, printed in the image header. */
  label: string;
}

export function select(g: Graph, view: View, showIdentifiers = false): Selection {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const real = g.edges.filter((e) => showIdentifiers || !e.identifierOnly);

  /** One hop out, in both directions. */
  const withNeighbours = (seed: Set<string>): Set<string> => {
    const out = new Set(seed);
    for (const e of real) {
      if (seed.has(e.src) && byId.has(e.dst)) out.add(e.dst);
      if (seed.has(e.dst) && byId.has(e.src)) out.add(e.src);
    }
    return out;
  };

  /** Changed types, plus the far end of any relation the branch introduced. */
  const changedSet = (): Set<string> => {
    const seed = new Set(
      g.nodes.filter((n) => n.status === "added" || n.status === "modified").map((n) => n.id),
    );
    if (!seed.size) throw new Error("no structural change on this branch — nothing to render");
    // The far end of a new relation may be an unchanged type; it is still part
    // of the wiring, so keep it.
    for (const e of real) {
      if (e.status !== "added") continue;
      if (seed.has(e.src) && byId.has(e.dst)) seed.add(e.dst);
      if (seed.has(e.dst) && byId.has(e.src)) seed.add(e.src);
    }
    return seed;
  };

  /** What depends on a changed type — the reach of this change. */
  const dependents = (seed: Set<string>): Set<string> => {
    const out = new Set(seed);
    for (const e of real) if (seed.has(e.dst) && byId.has(e.src)) out.add(e.src);
    return out;
  };

  let keep: Set<string>;
  let label: string;

  if (view === "all") {
    keep = new Set(g.nodes.map((n) => n.id));
    label = "all types";
  } else if (view === "core") {
    keep = new Set(g.nodes.filter((n) => CORE.includes(n.component)).map((n) => n.id));
    label = "core — Entity · Service · UseCase · Port · Event";
  } else if (view.startsWith("domain:")) {
    const d = view.slice(7);
    const seed = new Set(g.nodes.filter((n) => n.domain === d).map((n) => n.id));
    if (!seed.size) throw new Error(`no such domain: ${d}`);
    keep = withNeighbours(seed);
    label = `domain ${d} and what it touches`;
  } else if (view === "impact") {
    keep = dependents(changedSet());
    label = "what this branch changed, and everything that depends on it";
  } else {
    keep = changedSet();
    // A contract-only change leaves a row of boxes with no lines between them.
    // Only then widen to the dependents so the picture says something.
    const linked = real.filter((e) => keep.has(e.src) && keep.has(e.dst)).length;
    if (linked) {
      label = "what this branch added and changed";
    } else {
      keep = dependents(keep);
      label = "what this branch changed (no new relations — showing dependents)";
    }
  }

  const nodes: Node[] = g.nodes.filter((n) => keep.has(n.id));
  const edges = real.filter((e) => keep.has(e.src) && keep.has(e.dst));
  return { graph: { ...g, nodes, edges }, label };
}
