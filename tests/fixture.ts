import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A synthetic Kotlin repository, built in a temp directory.
 *
 * Tests that only need *a* codebase build one of these rather than pointing at a
 * real project: it keeps them runnable anywhere, including CI, and lets them make
 * changes a real codebase would never contain on demand.
 */
export const SRC = "src/main/kotlin";

/** The package prefix everything below sits under. */
export const BASE_PACKAGE = "com.example";

export interface Fixture {
  dir: string;
  /** Write a source file, path relative to the source root. */
  write(rel: string, body: string): void;
  /** Arguments that point the CLI at this fixture. */
  args(): string[];
  git(...args: string[]): void;
}

/**
 * Two bounded contexts, each with the three layers. Two rather than one because
 * a single domain makes the common-prefix inference swallow the domain segment
 * as well; `args()` passes --base-package regardless, but the shape should be
 * representative.
 */
export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-fixture-"));
  writeFileSync(join(dir, "build.gradle.kts"), "// marker\n");

  const write = (rel: string, body: string): void => {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };

  write(
    "com/example/pay/domain/model/Payment.kt",
    `package ${BASE_PACKAGE}.pay.domain.model\n\nclass Payment(val id: String)\n`,
  );
  write(
    "com/example/pay/application/port/out/PaymentRepository.kt",
    `package ${BASE_PACKAGE}.pay.application.port.out\n\n` +
      `import ${BASE_PACKAGE}.pay.domain.model.Payment\n\n` +
      "interface PaymentRepository {\n" +
      "    fun findById(id: String): Payment?\n" +
      "    fun save(payment: Payment): Payment\n" +
      "}\n",
  );
  write(
    "com/example/pay/application/service/PayService.kt",
    `package ${BASE_PACKAGE}.pay.application.service\n\n` +
      `import ${BASE_PACKAGE}.pay.application.port.out.PaymentRepository\n\n` +
      "class PayService(private val payments: PaymentRepository) {\n" +
      "    fun charge(id: String) = payments.findById(id)\n" +
      "}\n",
  );
  write(
    "com/example/ledger/domain/model/Entry.kt",
    `package ${BASE_PACKAGE}.ledger.domain.model\n\nclass Entry(val id: String)\n`,
  );
  write(
    "com/example/ledger/application/service/LedgerService.kt",
    `package ${BASE_PACKAGE}.ledger.application.service\n\n` +
      `import ${BASE_PACKAGE}.ledger.domain.model.Entry\n\n` +
      "class LedgerService {\n" +
      "    fun record(e: Entry): Entry = e\n" +
      "}\n",
  );

  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  };

  return {
    dir,
    write,
    git,
    args: () => [
      "--repo",
      dir,
      "--src",
      SRC,
      "--project",
      "fixture",
      "--base-package",
      BASE_PACKAGE,
    ],
  };
}
