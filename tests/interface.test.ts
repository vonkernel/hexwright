import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import { type Exchange, exchange } from "../src/interface.ts";
import { loadProfile } from "../src/profile.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * What one bounded context uses from another.
 *
 * Two domains named with roles: a provider and a consumer. The answer is the
 * sentence a reviewer wants — this consumer class, which implements that port on
 * its own side, calls these operations on that provider interface, which these
 * classes implement.
 *
 * The fixture is a shop: `order` places orders and reaches `pay` to charge and
 * refund, and holds a payment's id without calling anything on it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const P = `${BASE_PACKAGE}.pay`;
const O = `${BASE_PACKAGE}.order`;

const FILES: Record<string, string> = {
  // -- pay: two inbound ports, three implementations between them
  "com/example/pay/application/port/inbound/ChargeUseCase.kt":
    `package ${P}.application.port.inbound\n\n` +
    "interface ChargeUseCase {\n" +
    "    fun charge(ref: String, amount: Long): Boolean\n" +
    "    fun cancel(ref: String)\n" +
    "    fun quote(ref: String): Long\n" +
    "}\n",
  "com/example/pay/application/port/inbound/RefundUseCase.kt":
    `package ${P}.application.port.inbound\n\n` +
    "interface RefundUseCase {\n    fun refund(ref: String): Boolean\n}\n",
  "com/example/pay/application/service/PayService.kt":
    `package ${P}.application.service\n\n` +
    `import ${P}.application.port.inbound.ChargeUseCase\n\n` +
    "class PayService : ChargeUseCase {\n" +
    "    override fun charge(ref: String, amount: Long): Boolean = true\n" +
    "    override fun cancel(ref: String) {}\n" +
    "    override fun quote(ref: String): Long = 0L\n" +
    "}\n",
  "com/example/pay/application/service/LedgerPayService.kt":
    `package ${P}.application.service\n\n` +
    `import ${P}.application.port.inbound.ChargeUseCase\n\n` +
    "class LedgerPayService : ChargeUseCase {\n" +
    "    override fun charge(ref: String, amount: Long): Boolean = false\n" +
    "    override fun cancel(ref: String) {}\n" +
    "    override fun quote(ref: String): Long = 1L\n" +
    "}\n",
  "com/example/pay/domain/model/Payment.kt":
    `package ${P}.domain.model\n\n` +
    "@JvmInline\nvalue class PaymentId(val value: String)\n\n" +
    "class Payment(val id: PaymentId, val amount: Long)\n",

  // -- order: an adapter behind its own port, and a service with no role
  "com/example/order/application/port/out/PaymentPort.kt":
    `package ${O}.application.port.out\n\n` +
    "interface PaymentPort {\n    fun charge(orderId: String, amount: Long): Boolean\n}\n",
  "com/example/order/adapter/out/PaymentAdapter.kt":
    `package ${O}.adapter.out\n\n` +
    `import ${O}.application.port.out.PaymentPort\n` +
    `import ${P}.application.port.inbound.ChargeUseCase\n\n` +
    "class PaymentAdapter(private val charging: ChargeUseCase) : PaymentPort {\n" +
    "    override fun charge(orderId: String, amount: Long): Boolean =\n" +
    "        charging.charge(orderId, amount)\n" +
    "    fun drop(orderId: String) = charging.cancel(orderId)\n" +
    "}\n",
  "com/example/order/application/service/ReconcileService.kt":
    `package ${O}.application.service\n\n` +
    `import ${P}.application.port.inbound.RefundUseCase\n\n` +
    "class ReconcileService(private val refunds: RefundUseCase) {\n" +
    "    fun sweep(ref: String): Boolean = refunds.refund(ref)\n" +
    "}\n",
  "com/example/order/domain/model/Order.kt":
    `package ${O}.domain.model\n\n` +
    `import ${P}.domain.model.PaymentId\n\n` +
    "class Order(val id: String, val paymentId: PaymentId)\n",
};

function shop(): Exchange {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-iface-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(FILES)) {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const g = extractKotlin(
    join(dir, SRC),
    loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE }),
    "shop",
    "HEAD",
  );
  return exchange(g, "pay", "order");
}

const contract = (x: Exchange, name: string) =>
  x.contracts.find((c) => c.iface.name === name) as NonNullable<
    ReturnType<Exchange["contracts"]["find"]>
  >;

describe("the contracts one domain reaches for", () => {
  it("keeps only the provider's interfaces, not everything it touches", () => {
    const x = shop();
    expect(x.contracts.map((c) => c.iface.name)).toEqual(["ChargeUseCase", "RefundUseCase"]);
    // Payment is reached too, but by id — see below, not here.
    expect(x.contracts.some((c) => c.iface.name === "Payment")).toBe(false);
  });

  it("marks the operations called and keeps the ones offered but not", () => {
    const ops = contract(shop(), "ChargeUseCase").operations;
    expect(ops).toEqual([
      { sig: "charge(ref: String, amount: Long): Boolean", used: true },
      { sig: "cancel(ref: String)", used: true },
      // Offered and never called. Dropping it would hide whether the consumer is
      // using the right part of the contract.
      { sig: "quote(ref: String): Long", used: false },
    ]);
  });

  it("lists who implements it on the provider's side", () => {
    expect(contract(shop(), "ChargeUseCase").implementations.map((n) => n.name)).toEqual([
      "LedgerPayService",
      "PayService",
    ]);
  });
});

describe("the consuming side", () => {
  it("carries what the consumer implements on its own side", () => {
    const c = contract(shop(), "ChargeUseCase").consumers[0];
    expect(c?.type.name).toBe("PaymentAdapter");
    expect(c?.implementsTypes.map((n) => n.name)).toEqual(["PaymentPort"]);
  });

  it("leaves a consumer with no role empty rather than inventing one", () => {
    const c = contract(shop(), "RefundUseCase").consumers[0];
    expect(c?.type.name).toBe("ReconcileService");
    expect(c?.implementsTypes).toEqual([]);
  });

  it("says which of the consumer's own methods reaches which operation", () => {
    const c = contract(shop(), "ChargeUseCase").consumers[0];
    expect(c?.from).toEqual([
      {
        method: "charge(orderId: String, amount: Long): Boolean",
        to: ["charge(ref: String, amount: Long): Boolean"],
      },
      { method: "drop(orderId: String)", to: ["cancel(ref: String)"] },
    ]);
  });
});

describe("what is held by id rather than called", () => {
  it("is reported apart from the contracts", () => {
    const x = shop();
    expect(x.idReferences.map((r) => `${r.from.name} -> ${r.to.name}`)).toEqual([
      "Order -> Payment",
    ]);
  });
});

describe("direction is part of the question", () => {
  it("answers nothing for the direction that has no dependency", () => {
    const dir = mkdtempSync(join(tmpdir(), "hexwright-iface-"));
    dirs.push(dir);
    for (const [rel, body] of Object.entries(FILES)) {
      const p = join(dir, SRC, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    const g = extractKotlin(
      join(dir, SRC),
      loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE }),
      "shop",
      "HEAD",
    );
    // `pay` uses nothing from `order`. That is an answer, and the caller needs to be
    // able to say so rather than render a blank picture.
    const back = exchange(g, "order", "pay");
    expect(back.empty).toBe(true);
    expect(back.contracts).toEqual([]);
    expect(back.idReferences).toEqual([]);
    expect(shop().empty).toBe(false);
  });
});
