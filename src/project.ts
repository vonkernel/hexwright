import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Discovering the target project's layout.
 *
 * Assumes a single-module Gradle project — Kotlin, Spring Boot.
 * The repository root is not necessarily the Gradle root — it may be one module
 * inside a monorepo. So find build.gradle(.kts), treat that as the module root,
 * and take <module>/src/main/kotlin as the source root by Gradle convention.
 */
export interface Detected {
  /** absolute path of the source root */
  srcAbs: string;
  /** path relative to the repo — handed to git archive */
  srcRel: string;
  /** module root relative to the repo; "." when it is the root itself */
  module: string;
  /** number of includes in settings.gradle. 0 means a single module. */
  subprojects: number;
  how: "gradle" | "explicit" | "convention";
}

const GRADLE = ["build.gradle.kts", "build.gradle"];
const SETTINGS = ["settings.gradle.kts", "settings.gradle"];
const SKIP = new Set(["node_modules", "build", ".git", ".gradle", "dist", "out"]);

function findGradleModules(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (GRADLE.some((f) => existsSync(join(dir, f)))) found.push(dir);
    if (depth >= maxDepth) return;
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** How many includes settings.gradle declares — above 0 means multi-module. */
function countSubprojects(dir: string): number {
  for (const f of SETTINGS) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").replace(/\/\/[^\n]*/g, "");
    return (text.match(/\binclude\s*[("']/g) ?? []).length;
  }
  return 0;
}

export function detectSource(repo: string, override?: string): Detected {
  if (override) {
    // Accept either a module path (server) or a source root (server/src/main/kotlin)
    const asModule = join(repo, override, "src", "main", "kotlin");
    if (existsSync(asModule)) {
      return {
        srcAbs: asModule,
        srcRel: join(override, "src/main/kotlin"),
        module: override,
        subprojects: countSubprojects(join(repo, override)) || countSubprojects(repo),
        how: "gradle",
      };
    }
    const abs = join(repo, override);
    if (!existsSync(abs)) throw new Error(`source root not found: ${abs}`);
    return { srcAbs: abs, srcRel: override, module: ".", subprojects: 0, how: "explicit" };
  }

  const modules = findGradleModules(repo, 2).filter((m) =>
    existsSync(join(m, "src", "main", "kotlin")),
  );

  if (modules.length === 1) {
    const mod = modules[0] as string;
    const abs = join(mod, "src", "main", "kotlin");
    return {
      srcAbs: abs,
      srcRel: relative(repo, abs) || ".",
      module: relative(repo, mod) || ".",
      subprojects: countSubprojects(mod) || countSubprojects(repo),
      how: "gradle",
    };
  }

  if (modules.length > 1) {
    const names = modules.map((m) => relative(repo, m) || ".").join(", ");
    throw new Error(
      `found ${modules.length} Gradle modules with Kotlin sources (${names}).\n` +
        "hexwright assumes a single module — pass --src to pick one.",
    );
  }

  // No Gradle file is fine as long as the conventional path exists
  const fallback = join(repo, "src", "main", "kotlin");
  if (existsSync(fallback)) {
    return {
      srcAbs: fallback,
      srcRel: "src/main/kotlin",
      module: ".",
      subprojects: 0,
      how: "convention",
    };
  }

  throw new Error(
    "no Kotlin source root found. Looked for build.gradle(.kts) with src/main/kotlin " +
      "up to two levels deep, then ./src/main/kotlin. Pass --src to specify it.",
  );
}
