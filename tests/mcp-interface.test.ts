import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * `domain_interface` over a real stdio server.
 *
 * The answer is prose an agent reads, so these assert the words it has to contain —
 * above all `free`, which marks an operation the provider offers and nobody calls.
 * That is the line that stops an agent adding a second operation doing what an
 * existing one already does.
 */

let client: Client;
let repo: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "hexwright-mcp-iface-"));
  const w = (rel: string, body: string) => {
    const p = join(repo, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  w(
    "com/example/pay/application/port/inbound/ChargeUseCase.kt",
    `package ${BASE_PACKAGE}.pay.application.port.inbound\n\n` +
      "interface ChargeUseCase {\n" +
      "    fun charge(ref: String, amount: Long): Boolean\n" +
      "    fun quote(ref: String): Long\n" +
      "}\n",
  );
  w(
    "com/example/pay/application/service/PayService.kt",
    `package ${BASE_PACKAGE}.pay.application.service\n\n` +
      `import ${BASE_PACKAGE}.pay.application.port.inbound.ChargeUseCase\n\n` +
      "class PayService : ChargeUseCase {\n" +
      "    override fun charge(ref: String, amount: Long): Boolean = true\n" +
      "    override fun quote(ref: String): Long = 0L\n}\n",
  );
  w(
    "com/example/order/application/port/out/PaymentPort.kt",
    `package ${BASE_PACKAGE}.order.application.port.out\n\n` +
      "interface PaymentPort {\n    fun pay(id: String, amount: Long): Boolean\n}\n",
  );
  w(
    "com/example/order/adapter/out/PaymentAdapter.kt",
    `package ${BASE_PACKAGE}.order.adapter.out\n\n` +
      `import ${BASE_PACKAGE}.order.application.port.out.PaymentPort\n` +
      `import ${BASE_PACKAGE}.pay.application.port.inbound.ChargeUseCase\n\n` +
      "class PaymentAdapter(private val gw: ChargeUseCase) : PaymentPort {\n" +
      "    override fun pay(id: String, amount: Long): Boolean = gw.charge(id, amount)\n}\n",
  );

  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["src/cli.ts", "mcp", "--repo", repo, "--src", SRC, "--base-package", BASE_PACKAGE],
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(repo, { recursive: true, force: true });
});

const call = async (args: Record<string, string>): Promise<string> => {
  const r = (await client.callTool({ name: "domain_interface", arguments: args })) as {
    content: { text: string }[];
  };
  return r.content.map((c) => c.text).join("\n");
};

describe("domain_interface", () => {
  it("is offered alongside the other tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("domain_interface");
  });

  it("answers with the contract, the caller and the file to open", async () => {
    const text = await call({ provider: "pay", consumer: "order" });
    expect(text).toContain("order → pay");
    expect(text).toContain("ChargeUseCase [UseCase]");
    expect(text).toContain("used   charge(ref: String, amount: Long): Boolean");
    expect(text).toContain("PaymentAdapter : PaymentPort");
    expect(text).toContain("pay(id: String, amount: Long): Boolean → charge");
    expect(text).toContain("impl   PayService");
    // An answer that names no file leaves the agent grepping for it.
    expect(text).toMatch(/ChargeUseCase\.kt:\d+/);
  });

  it("marks an operation offered and never called as free", async () => {
    const text = await call({ provider: "pay", consumer: "order" });
    // The whole reason to ask before adding a call across a boundary.
    expect(text).toContain("free   quote(ref: String): Long");
  });

  it("says which direction to try when there is nothing this way", async () => {
    const text = await call({ provider: "order", consumer: "pay" });
    expect(text).toContain("pay uses nothing from order");
    // The suggestion has to be the *other* direction, not the arguments echoed back.
    expect(text).toContain("try provider pay, consumer order");
  });

  it("lists the domains that exist when one is misspelled", async () => {
    const text = await call({ provider: "payy", consumer: "order" });
    expect(text).toContain("no such domain for provider: payy");
    expect(text).toContain("order, pay");
  });

  it("refuses a domain against itself", async () => {
    expect(await call({ provider: "pay", consumer: "pay" })).toContain("no boundary with itself");
  });
});
