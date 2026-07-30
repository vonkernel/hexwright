import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Integration suite against a real Kotlin codebase. It is skipped unless one is
 * injected, because the assertions below are calibrated to a specific project —
 * counts, type names, known violations. Nothing about a machine or a workspace
 * belongs in this file.
 *
 *   HEXWRIGHT_TEST_REPO=/path/to/service  HEXWRIGHT_TEST_SRC=server  npm test
 */
const REPO = process.env.HEXWRIGHT_TEST_REPO;
const MODULE = process.env.HEXWRIGHT_TEST_SRC ?? "server";
/** Ref to diff against. The delta assertions expect the project at a known point. */
const BASE = process.env.HEXWRIGHT_TEST_BASE ?? "main";

describe.skipIf(!REPO)("against an injected codebase", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: ["src/cli.ts", "mcp", "--repo", REPO as string, "--src", MODULE],
      }),
    );
  }, 60_000);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
    };
    return r.content[0]?.text ?? "";
  };

  it("exposes only what files cannot answer", async () => {
    // No lookup that a file read answers — the agent already has Read and Grep
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_violations",
      "dependencies",
      "get_delta",
    ]);
  });

  it("says when to use each tool, not just what it does", async () => {
    // MCP earns its keep by being self-describing. The description is the usage rule.
    const { tools } = await client.listTools();
    const d = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    expect(d("check_violations")).toMatch(/before opening a PR/i);
    expect(d("get_delta")).toMatch(/before opening a PR/i);
    expect(d("dependencies")).toMatch(/before adding a method/i);
  });

  it("check_violations finds the seven known breaches", async () => {
    const t = await call("check_violations");
    expect(t).toContain("7 violation(s)");
    expect(t).toContain("inbound adapter touches Entity");
    expect(t).toContain("layer back-reference");
    expect(t).toContain("DTO exposes Entity");
  });

  it("dependencies shows which contract methods are actually called", async () => {
    const t = await call("dependencies", { name: "RecordService", direction: "out" });
    expect(t).toContain("RecordRepository");
    expect(t).toContain("uses:");
    expect(t).toContain("countByPhoto");
  });

  it("dependencies in-direction exposes the ISP signal", async () => {
    const t = await call("dependencies", { name: "MediaPolicyPort", direction: "in" });
    expect(t).toContain("MediaObjectEventService");
    expect(t).toMatch(/declares \d+, never called \(\d+\)/);
  });

  it("dependencies reaches past the direct callers when asked", async () => {
    const one = await call("dependencies", { name: "MediaItem", direction: "in" });
    expect(one).not.toContain("hop 2");
    const two = await call("dependencies", { name: "MediaItem", direction: "in", hops: 2 });
    expect(two).toContain("hop 2");
  });

  it("resolves ambiguity instead of guessing", async () => {
    const t = await call("dependencies", { name: "NoSuchType" });
    expect(t).toContain("not found");
  });

  it("says so when delta is asked for without a base ref", async () => {
    const t = await call("check_violations", { scope: "delta" });
    expect(t).toContain("no base ref");
  });

  /** Delta needs a base ref, so this connects to its own server. */
  describe("branch delta", () => {
    let dc: Client;
    const dcall = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await dc.callTool({ name, arguments: args })) as { content: { text: string }[] };
      return r.content[0]?.text ?? "";
    };

    beforeAll(async () => {
      dc = new Client({ name: "test-delta", version: "0" });
      await dc.connect(
        new StdioClientTransport({
          command: "node",
          args: ["src/cli.ts", "mcp", "--repo", REPO as string, "--src", MODULE, "--base", BASE],
        }),
      );
    }, 60_000);

    it("says what changed, not just that something changed", async () => {
      const t = await dcall("get_delta");
      expect(t).toContain("+ MediaLabelResolver [Service]");
      expect(t).toContain("~ MediaService [Service]");
      // 'modified' alone still leaves a file to open — carry the detail
      expect(t).toContain("+ property  labelResolver: MediaLabelResolver");
      expect(t).toContain("+ depends   MediaLabelResolver");
      expect(t).toContain("no new violations");
    });

    it("reports each changed property once", async () => {
      // A regression that counted a multi-line primary constructor's val parameters
      // twice. Only MediaDetailView and MediaSummaryView gained labels, so exactly two.
      const t = await dcall("get_delta");
      expect(t.match(/\+ property {2}labels: List<LabelView>/g)).toHaveLength(2);
    });
  });

  describe("cli", () => {
    it("writes the whole graph to a pipe", async () => {
      // process.exit discards stdout queued on a pipe — the regression truncated at 64KB
      const { stdout } = await promisify(execFile)(
        "node",
        ["src/cli.ts", "extract", "--repo", REPO as string, "--src", MODULE, "--json"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const g = JSON.parse(stdout) as { nodes: { props: string[] }[] };
      expect(g.nodes.length).toBe(701);
      expect(g.nodes.filter((n) => new Set(n.props).size !== n.props.length)).toEqual([]);
    }, 120_000);
  });
});
