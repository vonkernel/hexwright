import type { Graph, Node } from "./model.ts";

/**
 * What one bounded context uses from another.
 *
 * The graph can already answer this, but only by reading a layout: the crossings
 * are edges among everything else. What a reviewer wants is the sentence — this
 * consumer class, which implements that port on its own side, calls these
 * operations on that provider interface, which these classes implement.
 *
 * Two domains are named with roles rather than as a pair. Drawing whatever runs
 * between two names leaves the ambiguous cases ambiguous; saying which one provides
 * makes the answer a statement.
 *
 * Derivation only. Three surfaces render it — an image for a pull request, a tab
 * for looking, an MCP tool for an agent — and none of them belong here.
 */

/** An operation on a provider interface, and whether the consumer reaches for it. */
export interface Operation {
  /** the signature as the provider declares it */
  sig: string;
  /**
   * False when the provider offers it and this consumer never calls it. Kept rather
   * than dropped: it says whether the consumer is using the right part of the
   * contract, which is a question worth being able to ask.
   */
  used: boolean;
}

/** One consumer type's use of a provider interface. */
export interface Consumer {
  type: Node;
  /** what this type implements on its own side — its role, in its own domain */
  implementsTypes: Node[];
  /** the provider operations it calls */
  calls: string[];
  /** its own methods that do the calling, and what each reaches */
  from: { method: string; to: string[] }[];
}

/** One provider interface, with everyone on both sides of it. */
export interface Contract {
  iface: Node;
  operations: Operation[];
  consumers: Consumer[];
  /**
   * Implementations of this interface inside the provider. Empty is information
   * rather than an error — it is implemented in another module, or not yet.
   */
  implementations: Node[];
}

/** A cross-context use that runs through an identifier rather than a contract. */
export interface IdReference {
  from: Node;
  /** the provider aggregate the identifier identifies */
  to: Node;
}

export interface Exchange {
  provider: string;
  consumer: string;
  contracts: Contract[];
  /**
   * Held by id, not called. A different kind of coupling — a contract dependency
   * binds you to the other domain's API, an id reference is what you do to avoid
   * that — so it is reported apart from the contracts rather than among them.
   */
  idReferences: IdReference[];
  /** True when the consumer uses nothing from the provider at all. */
  empty: boolean;
}

/** Interfaces are what a domain offers another; nothing else is a contract. */
const OFFERABLE = new Set(["UseCase", "Port"]);

export function exchange(g: Graph, provider: string, consumer: string): Exchange {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const at = (id: string) => byId.get(id);

  const contracts = new Map<string, Contract>();
  const idReferences: IdReference[] = [];

  for (const e of g.edges) {
    const s = at(e.src);
    const d = at(e.dst);
    if (!s || !d || s.domain !== consumer || d.domain !== provider) continue;

    if (e.rel === "REFERENCES") {
      // A REFERENCES edge always lands on an aggregate — its destination is the type
      // declaring the identifier — so it can never be one of the contracts above.
      idReferences.push({ from: s, to: d });
      continue;
    }
    if (e.rel !== "DEPENDS_ON" || !OFFERABLE.has(d.component)) continue;

    const c = contracts.get(d.id) ?? {
      iface: d,
      operations: d.api.map((sig) => ({ sig, used: false })),
      consumers: [],
      implementations: g.edges
        .filter((x) => x.rel === "IMPLEMENTS" && x.dst === d.id)
        .map((x) => at(x.src))
        .filter((n): n is Node => !!n && n.domain === provider)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    for (const op of c.operations) if (e.contracts.includes(op.sig)) op.used = true;
    c.consumers.push({
      type: s,
      implementsTypes: g.edges
        .filter((x) => x.rel === "IMPLEMENTS" && x.src === s.id)
        .map((x) => at(x.dst))
        .filter((n): n is Node => !!n)
        .sort((a, b) => a.name.localeCompare(b.name)),
      calls: [...e.contracts].sort(),
      from: e.calls.map((c2) => ({ method: c2.from, to: c2.to })),
    });
    contracts.set(d.id, c);
  }

  const ordered = [...contracts.values()].sort((a, b) => a.iface.name.localeCompare(b.iface.name));
  for (const c of ordered) c.consumers.sort((a, b) => a.type.name.localeCompare(b.type.name));
  idReferences.sort(
    (a, b) => a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name),
  );

  return {
    provider,
    consumer,
    contracts: ordered,
    idReferences,
    empty: !ordered.length && !idReferences.length,
  };
}
