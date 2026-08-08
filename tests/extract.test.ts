import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import type { Graph } from "../src/model.ts";
import { loadProfile } from "../src/profile.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * What counts as a reference, and which declaration it counts against.
 *
 * Both halves have produced a boundary verdict against a type whose code does not
 * touch the entity: a top-level construct read as part of the declaration above it
 * (#4), and a type named inside a string literal (#7).
 *
 * Each suite pins the fix in both directions. Removing a false positive is only an
 * improvement if the reference that was really there is still found — through a
 * `typealias`, or through the code inside a `${…}` template.
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

describe("a type named in a string is a mention, not a reference", () => {
  /** A Service body wrapped around whatever is under test. A Service may touch an
   *  Entity, so the DTO below it is what any false verdict lands on. */
  const serviceWith = (line: string): Record<string, string> => ({
    "com/example/media/application/service/IncidentService.kt":
      `package ${BASE_PACKAGE}.media.application.service\n\n` +
      `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
      "class IncidentService {\n" +
      `    ${line}\n` +
      "}\n",
  });

  const mentions: [string, string][] = [
    ["a plain string", 'fun describe() = "no MediaIncident on this page"'],
    ["a constant", 'val tag: String = "MediaIncident"'],
    ["an escaped quote", 'fun describe() = "say \\"MediaIncident\\" now"'],
    ["a template with no expression", 'fun describe() = "a MediaIncident, plain"'],
  ];

  for (const [label, line] of mentions) {
    it(`is not counted — ${label}`, () => {
      const g = graphOf(serviceWith(line));
      expect(deps(g, "IncidentService")).toEqual([]);
    });
  }

  it("still counts a reference in code beside the string", () => {
    const g = graphOf(serviceWith('fun keep(i: MediaIncident) = "MediaIncident"'));
    expect(deps(g, "IncidentService")).toEqual(["MediaIncident"]);
  });

  it("keeps code inside a ${} template", () => {
    // Blanking the whole literal would drop this call and lose a real edge.
    const g = graphOf({
      "com/example/media/application/service/IncidentService.kt":
        `package ${BASE_PACKAGE}.media.application.service\n\n` +
        `import ${BASE_PACKAGE}.media.application.port.out.MediaIncidentRepository\n\n` +
        "class IncidentService(private val repo: MediaIncidentRepository) {\n" +
        '    fun describe(id: String) = "found ${repo.findById(id)}"\n' +
        "}\n",
      "com/example/media/application/port/out/MediaIncidentRepository.kt":
        `package ${BASE_PACKAGE}.media.application.port.out\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "interface MediaIncidentRepository {\n" +
        "    fun findById(id: String): MediaIncident?\n" +
        "}\n",
    });
    // The call is found, and through its signature so is the Entity it returns.
    expect(deps(g, "IncidentService").sort()).toEqual(["MediaIncident", "MediaIncidentRepository"]);
  });

  it("blanks a string nested inside a template", () => {
    const g = graphOf(
      serviceWith('fun describe(xs: List<String>) = "${xs.joinToString("MediaIncident")}"'),
    );
    expect(deps(g, "IncidentService")).toEqual([]);
  });

  it("blanks a raw string, and keeps its template", () => {
    const g = graphOf({
      "com/example/media/application/service/IncidentService.kt":
        `package ${BASE_PACKAGE}.media.application.service\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "class IncidentService {\n" +
        '    fun query(i: String) = """\n' +
        "        select * from MediaIncident\n" +
        "        where id = ${i}\n" +
        '    """\n' +
        "}\n",
    });
    expect(deps(g, "IncidentService")).toEqual([]);
  });

  it("does not let an unterminated string swallow the next line", () => {
    const g = graphOf({
      "com/example/media/application/service/IncidentService.kt":
        `package ${BASE_PACKAGE}.media.application.service\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "class IncidentService {\n" +
        '    val broken = "MediaIncident\n' +
        "    fun keep(i: MediaIncident) = i\n" +
        "}\n",
    });
    expect(deps(g, "IncidentService")).toEqual(["MediaIncident"]);
  });
});

