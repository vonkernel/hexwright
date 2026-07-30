import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import type { Component, Edge, Graph, Node } from "../model.ts";
import {
  CORE,
  LEVEL,
  OUTLINE,
  SATURATION,
  SHAPE,
  gridLayout,
  hexLayout,
  hueMap,
  isCommon,
} from "./layout.ts";

cytoscape.use(fcose);

const hsl = (h: number, s: number, l: number) => `hsl(${h},${s}%,${l}%)`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const q = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

type Mode = "hex" | "grid";
let cy: cytoscape.Core;
let graph: Graph;
let fixed: Record<Mode, Map<string, { x: number; y: number }>>;
let base: Mode = "hex";
let organic = false;
let violOnly = false;
/** The organic setting from just before Violations only was switched on. */
let organicBeforeViol: boolean | undefined;
let focusId: string | null = null;
let dir: "both" | "in" | "out" = "both";
let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
/** The force layout currently running. Stopped before a new one is applied. */
let running: cytoscape.Layouts | undefined;
/** Domain hues, fixed once the set of domains is known and spaced apart. */
let hueOf: (domain: string) => number = () => 0;

async function boot(): Promise<void> {
  graph = (await (await fetch("/api/graph")).json()) as Graph;
  const domains = [...new Set(graph.nodes.map((n) => n.domain))];
  hueOf = hueMap(domains);
  const comps = [...new Set(graph.nodes.map((n) => n.component))].sort(
    (a, b) => LEVEL[a] - LEVEL[b],
  );

  fixed = {
    hex: new Map(hexLayout(graph).map((p) => [p.id, { x: p.x, y: p.y }])),
    grid: new Map(gridLayout(graph).map((p) => [p.id, { x: p.x, y: p.y }])),
  };

  document.title = `${graph.project} — hexwright`;
  $("title").textContent = graph.project;
  $("ref").textContent = graph.ref;

  const delta = {
    added: graph.nodes.filter((n) => n.status === "added").length,
    modified: graph.nodes.filter((n) => n.status === "modified").length,
    addedEdges: graph.edges.filter((e) => e.status === "added").length,
  };
  if (delta.added || delta.modified) {
    $("delta").innerHTML =
      `<span class="k"></span>added ${delta.added} nodes · ${delta.addedEdges} edges<br>` +
      `<span class="k2"></span>modified ${delta.modified} nodes`;
    $("deltaBox").style.display = "block";
  }

  buildFilters(domains, comps);
  buildCy();
  mark("bhex");
  preset("core");
}

function buildFilters(domains: string[], comps: Component[]): void {
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    counts.set(`c:${n.component}`, (counts.get(`c:${n.component}`) ?? 0) + 1);
    counts.set(`d:${n.domain}`, (counts.get(`d:${n.domain}`) ?? 0) + 1);
  }
  $("comps").innerHTML = comps
    .map(
      (c) =>
        `<label><span class="sw" style="${swatch(c)}"></span>` +
        `<input type=checkbox class=cf value="${c}" ${CORE.includes(c) ? "checked" : ""}>` +
        `${c}<span class="n">${counts.get(`c:${c}`) ?? 0}</span></label>`,
    )
    .join("");
  $("doms").innerHTML = domains
    .sort((a, b) => (counts.get(`d:${b}`) ?? 0) - (counts.get(`d:${a}`) ?? 0))
    .map((d) => {
      const h = hueOf(d);
      return (
        `<label><span class="sw" style="background:${hsl(h, isCommon(d) ? 0 : 60, 50)}"></span>` +
        `<input type=checkbox class=df value="${d}" checked>${d}` +
        `<span class="n">${counts.get(`d:${d}`) ?? 0}</span></label>`
      );
    })
    .join("");
  for (const el of q<HTMLInputElement>(".cf,.df,.rf")) el.onchange = () => apply();
  $("showId").onchange = () => apply();
  $("crossOnly").onchange = () => apply();
  $("deltaOnly").onchange = () => apply();
}

function swatch(c: Component): string {
  const g = "#8b949e";
  if (OUTLINE.includes(c)) return `border:1.4px dashed ${g};border-radius:5px`;
  const shapes: Partial<Record<Component, string>> = {
    Entity: "border-radius:6px/50%",
    Service: "border-radius:0",
    Port: "clip-path:polygon(22% 0,100% 0,100% 78%,78% 100%,0 100%,0 22%)",
    Event: "transform:skewX(-16deg)",
  };
  return `background:${g};${shapes[c] ?? "border-radius:5px"}`;
}

