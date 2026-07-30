/**
 * The neutral graph model. These types are the format spec.
 *
 * A per-language extractor only has to produce this shape; verification,
 * rendering and loading never learn the language.
 * The rule: only relations that exist in the source. Nothing derived, nothing inferred.
 */

/** Hexagonal component. With the domain, one of a node's two axes. */
export type Component =
  | "Entity" // aggregate root — the centre of its domain
  | "VO" // value object, identifier, enum
  | "Service" // implements a use case
  | "UseCase" // inbound port
  | "Port" // outbound port
  | "Event" // domain event
  | "DTO" // data that crosses a boundary
  | "Error"
  | "Shared"
  | "Adapter";

/** Adapter direction. Outbound implements a port so it may handle aggregates;
 * inbound may not. */
export type AdapterKind = "in" | "out" | "event" | "";

export type Relation = "IMPLEMENTS" | "EXTENDS" | "DEPENDS_ON";

/** Status within a branch delta. */
export type Status = "existing" | "added" | "modified" | "removed";

export interface Node {
  /** Globally unique key — an FQCN, a module path, whatever the language uses. */
  id: string;
  name: string;
  /** Bounded context. */
  domain: string;
  component: Component;
  /** Source layer directory: application, domain, adapter, common. */
  layer: string;
  /** Subdivision within the layer: port/inbound, service, model, … */
  sublayer: string;
  /** Language construct (class, interface, data class) — keeps the basis for
   * the classification visible. */
  kind: string;
  adapterKind: AdapterKind;
  /** Public contract. With it, a consumer never has to open the file. */
  api: string[];
  /** Public properties, constructor parameters, enum constants. */
  props: string[];
  file: string;
  line: number;
  status?: Status;
  /** When status is `modified`, what structurally differs. */
  change?: Change;
}

/**
 * What structurally changed in one type. Saying only "modified" leaves both
 * a reviewer and an agent with a file to open, so carry the detail.
 */
export interface Change {
  apiAdded: string[];
  apiRemoved: string[];
  propsAdded: string[];
  propsRemoved: string[];
  /** Node ids of dependencies gained or lost. */
  depsAdded: string[];
  depsRemoved: string[];
}

export interface Edge {
  src: string;
  dst: string;
  rel: Relation;
  /** Occurrences in the body. A crude measure of coupling strength. */
  weight: number;
  crossDomain: boolean;
  /** The target is only an identifier — a shared coordinate system, not coupling. */
  identifierOnly: boolean;
  /** Found by following a signature; the type name is absent from the source text. */
  viaSignature: boolean;
  /** Signatures of the methods actually called. */
  contracts: string[];
  /** Why this breaks a design rule. Empty means it does not. */
  violation: string;
  status?: Status;
  /**
   * A violation that was not one in the base.
   *
   * Do not derive this from the edge's status: move a type to another layer and
   * the edge is unchanged while the verdict is not — which is exactly the kind
   * of change this tool exists to catch.
   */
  newViolation?: boolean;
}

export interface Graph {
  project: string;
  /** What was extracted — a commit hash or a branch name. */
  ref: string;
  nodes: Node[];
  edges: Edge[];
}

export interface Delta {
  addedNodes: string[];
  removedNodes: string[];
  /** Nodes whose contract or relations differ. */
  modifiedNodes: string[];
  addedEdges: Edge[];
  removedEdges: Edge[];
  /** Per-node detail for modifiedNodes. */
  changes: Map<string, Change>;
  /** Keys of violating edges that were not violations in the base. */
  newViolations: Set<string>;
}

export const nodeIndex = (g: Graph): Map<string, Node> => new Map(g.nodes.map((n) => [n.id, n]));

export const edgeKey = (e: Pick<Edge, "src" | "dst" | "rel">): string =>
  `${e.src}\u0000${e.dst}\u0000${e.rel}`;
