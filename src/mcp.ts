import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Edge, Node } from "./model.ts";
import type { GraphQuery } from "./query.ts";

/**
 * The agent-facing interface.
 *
 * Nothing obtainable by reading a file lives here — an agent already has Read
 * and Grep, and they are usually faster. What is left is three things: a verdict
 * over the whole graph, the structural diff against a base, and dependencies
 * followed through signatures to references whose name never appears in the text.
 *
 * Descriptions carry when to reach for a tool, not only what it returns. That
 * self-describing quality is most of why this is an MCP server. What a
 * description cannot carry is a sequence across tools, or an instruction to stop
 * and wait — that belongs to the target repository's own agent instructions.
 */
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

const brief = (n: Node) => `${n.name} [${n.component}] ${n.domain} — ${n.file}:${n.line}`;

const edgeLine = (e: Edge, other: Node | undefined, dir: "→" | "←") =>
  `  ${dir} ${other?.name ?? "?"} [${other?.component}] ${other?.domain}` +
  `${e.rel === "DEPENDS_ON" ? "" : ` (${e.rel})`}` +
  `${e.identifierOnly ? " ·id" : ""}${e.violation ? `  !! ${e.violation}` : ""}` +
  `${e.contracts.length ? `\n      uses: ${e.contracts.join(", ")}` : ""}`;

