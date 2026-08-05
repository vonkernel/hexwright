import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import type { Edge, Graph } from "../src/model.ts";
import { loadProfile } from "../src/profile.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * Which method does the calling.
 *
 * `contracts` says what a type uses of another; `calls` says which of its own
 * methods use it. The scan is split per method to find that out, and the risk of
 * splitting is losing what falls between methods — an `init` block, a property
 * initialiser — so most of these pin that nothing went missing.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PORT =
  `package ${BASE_PACKAGE}.pay.application.port.out\n\n` +
  "interface Gateway {\n" +
  "    fun charge(ref: String): Boolean\n" +
  "    fun cancel(ref: String)\n" +
  "    fun quote(ref: String): Long\n" +
  "}\n";

function graphOf(service: string): Graph {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-calls-"));
  dirs.push(dir);
  const files = {
    "com/example/pay/application/port/out/Gateway.kt": PORT,
    "com/example/pay/application/service/Caller.kt": service,
    "com/example/other/domain/model/Thing.kt": `package ${BASE_PACKAGE}.other.domain.model\n\nclass Thing(val id: String)\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return extractKotlin(
    join(dir, SRC),
    loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE }),
    "t",
    "HEAD",
  );
}

const toGateway = (g: Graph): Edge =>
  g.edges.find((e) => e.src.endsWith(".Caller") && e.dst.endsWith(".Gateway")) as Edge;

const svc = (body: string) =>
  `package ${BASE_PACKAGE}.pay.application.service\n\n` +
  `import ${BASE_PACKAGE}.pay.application.port.out.Gateway\n\n` +
  `class Caller(private val gw: Gateway) {\n${body}}\n`;

describe("calls are attributed to the method making them", () => {
  it("separates two methods calling different operations", () => {
    const e = toGateway(
      graphOf(
        svc(
          "    fun pay(ref: String): Boolean = gw.charge(ref)\n" +
            "    fun drop(ref: String) = gw.cancel(ref)\n",
        ),
      ),
    );
    // `pay` loses its return type here, and that is not this change: an expression
    // body ending in `)` swallows it in `collectSigs`, so `api` reads the same way.
    // `from` comes from the same signatures, which is the point — it should read
    // like the rest of the type's contract, warts included. Filed separately.
    expect(e.calls).toEqual([
      { from: "drop(ref: String)", to: ["cancel(ref: String)"] },
      { from: "pay(ref: String)", to: ["charge(ref: String): Boolean"] },
    ]);
  });

  it("groups two operations called from one method", () => {
    const e = toGateway(
      graphOf(
        svc("    fun both(ref: String) {\n        gw.charge(ref)\n        gw.cancel(ref)\n    }\n"),
      ),
    );
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0]?.to).toEqual(["cancel(ref: String)", "charge(ref: String): Boolean"]);
  });

  it("attributes a call inside a lambda to the method holding it", () => {
    const e = toGateway(
      graphOf(
        svc(
          "    fun many(refs: List<String>) {\n" +
            "        refs.forEach { gw.charge(it) }\n" +
            "    }\n",
        ),
      ),
    );
    expect(e.calls.map((c) => c.from)).toEqual(["many(refs: List<String>)"]);
  });
});

describe("nothing is lost by splitting the body", () => {
  it("keeps a call from an init block, with no caller", () => {
    const e = toGateway(
      graphOf(
        svc('    init {\n        gw.charge("boot")\n    }\n' + "    fun idle(): Long = 0L\n"),
      ),
    );
    // The region before the first method carries no name, but its calls are real.
    expect(e.contracts).toEqual(["charge(ref: String): Boolean"]);
    expect(e.calls).toEqual([{ from: "", to: ["charge(ref: String): Boolean"] }]);
  });

  it("keeps a call from a property initialiser", () => {
    const e = toGateway(graphOf(svc('    val ready: Long = gw.quote("x")\n')));
    expect(e.contracts).toEqual(["quote(ref: String): Long"]);
    expect(e.calls).toEqual([{ from: "", to: ["quote(ref: String): Long"] }]);
  });

  it("contracts still holds everything the type uses, wherever from", () => {
    const e = toGateway(
      graphOf(
        svc(
          '    init {\n        gw.charge("boot")\n    }\n' +
            "    fun drop(ref: String) = gw.cancel(ref)\n",
        ),
      ),
    );
    // The union over regions must equal what a single pass over the body found.
    expect(e.contracts).toEqual(["cancel(ref: String)", "charge(ref: String): Boolean"]);
    expect(e.calls.map((c) => c.from)).toEqual(["", "drop(ref: String)"]);
  });
});

describe("shape", () => {
  it("is empty for a type that calls nothing", () => {
    const g = graphOf(svc("    fun idle(): Long = 0L\n"));
    for (const e of g.edges) expect(e.calls).toEqual([]);
  });

  it("is empty on a relation that is not DEPENDS_ON", () => {
    const g = graphOf(
      `package ${BASE_PACKAGE}.pay.application.service\n\n` +
        `import ${BASE_PACKAGE}.pay.application.port.out.Gateway\n\n` +
        "class Caller : Gateway {\n" +
        "    override fun charge(ref: String): Boolean = true\n" +
        "    override fun cancel(ref: String) {}\n" +
        "    override fun quote(ref: String): Long = 0L\n" +
        "}\n",
    );
    const impl = g.edges.find((e) => e.rel === "IMPLEMENTS") as Edge;
    expect(impl.calls).toEqual([]);
  });
});
