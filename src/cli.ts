import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "./mcp.ts";
import type { Graph } from "./model.ts";
import { deltaSummary, toTsv } from "./output/tsv.ts";
import { loadProfile } from "./profile.ts";
import type { Detected } from "./project.ts";
import { detectSource } from "./project.ts";
import type { Selection, View } from "./render/select.ts";
import { select } from "./render/select.ts";
import { renderSvg } from "./render/svg.ts";
import { GraphSource } from "./source.ts";
import { serveHttp } from "./view/server.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const USAGE = `hexwright — design graph for hexagonal codebases

  hexwright extract --repo <path> [options]     print graph summary
  hexwright check   --repo <path> [options]     exit 1 on violations
  hexwright mcp     --repo <path> [options]     serve MCP over stdio
  hexwright serve   --repo <path> [options]     web UI (and MCP with --mcp)
  hexwright render  --repo <path> [options]     write an SVG (and PNG) for a PR

Options
  --repo <path>        target repository (required)
  --src <path>         source root, relative to repo   [auto: Gradle module]
  --base <ref>         branch/commit to diff against   [none]
  --project <name>     name shown in outputs           [repo dir name]
  --base-package <pkg> package prefix before the domain segment [auto]
  --profile <file>     architecture profile            [hexagonal-kotlin.yml]
  --out <dir>          write graph.json / graph.tsv here
  --json               print graph as JSON to stdout
  --port <n>           web UI port                     [7800]
  --mcp                also serve MCP over stdio (with serve)

check only
  --scope <s>          all | delta   [all]
                       delta = fail only on violations this branch introduced;
                       requires --base. Lets you gate a repository that already
                       has violations without fixing them all first.

render only
  --view <v>           delta | impact | core | all | domain:<name>   [delta]
  --layout <l>         organic | grid | hex
                       [organic for delta·domain, hex for core·all]
  --image <file>       output path; .svg, or .png to rasterize  [graph.svg]
  --identifiers        include identifier-only references (FamilyId·UserId)
