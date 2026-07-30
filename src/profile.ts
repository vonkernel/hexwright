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

export interface Profile {
  name: string;
  language: string;
  domain: { from: string; base: string; at: number };
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
