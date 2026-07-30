import { type Change, type Delta, type Graph, type Node, edgeKey, nodeIndex } from "./model.ts";

/**
 * The difference between two graphs. A branch diff is expressed with this.
 *
 * 'Modified' means structurally, not textually — the public contract changed,
 * or a relation came or went. A commit that only changes implementation detail
 * is not reported as modified, and that is correct — it left the shape alone.
 */
export function diff(base: Graph, head: Graph): Delta {
  const b = nodeIndex(base);
  const h = nodeIndex(head);

  const addedNodes = [...h.keys()].filter((id) => !b.has(id)).sort();
  const removedNodes = [...b.keys()].filter((id) => !h.has(id)).sort();

  const be = new Map(base.edges.map((e) => [edgeKey(e), e]));
  const he = new Map(head.edges.map((e) => [edgeKey(e), e]));
  const addedEdges = [...he].filter(([k]) => !be.has(k)).map(([, e]) => e);
  const removedEdges = [...be].filter(([k]) => !he.has(k)).map(([, e]) => e);

  // Nodes whose contract differs
  const contractChanged = new Set<string>();
  for (const [id, n] of h) {
    const o = b.get(id);
    if (!o) continue;
    if (o.api.join("\n") !== n.api.join("\n") || o.props.join("\n") !== n.props.join("\n")) {
      contractChanged.add(id);
    }
  }
  // Nodes that gained or lost a relation
  const touched = new Set<string>();
  for (const e of [...addedEdges, ...removedEdges]) {
    touched.add(e.src);
    touched.add(e.dst);
  }

  const added = new Set(addedNodes);
  const modifiedNodes = [...new Set([...contractChanged, ...touched])]
    .filter((id) => h.has(id) && !added.has(id))
    .sort();

  // What actually differs — without this, 'modified' still leaves a file to open
  const gone = <T>(from: T[], to: T[]) => {
    const s = new Set(to);
    return from.filter((x) => !s.has(x));
  };
  const changes = new Map<string, Change>();
  for (const id of modifiedNodes) {
    const o = b.get(id) as Node;
    const n = h.get(id) as Node;
    changes.set(id, {
      apiAdded: gone(n.api, o.api),
      apiRemoved: gone(o.api, n.api),
      propsAdded: gone(n.props, o.props),
      propsRemoved: gone(o.props, n.props),
      depsAdded: addedEdges.filter((e) => e.src === id).map((e) => e.dst),
      depsRemoved: removedEdges.filter((e) => e.src === id).map((e) => e.dst),
    });
  }

  // A new violation is not the same as a new edge — compare the sets directly
  const baseViol = new Set(base.edges.filter((e) => e.violation).map(edgeKey));
  const newViolations = new Set(
    head.edges.filter((e) => e.violation && !baseViol.has(edgeKey(e))).map(edgeKey),
  );

  return {
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdges,
    removedEdges,
    changes,
    newViolations,
  };
}

/** Stamp the delta onto node and edge status; the renderer reads that. */
export function applyStatus(head: Graph, d: Delta): Graph {
  const added = new Set(d.addedNodes);
  const modified = new Set(d.modifiedNodes);
  const addedE = new Set(d.addedEdges.map(edgeKey));
  return {
    ...head,
    nodes: head.nodes.map((n) => ({
      ...n,
      status: added.has(n.id) ? "added" : modified.has(n.id) ? "modified" : "existing",
      ...(d.changes.get(n.id) ? { change: d.changes.get(n.id) } : {}),
    })),
    edges: head.edges.map((e) => ({
      ...e,
      status: addedE.has(edgeKey(e)) ? ("added" as const) : ("existing" as const),
      ...(d.newViolations.has(edgeKey(e)) ? { newViolation: true } : {}),
    })),
  };
}
