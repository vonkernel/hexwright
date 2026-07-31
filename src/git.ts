import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Taking the base snapshot must not touch the target repository.
 * `git worktree add` leaves metadata in .git/worktrees, so use archive instead.
 */
export function exportRef(
  repo: string,
  ref: string,
  subPath = "",
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-"));
  const args = ["-C", repo, "archive", "--format=tar", ref];
  if (subPath) args.push("--", subPath);
  let tar: Buffer;
  try {
    tar = execFileSync("git", args, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    // CI checkouts are usually shallow, so the ref to compare against is not
    // present. Say what to do about it rather than passing git's error through.
    //
    // Given a remote-tracking name like origin/main, the name on the remote is
    // just `main` — echoing it back would suggest a command that cannot work.
    const remote = /^([^/]+)\/(.+)$/.exec(ref);
    const [name, dest] = remote
      ? [remote[2] as string, `refs/remotes/${remote[1]}/${remote[2]}`]
      : [ref, `refs/heads/${ref}`];
    throw new Error(
      `cannot read '${ref}' from ${repo} — the ref is not in this clone.\n` +
        "  CI checkouts are shallow by default. Either fetch it:\n" +
        `    git fetch --no-tags --depth=1 origin ${name}:${dest}\n` +
        "  or check out with full history (actions/checkout: fetch-depth: 0).",
    );
  }
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The target may not be a git directory at all (a temporary checkout, say).
 * Callers handle that as an exception and move on, so git's diagnostics are
 * swallowed rather than left to clutter the user's screen.
 */
const gitOut = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export function resolveRef(repo: string, ref: string): string {
  return gitOut(repo, ["rev-parse", "--short", ref]);
}

export function currentBranch(repo: string): string {
  return gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}
