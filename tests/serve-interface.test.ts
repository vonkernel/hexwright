import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import type { Graph } from "../src/model.ts";
import { loadProfile } from "../src/profile.ts";
import { serveHttp } from "../src/view/server.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * The interface tab's data path.
 *
 * The picture is rendered on the server with the same function the CLI writes to a
 * file, so the tab and a pull request's image cannot drift apart. These pin that
 * route, and that the refusals are refusals rather than a broken-looking blank.
 */

let url: string;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hexwright-serve-"));
  const w = (rel: string, body: string) => {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  w(
    "com/example/pay/application/port/inbound/ChargeUseCase.kt",
    `package ${BASE_PACKAGE}.pay.application.port.inbound\n\n` +
      "interface ChargeUseCase {\n    fun charge(ref: String): Boolean\n}\n",
  );
  w(
    "com/example/order/adapter/out/PaymentAdapter.kt",
    `package ${BASE_PACKAGE}.order.adapter.out\n\n` +
      `import ${BASE_PACKAGE}.pay.application.port.inbound.ChargeUseCase\n\n` +
      "class PaymentAdapter(private val gw: ChargeUseCase) {\n" +
      "    fun pay(id: String): Boolean = gw.charge(id)\n}\n",
  );
  const graph: Graph = extractKotlin(
    join(dir, SRC),
    loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE }),
    "t",
    "HEAD",
  );
  // Port 0 asks the OS for a free one, so a busy port cannot make this flaky.
  url = await serveHttp({ port: 0, graph: () => graph });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the interface route", () => {
  it("returns the same picture the command writes", async () => {
    const res = await fetch(`${url}/api/interface?provider=pay&consumer=order`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("ChargeUseCase");
    expect(svg).toContain("PaymentAdapter");
  });

  it("says so for a direction with no dependency, rather than erroring", async () => {
    const res = await fetch(`${url}/api/interface?provider=order&consumer=pay`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pay uses nothing from order.");
  });

  it("refuses a domain that does not exist", async () => {
    const res = await fetch(`${url}/api/interface?provider=nope&consumer=order`);
    expect(res.status).toBe(400);
  });

  it("refuses a domain against itself", async () => {
    const res = await fetch(`${url}/api/interface?provider=pay&consumer=pay`);
    expect(res.status).toBe(400);
  });

  it("refuses when a role is missing entirely", async () => {
    const res = await fetch(`${url}/api/interface?provider=pay`);
    expect(res.status).toBe(400);
  });
});

describe("the shell carries the tab", () => {
  it("ships both tabs and the two pickers", async () => {
    const html = await (await fetch(url)).text();
    for (const id of ['id="tgraph"', 'id="tiface"', 'id="selProvider"', 'id="selConsumer"']) {
      expect(html, id).toContain(id);
    }
  });

  it("keeps the graph controls in a block the tab can hide", async () => {
    const html = await (await fetch(url)).text();
    expect(html).toContain('id="graphCtl"');
    expect(html).toContain('id="ifaceCtl"');
  });
});