function buildCy(): void {
  const parents = [...new Set(graph.nodes.map((n) => n.domain))].map((d) => ({
    data: {
      id: `dom::${d}`,
      label: d,
      kind: "domain",
      hue: hueOf(d),
      sat: isCommon(d) ? 0 : 26,
    },
  }));
  const nodes = graph.nodes.map((n) => ({
    data: {
      ...n,
      parent: `dom::${n.domain}`,
      kind: "type",
      hue: hueOf(n.domain),
      sat: isCommon(n.domain) ? 0 : SATURATION[n.component],
      shape: SHAPE[n.component],
      outline: OUTLINE.includes(n.component),
      label: n.name,
    },
    position: { ...(fixed.hex.get(n.id) ?? { x: 0, y: 0 }) },
  }));
  const edges = graph.edges.map((e, i) => ({
    data: {
      ...e,
      id: `e${i}`,
      source: e.src,
      target: e.dst,
      hue: hueOf(nodeOf(e.src)?.domain ?? ""),
    },
  }));

  cy = cytoscape({
    container: $("cy"),
    elements: [...parents, ...nodes, ...edges],
    layout: { name: "preset" },
    minZoom: 0.05,
    maxZoom: 3,
    wheelSensitivity: 0.25,
    style: [
      {
        selector: 'node[kind="domain"]',
        style: {
          "background-color": (e: cytoscape.NodeSingular) => hsl(e.data("hue"), e.data("sat"), 13),
          "background-opacity": 0.5,
          "border-width": 1.5,
          "border-color": (e: cytoscape.NodeSingular) => hsl(e.data("hue"), e.data("sat") + 19, 42),
          shape: "round-rectangle",
          label: "data(label)",
          "text-valign": "top",
          "font-size": 21,
          "font-weight": "bold",
          color: (e: cytoscape.NodeSingular) => hsl(e.data("hue"), e.data("sat") + 29, 62),
          "text-margin-y": -7,
          padding: "16px",
        },
      },
      {
        selector: 'node[kind="type"]',
        style: {
          shape: "data(shape)" as never,
          width: "182px",
          height: "32px",
          "background-color": (e: cytoscape.NodeSingular) =>
            hsl(e.data("hue"), e.data("sat"), 46 - e.data("sat") * 0.07),
          "background-opacity": (e: cytoscape.NodeSingular) => (e.data("outline") ? 0 : 1),
          label: "data(label)",
          "font-size": 11,
          "text-valign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": "160px",
          color: (e: cytoscape.NodeSingular) =>
            e.data("outline") ? hsl(e.data("hue"), e.data("hue") ? 52 : 0, 72) : "#fff",
          "border-width": (e: cytoscape.NodeSingular) => (e.data("outline") ? 1.4 : 1),
          "border-color": (e: cytoscape.NodeSingular) =>
            hsl(e.data("hue"), e.data("outline") ? 48 : e.data("sat"), e.data("outline") ? 52 : 70),
          "border-style": (e: cytoscape.NodeSingular) => (e.data("outline") ? "dashed" : "solid"),
        },
      },
      {
        selector: 'node[component="Entity"]',
        style: {
          "border-width": 2.6,
          width: "190px",
          height: "36px",
          "font-weight": "bold",
          "font-size": 12,
        },
      },
      { selector: 'node[component="Service"]', style: { "border-width": 1.8 } },
      {
        selector: "edge",
        style: {
          width: 1.9,
          "line-color": (e: cytoscape.EdgeSingular) =>
            hsl(e.data("hue"), e.data("crossDomain") ? 62 : 22, e.data("crossDomain") ? 58 : 46),
          opacity: (e: cytoscape.EdgeSingular) => (e.data("crossDomain") ? 0.8 : 0.62),
          "target-arrow-color": (e: cytoscape.EdgeSingular) =>
            hsl(e.data("hue"), e.data("crossDomain") ? 62 : 22, e.data("crossDomain") ? 58 : 46),
        },
      },
      // Colour is spent on the domain, so relations differ by line style, curvature and arrowhead
      {
        selector: 'edge[rel="DEPENDS_ON"]',
        style: {
          "line-style": "solid",
          "curve-style": "straight",
          "target-arrow-shape": "vee",
          "arrow-scale": 0.95,
        },
      },
      {
        selector: 'edge[rel="IMPLEMENTS"]',
        style: {
          "line-style": "dashed",
          "line-dash-pattern": [9, 5],
          width: 2.2,
          "curve-style": "unbundled-bezier",
          "control-point-distances": [42],
          "control-point-weights": [0.5],
          "target-arrow-shape": "triangle",
          "target-arrow-fill": "hollow",
          "arrow-scale": 1.35,
        },
      },
      {
        selector: 'edge[rel="EXTENDS"]',
        style: {
          "line-style": "dashed",
          "line-dash-pattern": [3, 3],
          width: 3.4,
          "curve-style": "unbundled-bezier",
          "control-point-distances": [58],
          "control-point-weights": [0.5],
          "target-arrow-shape": "triangle",
          "target-arrow-fill": "hollow",
          "arrow-scale": 1.6,
        },
      },
      {
        selector: "edge[?identifierOnly]",
        style: { "line-style": "dotted", opacity: 0.4 },
      },
      {
        selector: 'edge[violation != ""]',
        style: {
          "line-color": "#f85149",
          "target-arrow-color": "#f85149",
          width: 3.4,
          opacity: 1,
          "z-index": 90,
          label: "data(violation)",
          "font-size": 10,
          color: "#f85149",
          "text-background-color": "#0e1116",
          "text-background-opacity": 0.85,
          "text-background-padding": "3px",
        },
      },
      // Emphasis is colour only — overriding the width would erase the relation kind
      {
        selector: 'edge[status="added"]',
        style: {
          opacity: 1,
          "line-color": "#f0883e",
          "target-arrow-color": "#f0883e",
          "z-index": 80,
        },
      },
      { selector: ".dim", style: { opacity: 0.035, "text-opacity": 0 } },
      {
        selector: ".nb",
        style: {
          "border-width": 2.4,
          "border-color": "#58a6ff",
          "z-index": 50,
        },
      },
      {
        selector: ".hi",
        style: { "border-width": 5, "border-color": "#58a6ff", "z-index": 100 },
      },
      {
        selector: "edge.sel",
        style: {
          width: 5,
          opacity: 1,
          "line-color": "#58a6ff",
          "target-arrow-color": "#58a6ff",
          "z-index": 99,
        },
      },
    ],
  });

  // Exposed so the graph can be poked at from the console
  (window as unknown as { cy: cytoscape.Core }).cy = cy;

  // Refit when the container resizes — otherwise the graph drifts off screen after a window change
  const ro = new ResizeObserver(() => {
    cy.resize();
    const vis = cy.nodes('[kind="type"]').filter((n) => n.style("display") === "element");
    if (vis.length) cy.fit(vis, 40);
  });
  ro.observe($("cy"));

  cy.on("tap", 'node[kind="type"]', (e) => showNode(e.target));
  cy.on("tap", "edge", (e) => showEdge(e.target));
  cy.on("tap", (e) => {
    const t = e.target as unknown as { data?: (k: string) => unknown };
    if (e.target === cy || t.data?.("kind") === "domain") clearFocus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearFocus();
  });
}

