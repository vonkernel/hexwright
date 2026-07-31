import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AdapterKind, Edge, Graph, Node, Relation } from "../model.ts";
import {
  type Profile,
  adapterKindOf,
  componentOf,
  isExcluded,
  layerOf,
  sublayerOf,
} from "../profile.ts";
import * as K from "./kotlin-syntax.ts";

interface Decl {
  name: string;
  line: number;
  kind: string;
}

interface FileInfo {
  rel: string;
  pkg: string;
  /** simple name (or `as` alias) to FQCN */
  imports: Map<string, string>;
  decls: Decl[];
  lines: string[];
  layer: string;
  /** typealias name to its right-hand side, as written */
  aliases: Map<string, string>;
  /**
   * Lines holding a top-level construct that is not a declaration. They carry no
   * node, but they bound the body of the declaration above.
   */
  stops: number[];
}

/**
 * Where a declaration's body ends: at the next declaration, or at the first
 * top-level construct after it — whichever comes first.
 *
 * Without the second bound a `typealias` or a file-level function is read as part
 * of the class above it, and every type it names is counted as a reference from
 * that class. That reported a boundary breach against types that did not have one.
 */
function bodyEnd(fi: FileInfo, di: number): number {
  const d = fi.decls[di] as Decl;
  let end = di + 1 < fi.decls.length ? (fi.decls[di + 1] as Decl).line : fi.lines.length;
  for (const s of fi.stops) if (s > d.line && s < end) end = s;
  return end;
}

/** One parsed type plus its signatures — used to find edges, not carried in the graph. */
interface TypeInfo extends Node {
  struct: string;
  sigs: Map<string, K.Signature>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".kt")) out.push(p);
  }
  return out;
}

/** Without an explicit base package, infer the longest common prefix. */
function inferBasePackage(pkgs: string[]): string {
  if (!pkgs.length) return "";
  const split = pkgs.map((p) => p.split("."));
  const first = split[0] as string[];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i] as string;
    if (split.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  // The segment right after the common prefix is the domain
  return common.join(".");
}

