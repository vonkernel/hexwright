import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { applyStatus, diff } from "../src/delta.ts";
import { extractKotlin } from "../src/extract/kotlin.ts";
import { exportRef } from "../src/git.ts";
import type { Graph } from "../src/model.ts";
import { loadProfile } from "../src/profile.ts";
import { detectSource } from "../src/project.ts";
import { select } from "../src/render/select.ts";
import { renderSvg } from "../src/render/svg.ts";
import { hueMap } from "../src/view/layout.ts";

/**
 * Integration suite against a real Kotlin codebase. It is skipped unless one is
 * injected, because the assertions below are calibrated to a specific project —
 * counts, type names, known violations. Nothing about a machine or a workspace
 * belongs in this file.
 *
 *   HEXWRIGHT_TEST_REPO=/path/to/service  HEXWRIGHT_TEST_SRC=server  npm test
 */
const REPO = process.env.HEXWRIGHT_TEST_REPO;
const MODULE = process.env.HEXWRIGHT_TEST_SRC ?? "server";
const BASE = process.env.HEXWRIGHT_TEST_BASE ?? "main";

describe.skipIf(!REPO)("against an injected codebase", () => {
  let graph: Graph;

  beforeAll(() => {
    const profile = loadProfile(
      join(import.meta.dirname, "..", "profiles", "hexagonal-kotlin.yml"),
    );
    const det = detectSource(REPO as string, MODULE);
    const head = extractKotlin(det.srcAbs, profile, "test", "test");
    const { dir, cleanup } = exportRef(REPO as string, BASE, det.srcRel);
    try {
      const base = extractKotlin(join(dir, det.srcRel), profile, "test", BASE);
      graph = applyStatus(head, diff(base, head));
    } finally {
      cleanup();
    }
  }, 120_000);

  describe("view selection", () => {
    it("draws only what changed", () => {
      const { graph: g } = select(graph, "delta");
      expect(g.nodes.every((n) => n.status !== "existing")).toBe(true);
      const names = g.nodes.map((n) => n.name);
      expect(names).toContain("MediaLabelResolver"); // an added Service
      expect(names).toContain("MediaLabelQueryPort"); // an added Port
      expect(names).toContain("MediaService"); // a modified Service
      // Dependencies that were already there stay out — they are not this branch's doing
      expect(names).not.toContain("HeartRepository");
      expect(names).not.toContain("BestCutTimelineUseCase");
    });

    it("loses no new relation by narrowing to the change", () => {
      // Narrowing to the change must not drop any relation the branch introduced
      const all = graph.edges.filter((e) => e.status === "added" && !e.identifierOnly);
      const drawn = select(graph, "delta").graph.edges.filter((e) => e.status === "added");
      expect(all.length).toBeGreaterThan(0);
      expect(drawn.length).toBe(all.length);
    });

    it("impact adds what depends on the change", () => {
      const delta = select(graph, "delta").graph;
      const impact = select(graph, "impact").graph;
      expect(impact.nodes.length).toBeGreaterThan(delta.nodes.length);
      // What the wider view adds are the things depending on a changed type
      const changed = new Set(delta.nodes.map((n) => n.id));
      const extra = impact.nodes.filter((n) => !changed.has(n.id));
      expect(extra.length).toBeGreaterThan(0);
      for (const n of extra) {
        expect(
          impact.edges.some((e) => e.src === n.id && changed.has(e.dst)),
          `${n.name} should depend on something changed`,
        ).toBe(true);
      }
    });

    it("drops identifier-only references unless asked", () => {
      const bare = select(graph, "domain:media").graph;
      const withIds = select(graph, "domain:media", true).graph;
      expect(bare.edges.every((e) => !e.identifierOnly)).toBe(true);
      expect(withIds.edges.length).toBeGreaterThan(bare.edges.length);
    });

    it("scopes to one bounded context", () => {
      const { graph: g } = select(graph, "domain:record");
      expect(g.nodes.some((n) => n.domain === "record")).toBe(true);
      // Neighbouring domains stay, unrelated ones do not
      expect(g.nodes.every((n) => n.domain !== "admin")).toBe(true);
    });

    it("refuses the delta view when nothing changed", () => {
      const clean = {
        ...graph,
        nodes: graph.nodes.map((n) => ({ ...n, status: "existing" as const })),
      };
      expect(() => select(clean, "delta")).toThrow(/no structural change/);
    });
  });

  const LAYOUTS = ["organic", "grid", "hex"] as const;

  describe("svg", () => {
    it.each(LAYOUTS)("is well-formed XML — %s", (layout) => {
      const svg = renderSvg(select(graph, "delta").graph, { layout });
      let err = "";
      const doc = new DOMParser({
        onError: (_l, m) => {
          err += m;
        },
      }).parseFromString(svg, "image/svg+xml");
      expect(err).toBe("");
      expect(doc.documentElement?.nodeName).toBe("svg");
    });

    it.each(LAYOUTS)("is deterministic — same graph, same file (%s)", (layout) => {
      const sel = select(graph, "delta").graph;
      expect(renderSvg(sel, { layout })).toBe(renderSvg(sel, { layout }));
    });

    it("never lets domain boxes overlap", () => {
      // Overlapping boxes make a node look like it sits in someone else's domain.
      // delta may be a single domain, so use impact, which spans several.
      const sel = select(graph, "impact").graph;
      for (const layout of LAYOUTS) {
        const svg = renderSvg(sel, { layout });
        const boxes = [
          ...svg.matchAll(
            /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="10"/g,
          ),
        ].map((m) => ({
          x1: Number(m[1]),
          y1: Number(m[2]),
          x2: Number(m[1]) + Number(m[3]),
          y2: Number(m[2]) + Number(m[4]),
        }));
        expect(boxes.length, layout).toBeGreaterThan(1);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i] as (typeof boxes)[number];
            const b = boxes[j] as (typeof boxes)[number];
            const over =
              Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) &&
              Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1);
            expect(over, `${layout}: box ${i} × ${j}`).toBe(false);
          }
        }
      }
    });

    it("marks added and modified types distinctly", () => {
      const svg = renderSvg(select(graph, "delta").graph, { layout: "organic" });
      expect(svg).toContain("#f0883e"); // added
      expect(svg).toContain("#a371f7"); // modified
    });

    it("keeps red for violations only", () => {
      // A domain hue in the red or orange band destroys the at-a-glance violation reading
      const hue = hueMap(graph.nodes.map((n) => n.domain));
      for (const d of new Set(graph.nodes.map((n) => n.domain))) {
        if (d === "common" || d === "shared") continue;
        const h = hue(d);
        expect(h, `domain ${d}`).toBeGreaterThan(40);
        expect(h, `domain ${d}`).toBeLessThan(340);
      }
    });

    it("gives every pair of domains a distinguishable hue", () => {
      const doms = [...new Set(graph.nodes.map((n) => n.domain))].filter(
        (d) => d !== "common" && d !== "shared",
      );
      const hue = hueMap(graph.nodes.map((n) => n.domain));
      for (const a of doms) {
        for (const b of doms) {
          if (a >= b) continue;
          const d = Math.abs(hue(a) - hue(b));
          expect(Math.min(d, 360 - d), `${a} vs ${b}`).toBeGreaterThanOrEqual(15);
        }
      }
    });
  });

  describe("render command", () => {
    it("writes an svg and a png", async () => {
      const dir = mkdtempSync(join(tmpdir(), "hexwright-"));
      const png = join(dir, "delta.png");
      const { stdout } = await promisify(execFile)("node", [
        "src/cli.ts",
        "render",
        "--repo",
        REPO as string,
        "--src",
        MODULE,
        "--base",
        BASE,
        "--image",
        png,
      ]);
      expect(stdout).toContain("what this branch added and changed");
      const svg = readFileSync(join(dir, "delta.svg"), "utf8");
      expect(svg.startsWith("<svg")).toBe(true);
      // PNG is an optional dependency; when present it has to be a real image
      if (stdout.includes("delta.png")) {
        const bytes = readFileSync(png);
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        expect(bytes.length).toBeGreaterThan(10_000);
      }
    }, 180_000);
  });
});