const nodeOf = (id: string): Node | undefined => graph.nodes.find((n) => n.id === id);

// -- filters -------------------------------------------------------
function apply(): void {
  const cs = new Set(q<HTMLInputElement>(".cf:checked").map((e) => e.value));
  const ds = new Set(q<HTMLInputElement>(".df:checked").map((e) => e.value));
  const rs = new Set(q<HTMLInputElement>(".rf:checked").map((e) => e.value));
  const showId = ($("showId") as HTMLInputElement).checked;
  const crossOnly = ($("crossOnly") as HTMLInputElement).checked;
  const deltaOnly = ($("deltaOnly") as HTMLInputElement).checked;

  // Violations only applies to nodes as well: filtering edges alone leaves
  // unrelated nodes behind and the picture reads as empty. It ANDs with the
  // other filters and never touches their checkboxes.
  const violNodes = new Set<string>();
  if (violOnly) {
    for (const e of cy.edges()) {
      if (!e.data("violation")) continue;
      violNodes.add(e.data("source"));
      violNodes.add(e.data("target"));
    }
  }

  cy.batch(() => {
    for (const n of cy.nodes('[kind="type"]')) {
      const d = n.data();
      let v = cs.has(d.component) && ds.has(d.domain);
      if (v && deltaOnly && d.status === "existing") v = false;
      if (v && violOnly && !violNodes.has(d.id)) v = false;
      n.style("display", v ? "element" : "none");
    }
    // visible() returns false for a child once its parent is hidden. Judging the
    // parent by that would leave a hidden parent hidden forever, so read its own
    // display instead.
    const on = (el: { style: (k: string) => unknown }) => el.style("display") === "element";
    for (const p of cy.nodes('[kind="domain"]')) {
      p.style("display", p.children().filter((c) => on(c)).length ? "element" : "none");
    }
    for (const e of cy.edges()) {
      let v = on(e.source()) && on(e.target()) && rs.has(e.data("rel"));
      if (v && !showId && e.data("identifierOnly")) v = false;
      if (v && crossOnly && !e.data("crossDomain")) v = false;
      if (v && violOnly && !e.data("violation")) v = false;
      e.style("display", v ? "element" : "none");
    }
  });
  status();
  const vis = cy.nodes('[kind="type"]').filter((n) => n.style("display") === "element");
  if (!vis.length) return;
  scheduleRelayout();
}

