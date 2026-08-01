import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { AdapterKind, Component } from "./model.ts";

/** One component rule. Applies when every stated condition matches. */
export interface ComponentRule {
  layer?: string;
  sublayer?: string;
  /** language construct — `data class`, `interface`, … */
  kinds?: string[];
  /** structural kind — class, interface, object */
  structs?: string[];
  nameEnds?: string;
  as: Component;
}

/**
 * How an identifier type is tied to the aggregate it identifies.
 *
 * A type holding another aggregate's id references that aggregate — that is the
 * point of the pattern, and it is a weaker coupling than holding the aggregate
 * itself. The graph should say so, which means knowing which id belongs to what.
 *
 * Nothing in the source states that tie, so it is read from whichever convention
 * the project follows and declared here rather than guessed. Absent, no identifier
 * is resolved and the graph is unchanged.
 */
export interface IdentityRule {
  /**
   * `property` — the type declaring a property of the configured name owns the id.
   * Structural, and the only one that survives an aggregate whose name is not the
   * identifier's stem: `MediaId` identifies `MediaItem`, not `Media`.
   *
   * `suffix` — strip the suffix from the identifier's name and look for that type.
   * Simpler, and works when an aggregate does not carry its own id, but silently
   * resolves nothing the moment the two names diverge.
   */
  from: "property" | "suffix";
  /** for `property` — the property name that marks a type's own identity. */
  property?: string;
  /** for `suffix` — the identifier suffix to strip. */
  suffix?: string;
}

export interface Profile {
  name: string;
  language: string;
  domain: { from: string; base: string; at: number };
  /** Omitted: identifiers stay unresolved and no REFERENCES edge is produced. */
  identity?: IdentityRule;
  exclude: string[];
  layers: Record<string, string>;
  sublayers: Record<string, string>;
  adapterKinds: Record<string, string>;
  components: ComponentRule[];
  rules: {
    entityAccess: {
      allow: Component[];
      allowAdapterKinds: AdapterKind[];
      crossDomain: "deny" | "allow";
    };
    layering: { from: string[]; to: string[]; message: string }[];
  };
}

export function loadProfile(path: string, overrides: Partial<Profile["domain"]> = {}): Profile {
  const p = parse(readFileSync(path, "utf8")) as Profile;
  p.domain = { ...p.domain, ...overrides };
  return p;
}

/** Which layer a path belongs to. First match in profile order. */
export function layerOf(p: Profile, path: string): string {
  for (const [layer, frag] of Object.entries(p.layers)) {
    if (path.includes(frag)) return layer;
  }
  return "other";
}

export function sublayerOf(p: Profile, path: string): string {
  for (const [sub, frag] of Object.entries(p.sublayers)) {
    if (path.includes(frag)) return sub;
  }
  return "";
}

export function adapterKindOf(p: Profile, path: string): AdapterKind {
  for (const [kind, frag] of Object.entries(p.adapterKinds)) {
    if (path.includes(frag)) return kind as AdapterKind;
  }
  return path.includes("/adapter/") ? "in" : "";
}

export function isExcluded(p: Profile, path: string): boolean {
  return p.exclude.some((frag) => path.includes(frag));
}

/** Component classification from path and language construct only — no human
 * judgement, so the result is reproducible across commits. */
export function componentOf(
  p: Profile,
  ctx: { layer: string; sublayer: string; kind: string; struct: string; name: string },
): Component {
  for (const r of p.components) {
    if (r.layer && r.layer !== ctx.layer) continue;
    if (r.sublayer && r.sublayer !== ctx.sublayer) continue;
    if (r.kinds && !r.kinds.includes(ctx.kind)) continue;
    if (r.structs && !r.structs.some((x) => x.toLowerCase() === ctx.struct.toLowerCase())) continue;
    if (r.nameEnds && !ctx.name.endsWith(r.nameEnds)) continue;
    return r.as;
  }
  return "DTO";
}
