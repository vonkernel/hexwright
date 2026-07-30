import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `check --scope delta` — a repository that already has violations must still be
 * gateable.
 * Without that, this tool only works on greenfield projects.
 *
 * Verified against a synthetic repository — a real codebase cannot be made to
 * produce the changes under test.
 */
let repo: string;

const SRC = "src/main/kotlin";
const write = (rel: string, body: string) => {
  const p = join(repo, SRC, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });

/** Run check and return the exit code together with the output. */
const check = (...extra: string[]): { code: number; out: string } => {
  try {
    const out = execFileSync(
      "node",
      // With one domain the common-prefix inference swallows `pay` too — be explicit
      // prettier-ignore
      [
        "src/cli.ts",
        "check",
        "--repo",
        repo,
        "--src",
        SRC,
        "--project",
        "t",
        "--base-package",
        "com.x",
        ...extra,
      ],
      { encoding: "utf8" },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "hexwright-gate-"));
  writeFileSync(join(repo, "build.gradle.kts"), "// marker\n");

  write(
    "com/x/pay/domain/model/Payment.kt",
    "package com.x.pay.domain.model\n\nclass Payment(val id: String)\n",
  );
  // A pre-existing violation: an inbound adapter touching an Entity
  write(
    "com/x/pay/adapter/web/PayController.kt",
    "package com.x.pay.adapter.web\n\n" +
      "import com.x.pay.domain.model.Payment\n\n" +
      "class PayController {\n    fun show(p: Payment): Payment = p\n}\n",
  );
  // Not a violation: a service using a helper in the same layer
  write("com/x/pay/application/CodeGen.kt", "package com.x.pay.application\n\nclass CodeGen\n");
  write(
    "com/x/pay/application/service/PayService.kt",
    "package com.x.pay.application.service\n\n" +
      "import com.x.pay.application.CodeGen\n\n" +
      "class PayService(private val gen: CodeGen)\n",
  );

  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "empty");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
  git("branch", "-f", "base-ref");
}, 60_000);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("check --scope delta", () => {
  it("gates a repository that already has violations", () => {
    // Whole-repo scope is blocked by the existing violation — unusable as a gate here
    const all = check();
    expect(all.code).toBe(1);
    expect(all.out).toContain("inbound adapter touches Entity");

    // Delta scope passes, and says how many it ignored
    const delta = check("--base", "base-ref", "--scope", "delta");
    expect(delta.code).toBe(0);
    expect(delta.out).toContain("violations 0 new");
    expect(delta.out).toContain("1 pre-existing, not gated");
  }, 60_000);

  it("refuses --scope delta without a base", () => {
    const r = check("--scope", "delta");
    expect(r.code).toBe(1);
    expect(r.out).toContain("needs --base");
  }, 60_000);

  it("fails on a violation the branch introduces", () => {
    write(
      "com/x/pay/adapter/web/PayAdminController.kt",
      "package com.x.pay.adapter.web\n\n" +
        "import com.x.pay.domain.model.Payment\n\n" +
        "class PayAdminController {\n    fun edit(p: Payment): Payment = p\n}\n",
    );
    const r = check("--base", "base-ref", "--scope", "delta");
    expect(r.code).toBe(1);
    expect(r.out).toContain("violations 1 new");
    expect(r.out).toContain("PayAdminController");
    rmSync(join(repo, SRC, "com/x/pay/adapter/web/PayAdminController.kt"));
  }, 60_000);

  it("catches a violation that appears on an edge which already existed", () => {
    // Move the file into adapter but leave the package declaration alone. Kotlin
    // allows that, so the type id and therefore the edge key are unchanged —
    // filtering by edge status misses this entirely. Comparing violation sets catches it.
    const from = join(repo, SRC, "com/x/pay/application/CodeGen.kt");
    const to = join(repo, SRC, "com/x/pay/adapter/out/CodeGen.kt");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    try {
      const r = check("--base", "base-ref", "--scope", "delta");
      expect(r.code).toBe(1);
      expect(r.out).toContain("violations 1 new");
      expect(r.out).toContain("layer back-reference");
      expect(r.out).toContain("PayService");
    } finally {
      mkdirSync(dirname(from), { recursive: true });
      renameSync(to, from);
    }
  }, 60_000);

  it("explains how to fetch a ref that a shallow clone does not have", () => {
    const r = check("--base", "no-such-ref", "--scope", "delta");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not in this clone");
    expect(r.out).toContain("fetch-depth: 0");
  }, 60_000);
});