function status(): void {
  const on = (el: { style: (k: string) => unknown }) => el.style("display") === "element";
  const vn = cy.nodes('[kind="type"]').filter((n) => on(n)).length;
  const ve = cy.edges().filter((e) => on(e)).length;
  const nv = cy.edges().filter((e) => on(e) && e.data("violation")).length;
  $("stat").innerHTML =
    `Nodes <b>${vn}</b>/${cy.nodes('[kind="type"]').length} · Edges <b>${ve}</b>/${cy.edges().length}`;
  $("cviol").textContent = String(nv);
  for (const r of ["DEPENDS_ON", "IMPLEMENTS", "EXTENDS"]) {
    const el = document.getElementById(`c${r}`);
    if (el) el.textContent = String(cy.edges(`[rel="${r}"]`).filter((e) => on(e)).length);
  }
}

// -- layout --------------------------------------------------------
function scheduleRelayout(): void {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(relayout, 110);
}

function relayout(): void {
  // Stop any running force layout first: an animation finishing late would
  // otherwise overwrite the coordinates applied after it.
  running?.stop();
  running = undefined;
  // On hexagonal the ring meaning (Entity at the centre, outward from there) has
  // to survive, so nodes stay put and only the domain boxes move. The grid has
  // no such structure to preserve, so it gets a free-form force layout.
  if (!organic) fixedCoords();
  else if (base === "hex") hexOrganic();
  else forceLayout();
}

const shown = (el: { style: (k: string) => unknown }) => el.style("display") === "element";

/**
 * Organic at the domain-box level: recompute the hexagonal layout from the
 * visible nodes alone. The rings stack the same way, and the boxes are re-placed
 * by their reduced radius and the coupling actually on screen.
 */
function hexOrganic(): void {
  const ids = new Set(
    cy
      .nodes('[kind="type"]')
      .filter((n) => shown(n))
      .map((n) => n.id()),
  );
  const keep = new Set(
    cy
      .edges()
      .filter((e) => shown(e))
      .map((e) => e.id()),
  );
  const sub: Graph = {
    ...graph,
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((_, i) => keep.has(`e${i}`)),
  };
  const pos = new Map(hexLayout(sub).map((p) => [p.id, p]));
  cy.batch(() => {
    for (const n of cy.nodes('[kind="type"]')) {
      const p = pos.get(n.id());
      if (p) n.position({ x: p.x, y: p.y });
    }
  });
  const vis = cy.nodes('[kind="type"]').filter((n) => shown(n));
  if (vis.length) cy.fit(vis, 40);
}

function fixedCoords(): void {
  const map = fixed[base];
  cy.batch(() => {
    for (const n of cy.nodes('[kind="type"]')) {
      const p = map.get(n.id());
      if (p) n.position({ x: p.x, y: p.y });
    }
  });
  const vis = cy.nodes('[kind="type"]').filter((n) => n.style("display") === "element");
  if (vis.length) cy.fit(vis, 40);
}

