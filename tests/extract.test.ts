import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import type { Graph } from "../src/model.ts";
import { loadProfile } from "../src/profile.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * Attribution: which declaration a reference is counted against.
 *
 * A declaration's body used to run to the next `class`/`interface`/`object`, so a
 * top-level construct between two declarations was read as part of the one above
 * it — reporting a boundary breach against a type that did not have one. These
 * suites pin both halves: the construct must not be misattributed, and a
 * reference that genuinely runs through a `typealias` must still be found.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The Entity every case below points at, plus a second domain so inference has a prefix. */
const ENTITY = `package ${BASE_PACKAGE}.media.domain.model\n\nclass MediaIncident(val id: String)\n`;
const OTHER = `package ${BASE_PACKAGE}.pay.domain.model\n\nclass Payment(val id: String)\n`;

function graphOf(files: Record<string, string>): Graph {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-extract-"));
  dirs.push(dir);
  const all = {
    "com/example/media/domain/model/MediaIncident.kt": ENTITY,
    "com/example/pay/domain/model/Payment.kt": OTHER,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const profile = loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE });
  return extractKotlin(join(dir, SRC), profile, "t", "HEAD");
}

/** Every violation, as `Src -> Dst: message`, with packages stripped for readability. */
const violations = (g: Graph): string[] =>
  g.edges
    .filter((e) => e.violation)
    .map((e) => `${e.src.split(".").pop()} -> ${e.dst.split(".").pop()}: ${e.violation}`);

const deps = (g: Graph, from: string): string[] =>
  g.edges.filter((e) => e.src.endsWith(`.${from}`)).map((e) => e.dst.split(".").pop() as string);

describe("a top-level construct is not attributed to the declaration above it", () => {
  // The port file declares a DTO, then the construct under test, then the interface.
  // The interface's own signature never names the Entity, so any violation reported
  // against the DTO can only have come from the construct in between.
  const portFile = (between: string): Record<string, string> => ({
    "com/example/media/application/port/out/MediaIncidentRepository.kt":
      `package ${BASE_PACKAGE}.media.application.port.out\n\n` +
      `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
      "data class IncidentListFilter(\n" +
      "    val status: String?,\n" +
      "    val query: String?,\n" +
      ")\n\n" +
      between +
      "interface MediaIncidentRepository {\n" +
      "    fun list(filter: IncidentListFilter, limit: Int): List<String>\n" +
      "}\n",
  });

  const cases: [string, string][] = [
    ["typealias", "typealias IncidentSlice = List<MediaIncident>\n\n"],
    ["a file-level function", "fun summarize(i: MediaIncident): String = i.id\n\n"],
    ["a file-level property", "val EMPTY: List<MediaIncident> = emptyList()\n\n"],
    ["a file-level constant", 'const val TAG: String = "MediaIncident"\n\n'],
  ];

  it("reports nothing when there is no construct in between", () => {
    const g = graphOf(portFile(""));
    expect(violations(g)).toEqual([]);
    expect(deps(g, "IncidentListFilter")).toEqual([]);
  });

  for (const [label, between] of cases) {
    it(`is not folded into the DTO above it — ${label}`, () => {
      const g = graphOf(portFile(between));
      expect(deps(g, "IncidentListFilter")).toEqual([]);
      expect(violations(g)).toEqual([]);
    });
  }

  it("still declares the surrounding types", () => {
    const g = graphOf(portFile("typealias IncidentSlice = List<MediaIncident>\n\n"));
    const names = g.nodes.map((n) => n.name).sort();
    expect(names).toContain("IncidentListFilter");
    expect(names).toContain("MediaIncidentRepository");
    // The alias stands for its right-hand side; it is not a type of its own.
    expect(names).not.toContain("IncidentSlice");
  });
});

describe("a reference through a typealias is still found", () => {
  // Dropping the alias rather than resolving it would turn the false positive above
  // into a false negative — these pin that it does not.

  it("keeps the edge when a Port reaches an Entity through an alias", () => {
    const g = graphOf({
      "com/example/media/application/port/out/MediaIncidentRepository.kt":
        `package ${BASE_PACKAGE}.media.application.port.out\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "typealias IncidentSlice = List<MediaIncident>\n\n" +
        "interface MediaIncidentRepository {\n" +
        "    fun list(limit: Int): IncidentSlice\n" +
        "}\n",
    });
    expect(deps(g, "MediaIncidentRepository")).toEqual(["MediaIncident"]);
    // A Port may touch an Entity — the edge is real, the verdict is clean.
    expect(violations(g)).toEqual([]);
  });

  it("catches a breach expressed through an alias", () => {
    const g = graphOf({
      "com/example/media/application/port/inbound/IncidentPage.kt":
        `package ${BASE_PACKAGE}.media.application.port.inbound\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "typealias IncidentSlice = List<MediaIncident>\n\n" +
        "data class IncidentPage(\n" +
        "    val items: IncidentSlice,\n" +
        ")\n",
    });
    expect(violations(g)).toEqual(["IncidentPage -> MediaIncident: DTO exposes Entity"]);
  });

  it("resolves an alias imported from another file", () => {
    // The importing file never names the Entity — importing the alias instead of the
    // underlying type is the point of one, so its bindings have to travel with it.
    const g = graphOf({
      "com/example/media/application/port/out/Aliases.kt":
        `package ${BASE_PACKAGE}.media.application.port.out\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "typealias IncidentSlice = List<MediaIncident>\n",
      "com/example/media/application/port/inbound/IncidentPage.kt":
        `package ${BASE_PACKAGE}.media.application.port.inbound\n\n` +
        `import ${BASE_PACKAGE}.media.application.port.out.IncidentSlice\n\n` +
        "data class IncidentPage(\n" +
        "    val items: IncidentSlice,\n" +
        ")\n",
    });
    expect(violations(g)).toEqual(["IncidentPage -> MediaIncident: DTO exposes Entity"]);
  });

  it("resolves an alias of an alias", () => {
    const g = graphOf({
      "com/example/media/application/port/inbound/IncidentPage.kt":
        `package ${BASE_PACKAGE}.media.application.port.inbound\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "typealias IncidentSlice = List<MediaIncident>\n" +
        "typealias IncidentFeed = IncidentSlice\n\n" +
        "data class IncidentPage(\n" +
        "    val items: IncidentFeed,\n" +
        ")\n",
    });
    expect(violations(g)).toEqual(["IncidentPage -> MediaIncident: DTO exposes Entity"]);
  });
});

describe("`fun interface` is a declaration, not a file-level function", () => {
  it("becomes a node and keeps its own body", () => {
    const g = graphOf({
      "com/example/media/application/port/out/IncidentSink.kt":
        `package ${BASE_PACKAGE}.media.application.port.out\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "fun interface IncidentSink {\n" +
        "    fun accept(i: MediaIncident)\n" +
        "}\n",
    });
    expect(g.nodes.map((n) => n.name)).toContain("IncidentSink");
    expect(deps(g, "IncidentSink")).toEqual(["MediaIncident"]);
  });
});
