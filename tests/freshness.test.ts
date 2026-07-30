import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BASE_PACKAGE, type Fixture, SRC, makeFixture } from "./fixture.ts";

/**
 * An agent that edits code and then asks must get the answer for the edited code.
 *
 * This used to hand out the snapshot taken at start-up, so introducing a
 * violation still answered "none".
 */
let fx: Fixture;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  return r.content[0]?.text ?? "";
};

const probe = join("com/example/pay/application/service/Probe.kt");

beforeAll(async () => {
  fx = makeFixture();
  client = new Client({ name: "fresh", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["src/cli.ts", "mcp", ...fx.args()],
    }),
  );
}, 60_000);

afterAll(() => rmSync(fx.dir, { recursive: true, force: true }));

it("reflects a type added after the server started", async () => {
  expect(await call("dependencies", { name: "BrandNewProbeService" })).toContain("not found");

  fx.write(
    probe,
    `package ${BASE_PACKAGE}.pay.application.service\n\n` +
      "class BrandNewProbeService {\n" +
      '    fun ping(): String = "pong"\n' +
      "}\n",
  );

  const t = await call("dependencies", { name: "BrandNewProbeService" });
  expect(t).toContain("BrandNewProbeService");
  expect(t).toContain("[Service] pay");
}, 60_000);

it("reflects a boundary violation introduced after the server started", async () => {
  const before = await call("check_violations");
  expect(before).toContain("no violations");

  // Make an inbound adapter touch an Entity — exactly what the rule catches
  fx.write(
    "com/example/pay/adapter/web/ProbeController.kt",
    `package ${BASE_PACKAGE}.pay.adapter.web\n\n` +
      `import ${BASE_PACKAGE}.pay.domain.model.Payment\n\n` +
      "class ProbeController {\n" +
      "    fun leak(p: Payment): Payment = p\n" +
      "}\n",
  );

  const after = await call("check_violations");
  expect(after).toContain("1 violation(s)");
  expect(after).toContain("ProbeController");
  expect(after).toContain("inbound adapter touches Entity");
});

it("notices a deletion, which leaves other files' mtimes untouched", async () => {
  // Newest mtime alone misses a deletion — the fingerprint needs the file count
  rmSync(join(fx.dir, SRC, probe));
  expect(await call("dependencies", { name: "BrandNewProbeService" })).toContain("not found");
});