function forceLayout(): void {
  const el = cy.elements().filter((e) => e.style("display") === "element");
  const cnt = el.nodes().length;
  if (!cnt) return;
  running = el.layout({
    name: "fcose",
    quality: cnt <= 150 ? "proof" : cnt <= 400 ? "default" : "draft",
    numIter: cnt <= 150 ? 1600 : cnt <= 400 ? 900 : 500,
    randomize: cnt <= 150,
    animate: cnt <= 250,
    animationDuration: 400,
    nodeSeparation: 210,
    idealEdgeLength: (e: cytoscape.EdgeSingular) => (e.data("crossDomain") ? 300 : 130),
    nodeRepulsion: 34000,
    gravity: 0.12,
    gravityCompound: 0.9,
    gravityRangeCompound: 2.2,
    packComponents: true,
    tile: true,
    nodeDimensionsIncludeLabels: true,
    stop: () => cy.fit(el.nodes(), 60),
  } as cytoscape.LayoutOptions);
  running.run();
}

const mark = (id: string) => {
  for (const b of ["bhex", "bgrid"]) $(b).classList.toggle("on", b === id);
};

// -- focus ---------------------------------------------------------
function clearFocus(): void {
  cy.elements().removeClass("hi dim sel nb");
  $("info").style.display = "none";
  focusId = null;
  dir = "both";
}

const row = (k: string, v: string) => `<tr><td>${k}</td><td>${v}</td></tr>`;
const yn = (v: unknown) => (v ? '<span style="color:#f0883e">yes</span>' : "no");
const statusCell = (s?: string) =>
  s === "added"
    ? '<span style="color:#f0883e">added</span>'
    : s === "modified"
      ? '<span style="color:#a371f7">modified</span>'
      : "existing";

function showNode(n: cytoscape.NodeSingular): void {
  focusId = n.id();
  const d = n.data() as Node & { label: string };
  const vis = (x: cytoscape.EdgeSingular) => x.style("display") === "element";
  const all = n.connectedEdges().filter((e) => vis(e));
  const inc = all.filter((e) => (e as cytoscape.EdgeSingular).target().id() === focusId);
  const out = all.filter((e) => (e as cytoscape.EdgeSingular).source().id() === focusId);
  const edges = dir === "in" ? inc : dir === "out" ? out : all;
  const nb = edges.connectedNodes().difference(n);

  cy.elements().removeClass("hi dim sel nb").addClass("dim");
  n.removeClass("dim").addClass("hi");
  nb.removeClass("dim").addClass("nb");
  edges.removeClass("dim").addClass("sel");
  nb.parent().removeClass("dim");
  n.parent().removeClass("dim");

  const btn = (k: string, label: string, cnt: number) =>
    `<button class="dirb ${dir === k ? "on" : ""}" data-dir="${k}">${label} ${cnt}</button>`;
  const item = (e: cytoscape.EdgeSingular, arrow: string, other: cytoscape.NodeSingular) => {
    const o = other.data();
    return (
      `<div class="lk" data-goto="${o.id}"><span class="ar">${arrow}</span>${o.name}` +
      `<span class="mut"> ${o.domain}·${o.component}</span>` +
      `<span class="rel">${e.data("rel") === "DEPENDS_ON" ? "" : e.data("rel")}</span></div>`
    );
  };
  let list = "";
  if (dir !== "out") for (const e of inc) list += item(e, "←", e.source());
  if (dir !== "in") for (const e of out) list += item(e, "→", e.target());

  const contract =
    d.api.length || d.props.length
      ? `<div class="dirbar" style="display:block"><b>Public contract</b><span class="mut"> ${d.api.length} fn${d.props.length ? ` · ${d.props.length} prop` : ""}</span></div><div class="lks">${d.api
          .map((a) => {
            const i = a.indexOf("(");
            return `<div class="lk"><span class="sig"><b>${a.slice(0, i)}</b>${a.slice(i)}</span></div>`;
          })
          .join("")}${d.props
          .map((p) => `<div class="lk"><span class="sig" style="color:#6e7681">${p}</span></div>`)
          .join("")}</div>`
      : "";

  $("info").style.display = "block";
  $("info").innerHTML =
    `<div class="ih">${d.name}<span class="x">×</span></div><table>${row("Domain", d.domain)}${row("Component", `${d.component} <span class="mut">${d.layer}${d.sublayer ? `/${d.sublayer}` : ""}</span>`)}${row("Kind", d.kind)}${row("Status", statusCell(d.status))}${row("File", `<span class="mut">${d.file}:${d.line}</span>`)}${row("Id", `<span class="mut" style="word-break:break-all">${d.id}</span>`)}</table>${contract}<div class="dirbar">${btn("both", "Both", all.length)}${btn("in", "← In", inc.length)}${btn("out", "Out →", out.length)}</div><div class="lks">${list || '<span class="mut">No visible connections</span>'}</div><div class="hint">Click an item to focus it · Esc to clear</div>`;
  wireInfo();
}

