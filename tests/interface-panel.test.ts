import { describe, expect, it } from "vitest";
import { type PanelIO, interfacePanel } from "../src/view/interface-panel.ts";

/**
 * When the Interface tab asks the server, and what it believes when it answers.
 *
 * All three rules here exist because a version without them left the panel stuck
 * on "drawing…" with no way back. That state is the failure mode worth guarding:
 * it looks like work in progress, so nobody reloads.
 */

interface Harness extends ReturnType<typeof interfacePanel> {
  /** Everything the panel has put on screen, oldest first. */
  frames: string[];
  last: () => string;
  urls: string[];
  pick: (provider: string, consumer: string) => void;
  /** Resolve or reject the next request; default is a normal answer. */
  answer: (fn: (url: string) => Promise<{ ok: boolean; text: string }>) => void;
}

function harness(): Harness {
  const frames: string[] = [];
  const urls: string[] = [];
  let provider = "pay";
  let consumer = "order";
  let responder = async (url: string) => ({ ok: true, text: `<svg data-url="${url}"/>` });

  const io: PanelIO = {
    provider: () => provider,
    consumer: () => consumer,
    show: (html) => frames.push(html),
    get: (url) => {
      urls.push(url);
      return responder(url);
    },
  };
  const panel = interfacePanel(io);
  return {
    ...panel,
    frames,
    urls,
    last: () => frames[frames.length - 1] ?? "",
    pick: (p, c) => {
      provider = p;
      consumer = c;
    },
    answer: (fn) => {
      responder = fn;
    },
  };
}

describe("it asks, and shows the answer", () => {
  it("draws what the server returns", async () => {
    const h = harness();
    await h.load();
    expect(h.urls).toEqual(["/api/interface?provider=pay&consumer=order"]);
    expect(h.last()).toContain("<svg");
  });

  it("escapes the pair into the query rather than trusting it", async () => {
    const h = harness();
    h.pick("a b", "c&d");
    await h.load();
    expect(h.urls[0]).toBe("/api/interface?provider=a%20b&consumer=c%26d");
  });

  it("shows a refusal from the server as a message", async () => {
    const h = harness();
    h.answer(async () => ({ ok: false, text: "pick two different domains that exist" }));
    await h.load();
    expect(h.last()).toContain("pick two different domains that exist");
    expect(h.last()).not.toContain("drawing…");
  });
});

describe("it does not redraw what is already right", () => {
  it("skips the request when the pair has not changed", async () => {
    const h = harness();
    await h.load();
    await h.load();
    await h.load();
    // Returning to the tab must not risk replacing a good picture with a failure.
    expect(h.urls).toHaveLength(1);
  });

  it("asks again once the pair changes", async () => {
    const h = harness();
    await h.load();
    h.pick("order", "pay");
    await h.load();
    expect(h.urls).toHaveLength(2);
  });

  it("asks again after a failure, rather than caching it", async () => {
    const h = harness();
    h.answer(async () => {
      throw new Error("offline");
    });
    await h.load();
    h.answer(async () => ({ ok: true, text: "<svg/>" }));
    await h.load();
    expect(h.urls).toHaveLength(2);
    expect(h.last()).toBe("<svg/>");
  });
});

describe("it never leaves the panel saying drawing…", () => {
  it("says the server is unreachable when the request throws", async () => {
    const h = harness();
    h.answer(async () => {
      throw new Error("offline");
    });
    await h.load();
    // This is the bug: without a catch the function dies here and the placeholder
    // stays on screen for ever.
    expect(h.frames).toContain('<div style="color:#6e7681;padding:20px 4px">drawing…</div>');
    expect(h.last()).toContain("could not reach hexwright");
    expect(h.last()).not.toContain("drawing…");
  });

  it("refuses a domain against itself without asking the server", async () => {
    const h = harness();
    h.pick("pay", "pay");
    await h.load();
    expect(h.urls).toEqual([]);
    expect(h.last()).toContain("no boundary with itself");
  });

  it("does nothing at all before the pickers are filled", async () => {
    const h = harness();
    h.pick("", "");
    await h.load();
    expect(h.urls).toEqual([]);
    expect(h.frames).toEqual([]);
  });
});

describe("a slow answer cannot overwrite a newer one", () => {
  it("drops the stale response", async () => {
    const h = harness();
    /** Each entry answers one in-flight request when called. */
    const release: (() => void)[] = [];
    h.answer((url) => new Promise((ok) => release.push(() => ok({ ok: true, text: url }))));

    const first = h.load();
    h.pick("order", "pay");
    const second = h.load();

    // Answer the second, then the first — the order a slow network produces.
    release[1]?.();
    await second;
    release[0]?.();
    await first;

    expect(h.last()).toContain("provider=order&consumer=pay");
  });
});