export function buildServer(getQuery: () => GraphQuery, _project: string): McpServer {
  const server = new McpServer({ name: "hexwright", version: "0.1.0" });

  const resolveOr = (q: GraphQuery, name: string) => {
    const r = q.resolve(name);
    if (r.node) return { node: r.node as Node, err: null };
    const list = r.candidates.map(brief).join("\n");
    return {
      node: null,
      err: ok(
        r.candidates.length
          ? `'${name}' is ambiguous or not exact. Candidates:\n${list}`
          : `not found: ${name}`,
      ),
    };
  };

  server.registerTool(
    "check_violations",
    {
      title: "Boundary violations",
      description:
        "Whether the code breaks its own architecture: cross-domain Entity access, an Entity " +
        "leaked into a contract, an inbound adapter touching an Entity, an application or domain " +
        "type referencing an adapter. Run this after finishing a change and before opening a PR — " +
        "these are verdicts over the whole graph, so reading files will not surface them. " +
        "scope 'delta' reports only what this branch introduced, including a relation that already " +
        "existed but became a violation because a type moved.",
      inputSchema: { scope: z.enum(["all", "delta"]).optional() },
    },
    async ({ scope = "all" }) => {
      const q = getQuery();
      if (scope === "delta" && !q.hasBase) {
        return ok("no base ref — restart the server with --base <ref> to scope to this branch");
      }
      const vs = q.violations(scope);
      if (!vs.length) return ok(scope === "delta" ? "no new violations" : "no violations");
      return ok(
        [
          `${vs.length} violation(s):`,
          ...vs.map((e) => {
            const s = q.node(e.src);
            const d = q.node(e.dst);
            return `  ${s?.name} → ${d?.domain}.${d?.name}\n      ${e.violation}\n      ${s?.file}`;
          }),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "get_delta",
    {
      title: "Branch delta",
      description:
        "What this branch changed structurally against the base: types added, types whose public " +
        "contract or relations changed — and for each, exactly what was added or removed. Use it " +
        "before opening a PR to confirm the change matches what was agreed, and to describe it " +
        "from facts rather than memory. Needs the server started with --base.",
    },
    async () => {
      const q = getQuery();
      const d = q.delta();
      if (!d.added.length && !d.modified.length) {
        return ok(
          q.hasBase ? "no structural change on this branch" : "no base ref — restart with --base",
        );
      }
      const out = [
        `added ${d.added.length} types · ${d.addedEdges.length} edges · modified ${d.modified.length} types`,
      ];
      if (d.added.length) out.push("", "added:", ...d.added.map((n) => `  + ${brief(n)}`));
      if (d.modified.length) {
        out.push("", "modified:");
        for (const n of d.modified) {
          out.push(`  ~ ${brief(n)}`);
          const c = n.change;
          if (!c) continue;
          const nameOf = (id: string) => q.node(id)?.name ?? id;
          for (const s of c.apiRemoved) out.push(`      - contract  ${s}`);
          for (const s of c.apiAdded) out.push(`      + contract  ${s}`);
          for (const s of c.propsRemoved) out.push(`      - property  ${s}`);
          for (const s of c.propsAdded) out.push(`      + property  ${s}`);
          for (const id of c.depsRemoved) out.push(`      - depends   ${nameOf(id)}`);
          for (const id of c.depsAdded) out.push(`      + depends   ${nameOf(id)}`);
        }
      }
      const newViol = q.violations("delta");
      out.push("", newViol.length ? `NEW violations (${newViol.length}):` : "no new violations");
      for (const e of newViol) {
        out.push(`  ${q.node(e.src)?.name} → ${q.node(e.dst)?.name}  ${e.violation}`);
      }
      return ok(out.join("\n"));
    },
  );

  server.registerTool(
    "dependencies",
    {
      title: "Dependencies",
      description:
        "How a type is wired, in either direction. 'out' = what it depends on and which methods it " +
        "actually calls on each — including references held only in a local variable, whose type " +
        "name never appears in the source, so grep cannot find them. 'in' = what depends on it, " +
        "which of its methods each consumer uses, and which it declares that nobody calls. " +
        "Use 'in' before adding a method to an existing port or use case: if the consumers already " +
        "use disjoint subsets, the interface wants splitting rather than growing. Raise hops to see " +
        "what a change would reach beyond the direct callers.",
      inputSchema: {
        name: z.string().describe("exact type name or FQCN"),
        direction: z.enum(["in", "out", "both"]).optional(),
        hops: z.number().int().min(1).max(4).optional().describe("in-direction only. default 1"),
        includeIdentifiers: z
          .boolean()
          .optional()
          .describe("include identifier-only references (FamilyId etc). default false"),
      },
    },
    async ({ name, direction = "both", hops = 1, includeIdentifiers = false }) => {
      const q = getQuery();
      const { node: n, err } = resolveOr(q, name);
      if (!n) return err;
      const keep = (e: Edge) => includeIdentifiers || !e.identifierOnly;
      const out: string[] = [`${n.name} [${n.component}] ${n.domain} — ${n.file}:${n.line}`];

      if (direction !== "in") {
        const es = q.outgoing(n.id).filter(keep);
        out.push("", `depends on (${es.length}):`);
        for (const e of es) out.push(edgeLine(e, q.node(e.dst), "→"));
      }

      if (direction !== "out") {
        const es = q.incoming(n.id).filter(keep);
        out.push("", `depended on by (${es.length}):`);
        for (const e of es) out.push(edgeLine(e, q.node(e.src), "←"));

        // Declared but never called — the signal that an interface wants splitting
        const u = q.contractUsage(n.id);
        if (u.declared.length && u.unusedByAll.length) {
          out.push("", `declares ${u.declared.length}, never called (${u.unusedByAll.length}):`);
          for (const s of u.unusedByAll) out.push(`  ${s}`);
        }

        if (hops > 1) {
          const reach = q.impact(n.id, hops).filter((r) => r.hop > 1);
          out.push("", `reaches ${reach.length} more type(s) beyond the direct callers:`);
          for (const r of reach) out.push(`  hop ${r.hop}  ${brief(r.node)}`);
        }
      }
      return ok(out.join("\n"));
    },
  );

  return server;
}

export async function serveStdio(getQuery: () => GraphQuery, project: string): Promise<void> {
  const server = buildServer(getQuery, project);
  await server.connect(new StdioServerTransport());
}
