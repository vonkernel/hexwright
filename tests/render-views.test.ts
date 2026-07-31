import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "../src/model.ts";
import { NothingToDraw, select } from "../src/render/select.ts";
import { renderSvg } from "../src/render/svg.ts";

/**
 * The two halves of a before/after pair.
 *
 * `violations` answers "where does it breach", which is a question about a state.
 * A base-state render answers it about the state the branch started from — the
 * picture that no longer exists in the working tree once the fix lands.
 *
 * Both are state views, and the delta annotations are what separates them from the
 * default: nothing in a picture of the past can be added or modified, so carrying
 * that styling over would draw a type about to be deleted as if it were new.
 */

const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  name: id.split(".").pop() as string,
  domain: "media",
  component: "DTO",
  layer: "application",
  sublayer: "port/inbound",
  kind: "data class",
  adapterKind: "",
  api: [],
  props: [],
  file: `${id}.kt`,
  line: 1,
  ...over,
});

const edge = (src: string, dst: string, over: Partial<Edge> = {}): Edge => ({
  src,
  dst,
  rel: "DEPENDS_ON",
  weight: 1,
  crossDomain: false,
  identifierOnly: false,
  viaSignature: false,
  contracts: [],
  violation: "",
  ...over,
});

/** A page holding an entity (the breach), a service beside it, and a clean pair. */
const graph = (over: Partial<Graph> = {}): Graph => ({
  project: "t",
  ref: "main",
  nodes: [
    node("m.IncidentPage"),
    node("m.MediaIncident", { component: "Entity", layer: "domain", sublayer: "model" }),
    node("m.IncidentService", { component: "Service", sublayer: "service" }),
    node("m.Untouched"),
  ],
  edges: [
    edge("m.IncidentPage", "m.MediaIncident", { violation: "DTO exposes Entity" }),
    edge("m.IncidentService", "m.MediaIncident"),
    edge("m.IncidentPage", "m.IncidentService"),
  ],
  ...over,
});

describe("--view violations", () => {
  it("keeps only the types a violation runs through", () => {
    const { graph: g } = select(graph(), "violations");
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["IncidentPage", "MediaIncident"]);
  });

  it("draws the breaches, not the wiring between them", () => {
    // IncidentPage -> IncidentService is real, but it is not what this view is for;
    // a clean edge between two violation endpoints would read as part of the breach.
    const { graph: g } = select(graph(), "violations");
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.violation).toBe("DTO exposes Entity");
  });

  it("does not compose with the component filter", () => {
    // The web UI ANDs this with the component checkboxes, so under a Core-only preset
    // a breach into an Adapter loses its edge. A standalone image must not do that.
    const withAdapter = graph({
      nodes: [
        node("m.Svc", { component: "Service", sublayer: "service" }),
        node("m.Ctrl", { component: "Adapter", layer: "adapter", adapterKind: "in" }),
      ],
      edges: [edge("m.Svc", "m.Ctrl", { violation: "layer back-reference" })],
    });
    const { graph: g } = select(withAdapter, "violations");
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Ctrl", "Svc"]);
    expect(g.edges).toHaveLength(1);
  });

  it("reports a clean graph as nothing to draw, not as a failure", () => {
    // The branch that removes every violation is the one this view is for. Treating
    // its result as an error would make the before/after script unusable.
    const clean = graph({ edges: [edge("m.IncidentService", "m.MediaIncident")] });
    expect(() => select(clean, "violations")).toThrow(NothingToDraw);
    expect(() => select(clean, "violations")).toThrow(/no violations/);
  });
});

describe("a base-state render", () => {
  /** The base graph carries no status — the branch has not happened there. */
  const base = graph();
  const changed = new Set(["m.IncidentPage", "m.MediaIncident"]);

  it("selects the types the branch touches, without needing status on them", () => {
    const { graph: g } = select(base, "delta", false, changed);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["IncidentPage", "MediaIncident"]);
  });

  it("describes itself as a state, not as a change", () => {
    const { label } = select(base, "delta", false, changed);
    expect(label).toBe("the types this branch touches, as they stand");
  });

  it("keeps the violation that the branch is about to remove", () => {
    const { graph: g } = select(base, "delta", false, changed);
    expect(g.edges.filter((e) => e.violation)).toHaveLength(1);
  });

  it("ignores ids absent from this graph", () => {
    // A type the branch adds does not exist in the base.
    const { graph: g } = select(base, "delta", false, new Set([...changed, "m.BrandNew"]));
    expect(g.nodes.map((n) => n.id)).not.toContain("m.BrandNew");
  });

  it("reports a purely additive branch as nothing to draw", () => {
    expect(() => select(base, "delta", false, new Set(["m.BrandNew"]))).toThrow(NothingToDraw);
  });
});

describe("the delta legend", () => {
  const svgOf = (g: Graph) => renderSvg(g, { layout: "grid", viewLabel: "t" });

  it("is absent when nothing can be added or modified", () => {
    const svg = svgOf(select(graph(), "violations").graph);
    expect(svg).not.toMatch(/>added</);
    expect(svg).not.toMatch(/>modified</);
    // The violation key stays — that is what the picture is showing.
    expect(svg).toMatch(/boundary violation/);
  });

  it("is present once the graph carries a delta", () => {
    const withStatus = graph({
      nodes: graph().nodes.map((n) => (n.name === "IncidentPage" ? { ...n, status: "added" } : n)),
    });
    const svg = svgOf(withStatus);
    expect(svg).toMatch(/>added</);
    expect(svg).toMatch(/>modified</);
  });
});