`;

function main(): number {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      src: { type: "string" },
      base: { type: "string" },
      project: { type: "string" },
      "base-package": { type: "string" },
      profile: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      port: { type: "string", default: "7800" },
      mcp: { type: "boolean", default: false },
      scope: { type: "string", default: "all" },
      view: { type: "string", default: "delta" },
      layout: { type: "string" }, // no default — chosen to suit the view
      image: { type: "string" },
      identifiers: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const cmd = positionals[0] ?? "extract";
  if (v.help || !v.repo || !["extract", "check", "mcp", "serve", "render"].includes(cmd)) {
    process.stdout.write(USAGE);
    return v.help ? 0 : 1;
  }

  const repo = resolve(v.repo);
  const project = v.project ?? repo.split("/").filter(Boolean).pop() ?? "project";
  const profilePath = v.profile ?? join(HERE, "..", "profiles", "hexagonal-kotlin.yml");
  const profile = loadProfile(profilePath, v["base-package"] ? { base: v["base-package"] } : {});

  let det: Detected;
  try {
    det = detectSource(repo, v.src);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
  if (det.subprojects > 0) {
    process.stderr.write(
      `warning: settings.gradle declares ${det.subprojects} subproject(s). ` +
        "hexwright assumes a single module and analyzes only " +
        `${det.srcRel}\n`,
    );
  }
  // Owns the graph. Long-running commands (serve, mcp) get a fresh one per question.
  const source = new GraphSource({
    repo,
    srcAbs: det.srcAbs,
    srcRel: det.srcRel,
    profile,
    profilePath,
    project,
    ...(v.base ? { base: v.base } : {}),
  });

  let graph: Graph;
  try {
    graph = source.graph();
  } catch (e) {
    // Nearly always a missing base ref. Print the message alone so the cause is
    // not buried under a stack trace in a CI log.
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
  const d = source.delta();
  const summary = d ? deltaSummary(d, graph) : "";
  const violations = graph.edges.filter((e) => e.violation);
  const deltaScope = v.scope === "delta";
  if (deltaScope && !v.base) {
    process.stderr.write("--scope delta needs --base <ref> to know what is new\n");
    return 1;
  }
  // What the gate judges. With delta, only violations this branch introduced.
  const gated = deltaScope ? violations.filter((e) => e.newViolation) : violations;

  if (cmd === "serve") {
    void serveHttp({ port: Number(v.port), graph: () => source.graph() }).then((url) => {
      process.stderr.write(
        `hexwright — ${project} @ ${graph.ref}\n` +
          `  ${graph.nodes.length} nodes · ${graph.edges.length} edges · ` +
          `${violations.length} violations${v.base ? ` · delta vs ${v.base}` : ""}\n` +
          `  web ${url}\n`,
      );
      if (v.mcp) void serveStdio(() => source.query(), project);
    });
    return -1;
  }

  if (cmd === "render") {
    const out = v.image ?? "graph.svg";
    let sel: Selection;
    try {
      sel = select(graph, v.view as View, v.identifiers);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
    // Delta and single-domain views want organic: domain blocks placed by coupling,
    // so entangled domains sit close and the lines stay short. core and all are
    // read as a shape, so concentric rings suit them. --layout overrides.
    const layout =
      v.layout === "hex" || v.layout === "grid" || v.layout === "organic"
        ? v.layout
        : v.view === "core" || v.view === "all"
          ? "hex"
          : "organic";
    const svg = renderSvg(sel.graph, {
      layout,
      viewLabel: sel.label,
      showIdentifiers: v.identifiers,
    });
    const dir = dirname(resolve(out));
    mkdirSync(dir, { recursive: true });
    const svgPath = out.endsWith(".png") ? `${out.slice(0, -4)}.svg` : out;
    writeFileSync(svgPath, svg);
    process.stdout.write(
      `${project} @ ${graph.ref}\n` +
        `  view    ${sel.label}\n` +
        `  drew    ${sel.graph.nodes.length} types · ${sel.graph.edges.length} relations` +
        ` · ${sel.graph.edges.filter((e) => e.violation).length} violations\n` +
        `  wrote   ${svgPath}  (${Math.round(svg.length / 1024)} KB)\n`,
    );
    if (out.endsWith(".png")) {
      const px = toPng(svg, out);
      process.stdout.write(
        px
          ? `  wrote   ${out}  (${px})\n`
          : "  note    PNG skipped — install @resvg/resvg-js for rasterizing\n",
      );
    }
    return 0;
  }

  if (cmd === "mcp") {
    process.stderr.write(
      `hexwright mcp — ${project} @ ${graph.ref}\n` +
        `  ${graph.nodes.length} nodes · ${graph.edges.length} edges · ` +
        `${violations.length} violations${v.base ? ` · delta vs ${v.base}` : ""}\n`,
    );
    void serveStdio(() => source.query(), project);
    return -1; // the server holds stdio, so do not exit
  }

  if (v.json) {
    process.stdout.write(`${JSON.stringify(graph, null, 1)}\n`);
  } else {
    const byComp = new Map<string, number>();
    for (const n of graph.nodes) byComp.set(n.component, (byComp.get(n.component) ?? 0) + 1);
    const byRel = new Map<string, number>();
    for (const e of graph.edges) byRel.set(e.rel, (byRel.get(e.rel) ?? 0) + 1);

    process.stdout.write(`${project} @ ${graph.ref}\n`);
    process.stdout.write(
      `  nodes ${graph.nodes.length}  ${[...byComp]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(" · ")}\n`,
    );
    process.stdout.write(
      `  edges ${graph.edges.length}  ${[...byRel].map(([k, n]) => `${k} ${n}`).join(" · ")}\n`,
    );
    process.stdout.write(`  domains ${new Set(graph.nodes.map((n) => n.domain)).size}\n`);
    process.stdout.write(`  source  ${det.srcRel}  (${det.how})\n`);
    if (summary) process.stdout.write(`\ndelta vs ${v.base}\n${indent(summary)}\n`);
    const shown = cmd === "check" ? gated : violations;
    if (shown.length) {
      const carried = violations.length - gated.length;
      process.stdout.write(
        `\nviolations ${shown.length}` +
          (deltaScope ? ` new  (${carried} pre-existing, not gated)\n` : "\n"),
      );
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const e of shown) {
        const s = byId.get(e.src);
        const d = byId.get(e.dst);
        process.stdout.write(
          `  ${s?.name} → ${d?.domain}.${d?.name}  ${e.violation}\n      ${s?.file}\n`,
        );
      }
    } else if (deltaScope) {
      process.stdout.write(`\nviolations 0 new  (${violations.length} pre-existing, not gated)\n`);
    } else {
      process.stdout.write("\nviolations 0\n");
    }
  }

  if (v.out) {
    mkdirSync(v.out, { recursive: true });
    writeFileSync(join(v.out, "graph.json"), `${JSON.stringify(graph, null, 1)}\n`);
    writeFileSync(join(v.out, "graph.tsv"), toTsv(graph));
    process.stderr.write(`\nwrote ${join(v.out, "graph.json")} · graph.tsv\n`);
  }

  return cmd === "check" && gated.length ? 1 : 0;
}

/**
 * SVG to PNG. GitHub does not render SVG as an image in comments, so attaching
 * to a PR needs a raster. resvg is optional; without it this quietly skips.
 */
function toPng(svg: string, out: string): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const { Resvg } = req("@resvg/resvg-js") as {
      Resvg: new (
        s: string,
        o?: unknown,
      ) => { render(): { asPng(): Buffer; width: number; height: number } };
    };
    const img = new Resvg(svg, {
      font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
    }).render();
    writeFileSync(out, img.asPng());
    return `${img.width}×${img.height}`;
  } catch {
    return undefined;
  }
}

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
const safe = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

// -1 means a command that keeps running (serve, mcp). Otherwise set exitCode and
// let the process end when the event loop drains — process.exit discards stdout
// still queued on a pipe, which truncated --json output at 64KB.
const code = main();
if (code >= 0) process.exitCode = code;
