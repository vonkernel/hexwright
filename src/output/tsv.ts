import type { Delta, Graph } from "../model.ts";

/**
 * A git-friendly text format: one line each, sorted, common prefix stripped.
 * Commit it and a PR diff shows structural change in a form a human can read.
 */
export function toTsv(g: Graph): string {
  const prefix = commonPrefix(g.nodes.map((n) => n.id));
  const s = (id: string) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const out: string[] = [
    `# hexwright\tproject=${g.project}\tref=${g.ref}\tprefix=${prefix}`,
    `# nodes=${g.nodes.length}\tedges=${g.edges.length}`,
  ];
  for (const n of g.nodes) {
    out.push(["N", s(n.id), n.domain, n.component, `${n.file}:${n.line}`].join("\t"));
  }
  for (const e of g.edges) {
    const flags =
      (e.crossDomain ? "x" : "") + (e.identifierOnly ? "i" : "") + (e.violation ? "!" : "");
    out.push(["E", e.rel, s(e.src), s(e.dst), flags].join("\t"));
  }
  return `${out.join("\n")}\n`;
}

function commonPrefix(ids: string[]): string {
  if (!ids.length) return "";
  const parts = ids.map((i) => i.split("."));
  const first = parts[0] as string[];
  const common: string[] = [];
  for (let i = 0; i < first.length - 1; i++) {
    const seg = first[i] as string;
    if (parts.every((p) => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.length ? `${common.join(".")}.` : "";
}

/** Human-readable delta summary, for a terminal or a CI comment. */
export function deltaSummary(d: Delta, g: Graph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `${n.name} [${n.component}] ${n.domain}` : id;
  };
  const lines = [
    `added   ${d.addedNodes.length} nodes · ${d.addedEdges.length} edges`,
    `modified ${d.modifiedNodes.length} nodes`,
    `removed ${d.removedNodes.length} nodes · ${d.removedEdges.length} edges`,
  ];
  for (const id of d.addedNodes) lines.push(`  + ${label(id)}`);
  for (const id of d.modifiedNodes) lines.push(`  ~ ${label(id)}`);
  for (const id of d.removedNodes) lines.push(`  - ${id}`);
  return lines.join("\n");
}
