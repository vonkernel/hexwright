import { describe, expect, it } from "vitest";
import type { Exchange } from "../src/interface.ts";
import type { Node } from "../src/model.ts";
import { renderExchange } from "../src/render/exchange.ts";

/**
 * The interface view as an image.
 *
 * Built from hand-made data rather than an extraction, so the renderer is tested
 * on its own — including the shapes an extraction of the fixture never produces,
 * such as a contract nobody implements here.
 *
 * These assert that everything derived reaches the picture. A renderer fails
 * quietly: it still writes a well-formed file, just without the part it dropped.
 */

const node = (name: string, over: Partial<Node> = {}): Node => ({
  id: `com.example.pay.${name}`,
  name,
  domain: "pay",
  component: "UseCase",
  layer: "application",
  sublayer: "port/inbound",
  kind: "interface",
  adapterKind: "",
  api: [],
  props: [],
  file: `${name}.kt`,
  line: 1,
  ...over,
});

const base: Exchange = {
  provider: "pay",
  consumer: "order",
  contracts: [
    {
      iface: node("ChargeUseCase"),
      operations: [
        { sig: "charge(ref: String): Boolean", used: true },
        { sig: "quote(ref: String): Long", used: false },
      ],
      consumers: [
        {
          type: node("PaymentAdapter", { domain: "order", component: "Adapter" }),
          implementsTypes: [node("PaymentPort", { domain: "order", component: "Port" })],
          calls: ["charge(ref: String): Boolean"],
          from: [{ method: "pay(id: String): Boolean", to: ["charge(ref: String): Boolean"] }],
        },
      ],
      implementations: [node("PayService", { component: "Service" })],
    },
  ],
  idReferences: [],
  empty: false,
};

const svgOf = (x: Partial<Exchange> = {}) => renderExchange({ ...base, ...x });

describe("everything derived reaches the picture", () => {
  it("names the contract, its component and both sides", () => {
    const svg = svgOf();
    for (const s of ["ChargeUseCase", "UseCase", "PaymentAdapter", "PayService"]) {
      expect(svg, s).toContain(s);
    }
  });

  it("carries the consumer's own role and the method that calls", () => {
    const svg = svgOf();
    expect(svg).toContain(": PaymentPort");
    expect(svg).toContain("pay(id: String): Boolean");
  });

  it("draws an unused operation differently from a used one", () => {
    const svg = svgOf();
    expect(svg).toContain("charge(ref: String): Boolean");
    expect(svg).toContain("quote(ref: String): Long");
    // The marker is filled for one and hollow for the other; both are present.
    expect(svg).toMatch(/<circle[^>]*fill="hsl\([^"]*"[^>]*\/>/);
    expect(svg).toMatch(/<circle[^>]*fill="none"[^>]*\/>/);
  });

  it("draws one line per operation a method reaches", () => {
    const two = svgOf({
      contracts: [
        {
          ...base.contracts[0],
          consumers: [
            {
              ...base.contracts[0]?.consumers[0],
              from: [
                {
                  method: "pay(id: String): Boolean",
                  to: ["charge(ref: String): Boolean", "quote(ref: String): Long"],
                },
              ],
            },
          ],
        },
      ],
    } as Partial<Exchange>);
    // Each landed line ends in its own arrowhead.
    const heads = [...two.matchAll(/l-7,-3\.4 l0,6\.8 z/g)];
    expect(heads).toHaveLength(2);
  });
});

describe("absence is information, not a blank", () => {
  it("says so when nobody here implements the contract", () => {
    const svg = svgOf({
      contracts: [{ ...base.contracts[0], implementations: [] }],
    } as Partial<Exchange>);
    expect(svg).toContain("no implementation here");
    expect(svg).toContain("another module, or not yet");
  });

  it("writes a sentence when the consumer uses nothing", () => {
    const svg = renderExchange({
      provider: "pay",
      consumer: "order",
      contracts: [],
      idReferences: [],
      empty: true,
    });
    expect(svg).toContain("order uses nothing from pay.");
    expect(svg).toContain("Try the other direction.");
  });

  it("keeps what is held by id apart, under its own heading", () => {
    const svg = svgOf({
      idReferences: [
        {
          from: node("Order", { domain: "order", component: "Entity" }),
          to: node("Payment", { component: "Entity" }),
        },
      ],
    });
    expect(svg).toContain("held by id, not called");
    expect(svg).toContain("Order");
    expect(svg).toContain("Payment");
  });
});

describe("the file itself", () => {
  it("is well formed and sized to its content", () => {
    const one = svgOf();
    const three = svgOf({
      contracts: [base.contracts[0], base.contracts[0], base.contracts[0]],
    } as Partial<Exchange>);
    const h = (s: string) => Number(/height="(\d+)"/.exec(s)?.[1]);
    expect(one.startsWith("<svg")).toBe(true);
    expect(one.trimEnd().endsWith("</svg>")).toBe(true);
    expect(h(three)).toBeGreaterThan(h(one));
  });

  it("escapes a name that would otherwise break the markup", () => {
    const svg = svgOf({
      contracts: [{ ...base.contracts[0], iface: node("Query<T & U>") }],
    } as Partial<Exchange>);
    expect(svg).toContain("Query&lt;T &amp; U&gt;");
    expect(svg).not.toContain("Query<T & U>");
  });
});