export function extractKotlin(
  srcRoot: string,
  profile: Profile,
  project: string,
  ref: string,
): Graph {
  const files = walk(srcRoot).sort();
  const infos: FileInfo[] = [];
  const rawPkgs: string[] = [];

  // -- 1) collect declarations and imports, file by file -----------
  for (const abs of files) {
    const rel = relative(srcRoot, abs);
    if (isExcluded(profile, `/${rel}`)) continue;
    const lines = K.stripComments(readFileSync(abs, "utf8")).split("\n");
    let pkg = "";
    const imports = new Map<string, string>();
    const decls: Decl[] = [];
    const aliases = new Map<string, string>();
    const stops: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const pm = K.PACKAGE.exec(line);
      if (pm) {
        pkg = pm[1] as string;
        continue;
      }
      const im = K.IMPORT.exec(line);
      if (im) {
        const fq = im[1] as string;
        imports.set(im[2] ?? (fq.split(".").pop() as string), fq);
        continue;
      }
      // DECL first: `fun interface` opens with `fun` but declares a type.
      const dm = K.DECL.exec(line);
      if (dm?.groups) {
        decls.push({
          name: dm.groups.name as string,
          line: i,
          kind: K.kindOf(dm.groups.mods ?? "", dm.groups.kw as string),
        });
        continue;
      }
      const am = K.TYPEALIAS.exec(line);
      if (am) {
        aliases.set(am[1] as string, am[2] as string);
        stops.push(i);
        continue;
      }
      if (K.TOP_LEVEL.test(line)) stops.push(i);
    }
    rawPkgs.push(pkg);
    infos.push({
      rel,
      pkg,
      imports,
      decls,
      lines,
      layer: layerOf(profile, `/${rel}`),
      aliases,
      stops,
    });
  }

  // -- 1b) resolve type aliases ---------------------------------------
  // An alias is not a type of its own — it stands for its right-hand side. Expanding
  // it before references are counted keeps the reference on the declaration that
  // names the alias; dropping the alias instead would lose that edge entirely.
  interface Alias {
    rhs: string;
    /** where it was declared — the right-hand side resolves in that file's scope */
    from: FileInfo;
  }
  const aliasByFq = new Map<string, Alias>();
  for (const fi of infos) {
    for (const [name, rhs] of fi.aliases) aliasByFq.set(`${fi.pkg}.${name}`, { rhs, from: fi });
  }

  for (const fi of infos) {
    const reach = new Map<string, Alias>();
    for (const [name, rhs] of fi.aliases) reach.set(name, { rhs, from: fi });
    for (const [simple, fq] of fi.imports) {
      const a = aliasByFq.get(fq);
      if (a) reach.set(simple, a);
    }
    for (const [fq, a] of aliasByFq) {
      const dot = fq.lastIndexOf(".");
      const name = fq.slice(dot + 1);
      if (fq.slice(0, dot) === fi.pkg && !reach.has(name)) reach.set(name, a);
    }
    if (!reach.size) continue;

    // Expanding an alias imported from elsewhere introduces names this file never
    // imported — importing the alias instead of the underlying type is the whole
    // point of one. Carry the declaring file's bindings across so they still resolve.
    for (const { rhs, from } of reach.values()) {
      if (from === fi) continue;
      for (const [name] of rhs.matchAll(K.TYPENAME)) {
        const nm = name as string;
        if (!fi.imports.has(nm)) fi.imports.set(nm, from.imports.get(nm) ?? `${from.pkg}.${nm}`);
      }
    }

    // Twice, so an alias of an alias resolves. The declaration lines themselves are
    // left alone — they are stops, and rewriting them only mangles the text.
    for (let pass = 0; pass < 2; pass++) {
      for (const [name, a] of reach) {
        const re = new RegExp(`\\b${name}\\b`, "g");
        fi.lines = fi.lines.map((l) => (K.TYPEALIAS.test(l) ? l : l.replace(re, a.rhs)));
      }
    }
  }

  const base = profile.domain.base || inferBasePackage(rawPkgs);
  const domainOf = (pkg: string): string => {
    const rest = pkg.startsWith(`${base}.`) ? pkg.slice(base.length + 1) : pkg;
    return rest.split(".")[profile.domain.at] ?? "root";
  };

  // -- 2) type nodes ------------------------------------------------
  const types = new Map<string, TypeInfo>();
  const byPkg = new Map<string, string[]>();

  for (const fi of infos) {
    if (fi.layer === "other") continue; // outside the profile's layers — root bootstrap and such
    const path = `/${fi.rel}`;
    const layer = fi.layer;
    const sublayer = sublayerOf(profile, path);
    const adapterKind: AdapterKind = layer === "adapter" ? adapterKindOf(profile, path) : "";
    const domain = domainOf(fi.pkg);

    for (let di = 0; di < fi.decls.length; di++) {
      const d = fi.decls[di] as Decl;
      const end = bodyEnd(fi, di);
      const body = fi.lines.slice(d.line, end);
      const struct = K.structOf(d.kind);
      const sigs = K.collectSigs(body);

      const api: string[] = [];
      for (const [nm, s] of sigs) if (s.isPublic) api.push(K.cleanSig(nm, s.params, s.ret));

      const headerFull = body.slice(0, 40).join("\n");
      const braceAt = headerFull.indexOf("{");
      const header = braceAt >= 0 ? headerFull.slice(0, braceAt) : headerFull;
      const props = K.ctorParams(header);
      // Scan body properties from after the header. With a multi-line primary
      // constructor those lines are in the body too, and val parameters would
      // otherwise be counted twice.
      if (braceAt >= 0) {
        const rest = body.slice(header.split("\n").length - 1);
        const first = rest[0];
        if (first !== undefined) rest[0] = first.slice(first.indexOf("{") + 1);
        for (const ln of rest) {
          const pm = K.PROP.exec(ln);
          if (pm) props.push(`${pm[1]}: ${(pm[2] as string).trim().replace(/,$/, "")}`);
        }
      }
      if (d.kind.includes("enum")) props.push(...K.enumEntries(body.join("\n")));

      const id = `${fi.pkg}.${d.name}`;
      types.set(id, {
        id,
        name: d.name,
        domain,
        component: componentOf(profile, { layer, sublayer, kind: d.kind, struct, name: d.name }),
        layer,
        sublayer,
        kind: d.kind,
        adapterKind,
        api,
        props,
        file: fi.rel,
        line: d.line + 1,
        struct,
        sigs,
      });
      byPkg.set(fi.pkg, [...(byPkg.get(fi.pkg) ?? []), id]);
    }
  }

  // -- 3) symbols visible from each file -----------------------------
  const visibleOf = (fi: FileInfo): Map<string, string> => {
    const v = new Map<string, string>();
    for (const [simple, fq] of fi.imports) if (types.has(fq)) v.set(simple, fq);
    for (const id of byPkg.get(fi.pkg) ?? []) {
      const t = types.get(id) as TypeInfo;
      if (!v.has(t.name)) v.set(t.name, id);
    }
    return v;
  };

  // -- 4) edges -------------------------------------------------------
  const analyzed = new Set(Object.keys(profile.layers));
  const dep = new Map<string, number>();
  const supers: [string, string][] = [];
  const layerViol = new Set<string>();
  const key = (s: string, d: string) => `${s}\u0000${d}`;

  for (const fi of infos) {
    if (!analyzed.has(fi.layer)) continue;
    const visible = visibleOf(fi);

    for (let di = 0; di < fi.decls.length; di++) {
      const d = fi.decls[di] as Decl;
      const id = `${fi.pkg}.${d.name}`;
      const end = bodyEnd(fi, di);
      const body = fi.lines.slice(d.line, end).join("\n");

      for (const sup of K.parseSupertypes(fi.lines, d.line)) {
        const tgt = visible.get(sup);
        if (tgt) supers.push([id, tgt]);
      }

      for (const [simple, tgt] of visible) {
        if (tgt === id) continue;
        const t = types.get(tgt) as TypeInfo;
        const cnt = body.split(new RegExp(`\\b${simple}\\b`, "g")).length - 1;
        if (!cnt) continue;
        if (t.layer === "adapter" && (fi.layer === "application" || fi.layer === "domain")) {
          layerViol.add(key(id, tgt));
        }
        dep.set(key(id, tgt), (dep.get(key(id, tgt)) ?? 0) + cnt);
      }
    }
  }

  // -- 5) references reached through signatures ------------------------
  // When A depends on B, find which of B's methods it calls and count that
  // signature's parameter and return types as references from A. This is how a
  // type held only in a local variable — its name absent from the body — is found.
  const sigTypes = new Map<string, Map<string, [Set<string>, Set<string>]>>();
  const visCache = new Map<string, Map<string, string>>();
  for (const fi of infos) visCache.set(fi.rel, visibleOf(fi));

  for (const [id, t] of types) {
    const v = visCache.get(t.file) ?? new Map();
    const m = new Map<string, [Set<string>, Set<string>]>();
    for (const [nm, s] of t.sigs) {
      const pick = (txt: string) => {
        const out = new Set<string>();
        for (const mm of txt.matchAll(K.TYPENAME)) {
          const tgt = v.get(mm[1] as string);
          if (tgt) out.add(tgt);
        }
        return out;
      };
      m.set(nm, [pick(s.params), pick(s.ret)]);
    }
    sigTypes.set(id, m);
  }

  const viaSig = new Set<string>();
  const usedContracts = new Map<string, Set<string>>();

  for (const fi of infos) {
    if (!analyzed.has(fi.layer)) continue;
    const visible = visCache.get(fi.rel) as Map<string, string>;

    for (let di = 0; di < fi.decls.length; di++) {
      const d = fi.decls[di] as Decl;
      const id = `${fi.pkg}.${d.name}`;
      const end = bodyEnd(fi, di);
      const body = fi.lines.slice(d.line, end).join("\n");

      // variable to type: start from explicit declarations, propagate through call returns.
      const bind = new Map<string, string>();
      for (const m of body.matchAll(K.FIELD)) {
        const tgt = visible.get(m[2] as string);
        if (tgt) bind.set(m[1] as string, tgt);
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const m of body.matchAll(K.LOCAL_CTOR)) {
          const tgt = visible.get(m[2] as string);
          if (tgt && !bind.has(m[1] as string)) bind.set(m[1] as string, tgt);
        }
        for (const m of body.matchAll(K.LOCAL_CALL)) {
          const owner = bind.get(m[2] as string);
          if (!owner) continue;
          const rets = sigTypes.get(owner)?.get(m[3] as string)?.[1];
          if (rets?.size === 1 && !bind.has(m[1] as string)) {
            bind.set(m[1] as string, [...rets][0] as string);
          }
        }
      }

      for (const m of body.matchAll(K.CALL)) {
        const owner = bind.get(m[1] as string);
        if (!owner) continue;
        const sg = sigTypes.get(owner)?.get(m[2] as string);
        if (!sg) continue;
        const ck = key(id, owner);
        usedContracts.set(ck, (usedContracts.get(ck) ?? new Set()).add(m[2] as string));
        for (const tgt of new Set([...sg[0], ...sg[1]])) {
          if (tgt === id) continue;
          const k = key(id, tgt);
          if (!dep.has(k)) {
            dep.set(k, 1);
            viaSig.add(k);
          }
        }
      }
    }
  }

  // -- 6) assemble -----------------------------------------------------
  const supSet = new Set(supers.map(([c, p]) => key(c, p)));
  const edges: Edge[] = [];

  const push = (src: string, dst: string, rel: Relation, weight: number) => {
    const s = types.get(src) as TypeInfo;
    const d = types.get(dst) as TypeInfo;
    const k = key(src, dst);
    const sigs = d.sigs;
    const contracts = [...(usedContracts.get(k) ?? [])].sort().map((m) => {
      const sg = sigs.get(m);
      return sg ? K.cleanSig(m, sg.params, sg.ret) : m;
    });
    edges.push({
      src,
      dst,
      rel,
      weight,
      crossDomain: s.domain !== d.domain,
      identifierOnly: d.component === "VO" && d.sublayer === "model",
      viaSignature: viaSig.has(k),
      contracts: rel === "DEPENDS_ON" ? contracts : [],
      violation: violationOf(profile, s, d, layerViol.has(k)),
    });
  };

  for (const [c, p] of supSet.size
    ? [...supSet].map((k) => k.split("\u0000") as [string, string])
    : []) {
    const parent = types.get(p) as TypeInfo;
    push(c, p, parent.struct === "Interface" ? "IMPLEMENTS" : "EXTENDS", 1);
  }
  for (const [k, w] of dep) {
    if (supSet.has(k)) continue; // already expressed as IMPLEMENTS/EXTENDS
    const [s, d] = k.split("\u0000") as [string, string];
    push(s, d, "DEPENDS_ON", w);
  }

  const nodes: Node[] = [...types.values()].map(({ struct: _s, sigs: _g, ...n }) => n);
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort(
    (a, b) =>
      a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst) || a.rel.localeCompare(b.rel),
  );
  return { project, ref, nodes, edges };
}

/** Design-rule verdict. Reads nothing but the profile. */
function violationOf(p: Profile, s: Node, d: Node, layerBack: boolean): string {
  if (layerBack) {
    const rule = p.rules.layering.find((r) => r.from.includes(s.layer) && r.to.includes(d.layer));
    if (rule) return rule.message;
  }
  if (d.component !== "Entity") return "";
  const ea = p.rules.entityAccess;
  if (s.domain !== d.domain) {
    return ea.crossDomain === "deny" ? "cross-domain Entity access" : "";
  }
  if (s.layer === "adapter") {
    return ea.allowAdapterKinds.includes(s.adapterKind) ? "" : "inbound adapter touches Entity";
  }
  return ea.allow.includes(s.component) ? "" : `${s.component} exposes Entity`;
}