function showEdge(e: cytoscape.EdgeSingular): void {
  focusId = null;
  const d = e.data() as Edge;
  const s = nodeOf(d.src);
  const t = nodeOf(d.dst);
  cy.elements().removeClass("hi dim sel nb").addClass("dim");
  e.removeClass("dim").addClass("sel");
  e.connectedNodes().removeClass("dim").addClass("nb").parent().removeClass("dim");

  const contracts = d.contracts.length
    ? `<div class="dirbar" style="display:block"><b>Contracts used</b><span class="mut"> ${d.contracts.length}/${t?.api.length ?? 0}</span></div><div class="lks">${d.contracts
        .map((c) => {
          const i = c.indexOf("(");
          return `<div class="lk"><span class="sig"><b>${i > 0 ? c.slice(0, i) : c}</b>${i > 0 ? c.slice(i) : ""}</span></div>`;
        })
        .join("")}</div>`
    : '<div class="hint">No method calls — type reference only</div>';

  $("info").style.display = "block";
  $("info").innerHTML =
    `<div class="ih">${d.rel}<span class="x">×</span></div><table>${row("Source", `${s?.name} <span class="mut">${s?.domain}·${s?.component}</span>`)}${row("Target", `${t?.name} <span class="mut">${t?.domain}·${t?.component}</span>`)}${
      d.rel === "DEPENDS_ON"
        ? row("Weight", `${d.weight} <span class="mut">occurrences</span>`)
        : ""
    }${row("Cross-domain", yn(d.crossDomain))}${row("Identifier only", yn(d.identifierOnly))}${row("Via signature", yn(d.viaSignature))}${d.violation ? row("Violation", `<span style="color:#f85149">${d.violation}</span>`) : ""}${row("Status", statusCell(d.status))}</table>${contracts}`;
  wireInfo();
}

function wireInfo(): void {
  const x = $("info").querySelector(".x") as HTMLElement | null;
  if (x) x.onclick = () => clearFocus();
  for (const b of Array.from($("info").querySelectorAll<HTMLElement>(".dirb"))) {
    b.onclick = () => {
      dir = b.dataset.dir as typeof dir;
      if (focusId) showNode(cy.getElementById(focusId));
    };
  }
  for (const l of Array.from($("info").querySelectorAll<HTMLElement>("[data-goto]"))) {
    l.onclick = () => showNode(cy.getElementById(l.dataset.goto as string));
  }
}

// -- presets -------------------------------------------------------
function preset(m: "core" | "all"): void {
  for (const c of q<HTMLInputElement>(".cf")) {
    c.checked = m === "core" ? CORE.includes(c.value as Component) : true;
  }
  for (const b of ["pcore", "pall"]) $(b).classList.toggle("on", b === `p${m}`);
  apply();
}

function main(): void {
  $("pcore").onclick = () => preset("core");
  $("pall").onclick = () => preset("all");
  $("bhex").onclick = () => {
    base = "hex";
    mark("bhex");
    relayout();
  };
  $("bgrid").onclick = () => {
    base = "grid";
    mark("bgrid");
    relayout();
  };
  $("borg").onclick = () => {
    organic = !organic;
    $("borg").classList.toggle("on", organic);
    relayout();
  };
  $("bviol").onclick = () => {
    violOnly = !violOnly;
    $("bviol").classList.toggle("on", violOnly);
    // With only violations left there are a handful of nodes, and fixed
    // coordinates scatter them. Turn organic on to gather them, and restore
    // exactly what was there when switching off.
    if (violOnly) {
      organicBeforeViol = organic;
      organic = true;
    } else if (organicBeforeViol !== undefined) {
      organic = organicBeforeViol;
      organicBeforeViol = undefined;
    }
    $("borg").classList.toggle("on", organic);
    apply();
  };
  $("allDomOn").onclick = () => {
    for (const c of q<HTMLInputElement>(".df")) c.checked = true;
    apply();
  };
  $("allDomOff").onclick = () => {
    for (const c of q<HTMLInputElement>(".df")) c.checked = false;
    apply();
  };
  void boot();
}

main();
