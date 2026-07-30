import type { Component, Edge, Graph, Node } from "./model.ts";

/**
 * Graph queries, shared by the CLI and the MCP server.
 *
 * Every answer carries the contract, the location and the role together, so it
 * stands on its own — or says exactly which file to open when it does not.
 */
export class GraphQuery {
  readonly graph: Graph;
  private byId: Map<string, Node>;
  private out: Map<string, Edge[]>;
  private inc: Map<string, Edge[]>;

  constructor(graph: Graph) {
    this.graph = graph;
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    this.out = new Map();
    this.inc = new Map();
    for (const e of graph.edges) {
      push(this.out, e.src, e);
      push(this.inc, e.dst, e);
    }
  }

  /** Find nodes by partial name or FQCN, or filter by component and domain. */
  find(q: {
    query?: string;
    domain?: string;
    component?: Component;
    limit?: number;
  }): Node[] {
    const needle = q.query?.toLowerCase();
    const hits = this.graph.nodes.filter((n) => {
      if (q.domain && n.domain !== q.domain) return false;
      if (q.component && n.component !== q.component) return false;
      if (!needle) return true;
      return n.name.toLowerCase().includes(needle) || n.id.toLowerCase().includes(needle);
    });
    // exact name matches first
    hits.sort((a, b) => {
      const ea = a.name.toLowerCase() === needle ? 0 : 1;
      const eb = b.name.toLowerCase() === needle ? 0 : 1;
      return ea - eb || a.name.length - b.name.length;
    });
    return hits.slice(0, q.limit ?? 40);
  }

  /** Resolve one node from an exact name or FQCN. Ambiguity returns candidates. */
  resolve(name: string): { node?: Node; candidates: Node[] } {
    const exact = this.byId.get(name);
    if (exact) return { node: exact, candidates: [] };
    const byName = this.graph.nodes.filter((n) => n.name === name);
    if (byName.length === 1) return { node: byName[0] as Node, candidates: [] };
    if (byName.length > 1) return { candidates: byName };
    return { candidates: this.find({ query: name, limit: 8 }) };
  }

  node(id: string): Node | undefined {
    return this.byId.get(id);
  }

  outgoing(id: string): Edge[] {
    return this.out.get(id) ?? [];
  }

  incoming(id: string): Edge[] {
    return this.inc.get(id) ?? [];
  }

  /** What a change to this node reaches — reverse dependencies, N hops out. */
  impact(id: string, hops = 2): { hop: number; node: Node }[] {
    const seen = new Set([id]);
    const out: { hop: number; node: Node }[] = [];
    let frontier = [id];
    for (let h = 1; h <= hops; h++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of this.incoming(cur)) {
          if (seen.has(e.src)) continue;
          seen.add(e.src);
          next.push(e.src);
          const n = this.byId.get(e.src);
          if (n) out.push({ hop: h, node: n });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return out;
  }

  /** Whether this graph can be compared against a base (built with --base). */
  get hasBase(): boolean {
    return this.graph.nodes.some((n) => n.status !== undefined);
  }

  violations(scope: "all" | "delta" = "all"): Edge[] {
    return this.graph.edges.filter(
      (e) => e.violation && (scope === "all" || e.newViolation === true),
    );
  }

  /** Which declared methods each consumer actually calls — the ISP signal. */
  contractUsage(id: string): {
    declared: string[];
    consumers: { name: string; used: string[] }[];
    unusedByAll: string[];
  } {
    const target = this.byId.get(id);
    const declared = target?.api ?? [];
    const consumers = this.incoming(id)
      .filter((e) => e.contracts.length)
      .map((e) => ({ name: this.byId.get(e.src)?.name ?? e.src, used: e.contracts }));
    const usedNames = new Set(consumers.flatMap((c) => c.used.map(methodName)));
    return {
      declared,
      consumers,
      unusedByAll: declared.filter((d) => !usedNames.has(methodName(d))),
    };
  }

  delta(): { added: Node[]; modified: Node[]; addedEdges: Edge[] } {
    return {
      added: this.graph.nodes.filter((n) => n.status === "added"),
      modified: this.graph.nodes.filter((n) => n.status === "modified"),
      addedEdges: this.graph.edges.filter((e) => e.status === "added"),
    };
  }
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

const methodName = (sig: string): string => {
  const i = sig.indexOf("(");
  return i > 0 ? sig.slice(0, i) : sig;
};