describe("a companion object's references are not the enclosing type's", () => {
  /** The shape from the report: a sealed root whose companion builds its variants. */
  const SEALED =
    `package ${BASE_PACKAGE}.media.domain.model\n\n` +
    "sealed class MediaItem(val id: String) {\n" +
    "    companion object {\n" +
    "        fun photo(id: String): Photo = Photo(id)\n" +
    "        fun video(id: String): Video = Video(id)\n" +
    "    }\n" +
    "}\n\n" +
    "class Photo(id: String) : MediaItem(id)\n\n" +
    "class Video(id: String) : MediaItem(id)\n";

  it("does not make a supertype depend on its own subtype", () => {
    // The dependency direction of an inheritance relationship is defined: the
    // subtype knows the supertype. A supertype depending on its subtype is not a
    // statement object-oriented design has a meaning for.
    const g = graphOf({ "com/example/media/domain/model/MediaItem.kt": SEALED });
    expect(deps(g, "MediaItem")).toEqual([]);
    expect(g.edges.map((e) => `${e.src.split(".").pop()} ${e.rel}`).sort()).toEqual([
      "Photo EXTENDS",
      "Video EXTENDS",
    ]);
  });

  it("keeps the same reference when it is an ordinary member", () => {
    // The discriminator is "inside the companion", not "is a subtype" — an instance
    // method returning Video really is a dependency of MediaItem.
    const g = graphOf({
      "com/example/media/domain/model/MediaItem.kt":
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        "sealed class MediaItem(val id: String) {\n" +
        "    fun asVideo(): Video = Video(id)\n" +
        "}\n\n" +
        "class Video(id: String) : MediaItem(id)\n",
    });
    expect(deps(g, "MediaItem")).toEqual(["Video"]);
  });

  it("does not attribute a companion factory's collaborators to a value class", () => {
    const g = graphOf({
      "com/example/media/domain/model/MediaId.kt":
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        `import ${BASE_PACKAGE}.common.IdGenerator\n\n` +
        "@JvmInline\nvalue class MediaId(val value: String) {\n" +
        "    companion object {\n" +
        "        fun new(): MediaId = MediaId(IdGenerator.newId())\n" +
        "    }\n" +
        "}\n",
      "com/example/common/IdGenerator.kt": `package ${BASE_PACKAGE}.common\n\nobject IdGenerator {\n    fun newId(): String = ""\n}\n`,
    });
    // A value class wrapping a String has no knowledge of an id generator.
    expect(deps(g, "MediaId")).toEqual([]);
  });

  it("keeps the enclosing type's own members", () => {
    const g = graphOf({
      "com/example/media/application/service/IncidentService.kt":
        `package ${BASE_PACKAGE}.media.application.service\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "class IncidentService {\n" +
        "    fun keep(i: MediaIncident) = i\n" +
        "    companion object {\n" +
        '        const val TAG: String = "x"\n' +
        "    }\n" +
        "    fun alsoKeep(i: MediaIncident) = i\n" +
        "}\n",
    });
    // The companion sits between two members; blanking it must not take them too.
    expect(deps(g, "IncidentService")).toEqual(["MediaIncident"]);
    expect(g.nodes.find((n) => n.name === "IncidentService")?.api.sort()).toEqual([
      "alsoKeep(i: MediaIncident)",
      "keep(i: MediaIncident)",
    ]);
  });

  it("handles a companion with a supertype and one with no body", () => {
    const g = graphOf({
      "com/example/media/application/service/Thing.kt":
        `package ${BASE_PACKAGE}.media.application.service\n\n` +
        `import ${BASE_PACKAGE}.media.domain.model.MediaIncident\n\n` +
        "class Thing {\n" +
        "    companion object : Marker {\n" +
        "        fun make(): MediaIncident? = null\n" +
        "    }\n" +
        '    fun own(): String = ""\n' +
        "}\n\n" +
        "interface Marker\n\n" +
        "class Bare {\n" +
        "    companion object\n" +
        "    fun own(i: MediaIncident) = i\n" +
        "}\n",
    });
    // A companion implementing an interface used to surface as the class depending
    // on it; neither the supertype nor the factory's return type is Thing's.
    expect(deps(g, "Thing")).toEqual([]);
    // A bodyless companion must not swallow the rest of the class.
    expect(deps(g, "Bare")).toEqual(["MediaIncident"]);
  });
});

describe("a signature keeps its return type", () => {
  /** Every shape below is one class, so one extraction answers all of them. */
  const api = (methods: string): string[] => {
    const g = graphOf({
      "com/example/media/application/service/Shapes.kt": `package ${BASE_PACKAGE}.media.application.service\n\nclass Shapes {\n${methods}}\n`,
    });
    return (g.nodes.find((n) => n.name === "Shapes")?.api ?? []).sort();
  };

  it("survives an expression body that ends in a call", () => {
    // The return type used to be read as whatever followed the *last* `)` on the
    // line, which an expression body ending in a call leaves empty.
    expect(api("    fun expr(ref: String): Boolean = ref.isEmpty()\n")).toEqual([
      "expr(ref: String): Boolean",
    ]);
  });

  it("survives a generic return type on an expression body", () => {
    expect(api("    fun generic(): Map<String, List<Int>> = emptyMap()\n")).toEqual([
      "generic(): Map<String, List<Int>>",
    ]);
  });

  it("survives a parameter list spread over several lines", () => {
    // The call in the body is what makes this a case: without one there is no second
    // `)` on the closing line and the old reading happened to land correctly.
    expect(
      api("    fun multi(\n        a: Int,\n        b: Int,\n    ): Boolean = a.equals(b)\n"),
    ).toEqual(["multi(a: Int, b: Int,): Boolean"]);
  });

  it("keeps a function type, whose own brackets could be mistaken for the list", () => {
    expect(api("    fun fnType(): (String) -> Unit = {}\n")).toEqual([
      "fnType(): (String) -> Unit",
    ]);
  });

  it("is unchanged for the shapes that already worked", () => {
    // A block body ends the line at `{`, and an expression body with no call has no
    // second `)`. Neither ever met the defect, and neither may move now.
    expect(
      api(
        "    fun block(ref: String): Boolean {\n        return true\n    }\n" +
          "    fun simple(ref: String): Boolean = true\n",
      ),
    ).toEqual(["block(ref: String): Boolean", "simple(ref: String): Boolean"]);
  });

  it("adds nothing where the source declares nothing", () => {
    expect(api("    fun inferred(ref: String) = ref.trim()\n")).toEqual(["inferred(ref: String)"]);
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
