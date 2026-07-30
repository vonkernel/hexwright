import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyStatus, diff } from "./delta.ts";
import { extractKotlin } from "./extract/kotlin.ts";
import { currentBranch, exportRef, resolveRef } from "./git.ts";
import type { Delta, Graph } from "./model.ts";
import type { Profile } from "./profile.ts";
import { GraphQuery } from "./query.ts";

/**
 * Owns the graph, and re-reads the source on every question.
 *
 * This used to hand out a snapshot taken once at start-up. An agent that edited
 * code and then called check_violations got the answer for the code before the
 * edit — reporting "no violations" after introducing one, which is the worst
 * kind of wrong answer.
 *
 * Correctness comes from re-extracting (~100ms). The mtime fingerprint is only
 * an optimisation that decides whether the work can be skipped (~7ms). The test
 * is "different, so redo it", so a bug in the fingerprint costs time rather than
 * letting a stale answer out.
 */
export interface SourceConfig {
  repo: string;
  /** absolute path of the source root */
  srcAbs: string;
  /** path relative to the repo — used when unpacking the base snapshot */
  srcRel: string;
  profile: Profile;
  /** the profile file. Change the rules and the graph changes with them. */
  profilePath: string;
  project: string;
  /** ref to compare against. Without it there is no delta. */
  base?: string;
}

/** A fingerprint of the source tree: file count and newest mtime. Reads no content. */
function stamp(srcAbs: string, profilePath: string): string {
  let newest = 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".kt")) {
        count++;
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  try {
    walk(srcAbs);
  } catch {
    return "unreadable";
  }
  // Count matters too: deleting a file leaves every other file's mtime alone.
  let profileM = 0;
  try {
    profileM = statSync(profilePath).mtimeMs;
  } catch {
    /* if the profile is gone, the next extraction will say so */
  }
  return `${count}:${newest}:${profileM}`;
}

export class GraphSource {
  private cfg: SourceConfig;
  /** The base is a git ref and therefore immutable — extracted once per process. */
  private baseGraph?: Graph;
  private last?: { stamp: string; graph: Graph; query: GraphQuery; delta?: Delta };

  constructor(cfg: SourceConfig) {
    this.cfg = cfg;
  }

  /** The current graph. Returns the cache when the source has not moved. */
  graph(): Graph {
    const s = stamp(this.cfg.srcAbs, this.cfg.profilePath);
    // Test for 'different', not 'newer'. An NTP correction can move the clock
    // backwards, and a greater-than test would then miss that change forever.
    if (this.last && this.last.stamp === s) return this.last.graph;

    const { profile, project, srcAbs } = this.cfg;
    const ref =
      safe(() => `${currentBranch(this.cfg.repo)}@${resolveRef(this.cfg.repo, "HEAD")}`) ??
      "working-tree";
    const head = extractKotlin(srcAbs, profile, project, ref);

    let graph = head;
    let delta: Delta | undefined;
    if (this.cfg.base) {
      delta = diff(this.base(), head);
      graph = applyStatus(head, delta);
    }
    this.last = { stamp: s, graph, query: new GraphQuery(graph), ...(delta ? { delta } : {}) };
    return graph;
  }

  /** A query object over the current graph. */
  query(): GraphQuery {
    this.graph();
    return (this.last as { query: GraphQuery }).query;
  }

  /** The delta against the base, or undefined when no base was given. */
  delta(): Delta | undefined {
    this.graph();
    return this.last?.delta;
  }

  private base(): Graph {
    if (this.baseGraph) return this.baseGraph;
    const { repo, srcRel, profile, project, base } = this.cfg;
    const { dir, cleanup } = exportRef(repo, base as string, srcRel);
    try {
      this.baseGraph = extractKotlin(join(dir, srcRel), profile, project, base as string);
    } finally {
      cleanup();
    }
    return this.baseGraph;
  }
}

const safe = <T>(f: () => T): T | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};
