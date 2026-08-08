import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * `hexwright interface` end to end.
 *
 * Roles are required and have to name real domains, and getting either wrong is the
 * likely mistake — so the refusals matter as much as the drawing, and each one has
 * to say what to do instead.
 */

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "hexwright-iface-cli-"));
  const w = (rel: string, body: string) => {
    const p = join(repo, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  w(
    "com/example/pay/application/port/inbound/ChargeUseCase.kt",
    `package ${BASE_PACKAGE}.pay.application.port.inbound\n\n` +
      "interface ChargeUseCase {\n    fun charge(ref: String): Boolean\n}\n",
  );
  w(
    "com/example/pay/application/service/PayService.kt",
    `package ${BASE_PACKAGE}.pay.application.service\n\n` +
      `import ${BASE_PACKAGE}.pay.application.port.inbound.ChargeUseCase\n\n` +
      "class PayService : ChargeUseCase {\n" +
      "    override fun charge(ref: String): Boolean = true\n}\n",
  );
  w(
    "com/example/order/adapter/out/PaymentAdapter.kt",
    `package ${BASE_PACKAGE}.order.adapter.out\n\n` +
      `import ${BASE_PACKAGE}.pay.application.port.inbound.ChargeUseCase\n\n` +
      "class PaymentAdapter(private val gw: ChargeUseCase) {\n" +
      "    fun pay(id: String): Boolean = gw.charge(id)\n}\n",
  );
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Run the command and return its exit code with everything it printed. */
function run(...extra: string[]): { code: number; out: string } {
  const args = [
    "src/cli.ts",
    "interface",
    "--repo",
    repo,
    "--src",
    SRC,
    "--project",
    "t",
    "--base-package",
    BASE_PACKAGE,
    ...extra,
  ];
  try {
    return { code: 0, out: execFileSync("node", args, { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: `${x.stdout}${x.stderr}` };
  }
}

describe("it refuses, and says what to do instead", () => {
  it("needs both roles", () => {
    const r = run("--provider", "pay");
    expect(r.code).toBe(1);
    expect(r.out).toContain("--provider <domain> and --consumer <domain>");
  });

  it("names the domains that exist when one does not", () => {
    const r = run("--provider", "nope", "--consumer", "order");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no such domain for --provider: nope");
    // Guessing the spelling is the whole difficulty; list them.
    expect(r.out).toContain("order, pay");
  });

  it("refuses a domain against itself", () => {
    const r = run("--provider", "pay", "--consumer", "pay");
    expect(r.code).toBe(1);
    expect(r.out).toContain("no boundary between them");
  });
});

describe("it draws", () => {
  it("writes the file and reports what went in it", () => {
    const out = join(repo, "out", "iface.svg");
    const r = run("--provider", "pay", "--consumer", "order", "--image", out);
    expect(r.code).toBe(0);
    expect(r.out).toContain("order → pay");
    expect(r.out).toContain("1 contracts · 1 operations used");
    // The directory did not exist; the command makes it.
    expect(existsSync(out)).toBe(true);
  });

  it("reports the empty direction rather than pretending it drew something", () => {
    const out = join(repo, "out", "rev.svg");
    const r = run("--provider", "order", "--consumer", "pay", "--image", out);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pay uses nothing from order");
    // Still a file: a caller rendering both halves should not have to special-case it.
    expect(existsSync(out)).toBe(true);
  });
});
