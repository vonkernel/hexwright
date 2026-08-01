/**
 * Kotlin syntax parsing. Language knowledge stops here; everything above is
 * language-agnostic.
 *
 * Two things accuracy depends on:
 *  - Blank out comments and string literals first. Codebases like this name types
 *    in prose and in log lines often enough that leaving either in fabricates
 *    dependencies that do not exist.
 *  - Multi-line signatures are joined by tracking bracket depth.
 */

export const PACKAGE = /^package\s+([\w.]+)/;
export const IMPORT = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/;

const MODS =
  "(?:public |internal |private |protected |open |abstract |sealed |data |value |inner |annotation |enum |final |external |expect |actual |fun )*";
export const DECL = new RegExp(
  `^(?<mods>${MODS})(?<kw>class|interface|object)\\s+(?<name>[A-Za-z_]\\w*)`,
);

const TOP_MODS =
  "(?:public |internal |private |expect |actual |external |inline |suspend |operator |infix |tailrec |const |lateinit )*";
/** A file-level `typealias`, capturing the name and the right-hand side. */
export const TYPEALIAS = new RegExp(
  `^${TOP_MODS}typealias\\s+(\\w+)(?:<[^>]*>)?\\s*=\\s*(.+?)\\s*$`,
);
/**
 * A top-level construct the graph does not model — a `typealias`, or a file-level
 * function, property or constant. Nothing here becomes a node, but each one ends
 * the body of the declaration above it. Test DECL first: `fun interface` starts
 * with `fun` and is a declaration, not a file-level function.
 */
export const TOP_LEVEL = new RegExp(
  `^(?:@\\w+(?:\\([^)]*\\))?\\s+)*${TOP_MODS}(?:typealias|fun|va[lr])\\s`,
);

const FUN_MODS =
  "(?:override |open |abstract |suspend |operator |private |internal |protected |inline |final )*";
export const SIG = new RegExp(
  `^\\s+(?:@\\w+(?:\\([^)]*\\))?\\s*)*(?<mods>${FUN_MODS})fun\\s+(?<name>\\w+)\\s*\\(`,
);
export const FUN_LINE = new RegExp(
  `^\\s+(?:@\\w+(?:\\([^)]*\\))?\\s+)*${FUN_MODS.replace("| final ", "|final ")}fun\\s`,
);
export const PRIVATE_MEMBER = /^\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:private|internal)\s/;

/** A body property: a public val/var at four-space indentation. */
export const PROP =
  /^ {4}(?!private|internal|protected)(?:override |open |const |lateinit )*va[lr]\s+(\w+)\s*:\s*([^=\n]+?)\s*(?:=|$)/;
export const FIELD = /va[lr]\s+(\w+)\s*:\s*([A-Za-z_]\w*)/g;
export const LOCAL_CALL = /va[lr]\s+(\w+)\s*=\s*([A-Za-z_]\w*)[.!?]*\.(\w+)\s*\(/g;
export const LOCAL_CTOR = /va[lr]\s+(\w+)\s*=\s*([A-Z]\w*)\s*\(/g;
export const CALL = /\b(\w+)[!?]*\.(\w+)\s*\(/g;
export const TYPENAME = /\b([A-Z]\w*)\b/g;

/** The language construct — `data class`, `value class` — which the classification rests on. */
export function kindOf(mods: string, kw: string): string {
  const m = mods.split(/\s+/);
  for (const k of ["value", "data", "enum", "sealed", "annotation", "abstract", "fun"]) {
    if (m.includes(k)) return `${k} ${kw}`;
  }
  return kw;
}

export function structOf(kind: string): "Class" | "Interface" | "Object" {
  if (kind.includes("interface")) return "Interface";
  if (kind === "object") return "Object";
  return "Class";
}

/** What the scanner is inside. The root frame is code and never pops. */
interface Frame {
  kind: "code" | "str";
  /** for a string: a raw `"""…"""` literal, where a backslash escapes nothing */
  raw: boolean;
  /** for code opened by a `${`: braces seen since, so the matching `}` is known */
  depth: number;
}

/**
 * Blank out everything that is not code, preserving line and column positions.
 *
 * Comments go because a codebase names types in prose often enough that leaving
 * them in fabricates dependencies that do not exist. String literals go for the
 * same reason: a log line, an exception message or a serialization key naming a
 * type is a mention, not a reference, and counting it reports a boundary breach
 * against a declaration whose code never touches the type.
 *
 * What survives is the code inside a `${…}` template — a call there is a real
 * call, and blanking it would lose a genuine edge. Frames nest, so a string
 * inside a template is blanked in turn.
 */
export function stripNonCode(text: string): string {
  const out: string[] = [];
  const n = text.length;
  const stack: Frame[] = [{ kind: "code", raw: false, depth: 0 }];
  const blank = (c: string) => out.push(c === "\n" ? "\n" : " ");
  let i = 0;

  while (i < n) {
    const f = stack[stack.length - 1] as Frame;
    const c = text[i] as string;

    if (f.kind === "code") {
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        out.push(" ", " ");
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) blank(text[i++] as string);
        if (i < n) {
          out.push(" ", " ");
          i += 2;
        }
        continue;
      }
      if (c === '"') {
        const raw = text[i + 1] === '"' && text[i + 2] === '"';
        const q = raw ? 3 : 1;
        for (let k = 0; k < q; k++) out.push('"');
        i += q;
        stack.push({ kind: "str", raw, depth: 0 });
        continue;
      }
      // A character literal cannot nest — consume it here.
      if (c === "'") {
        out.push("'");
        i++;
        while (i < n && text[i] !== "'" && text[i] !== "\n") {
          if (text[i] === "\\" && i + 1 < n) {
            out.push(" ");
            i++;
          }
          blank(text[i++] as string);
        }
        if (i < n && text[i] === "'") {
          out.push("'");
          i++;
        }
        continue;
      }
      if (c === "{") f.depth++;
      else if (c === "}") {
        // The brace that closes the `${` this frame was opened by.
        if (f.depth === 0 && stack.length > 1) {
          out.push("}");
          stack.pop();
          i++;
          continue;
        }
        f.depth--;
      }
      out.push(c);
      i++;
      continue;
    }

    // Inside a string literal.
    if (!f.raw && c === "\\" && i + 1 < n) {
      out.push(" ", " ");
      i += 2;
      continue;
    }
    if (!f.raw && c === "\n") {
      // Do not let an unterminated string leak into the next line.
      out.push("\n");
      stack.pop();
      i++;
      continue;
    }
    if (c === '"' && (!f.raw || (text[i + 1] === '"' && text[i + 2] === '"'))) {
      const q = f.raw ? 3 : 1;
      for (let k = 0; k < q; k++) out.push('"');
      i += q;
      stack.pop();
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      out.push("$", "{");
      i += 2;
      stack.push({ kind: "code", raw: false, depth: 0 });
      continue;
    }
    blank(c);
    i++;
  }
  return out.join("");
}

export interface Signature {
  /** the parameter list verbatim, brackets included */
  params: string;
  /** the return type verbatim */
  ret: string;
  isPublic: boolean;
}

/** `fun x(a: A, b: B): R {` becomes `x(a: A, b: B): R` — body brace and extra space removed. */
export function cleanSig(name: string, params: string, ret: string): string {
  const r = (ret.split("{")[0] ?? "").split("=")[0]?.trimEnd() ?? "";
  return `${name}${params}${r}`
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .replace(/ ,/g, ",")
    .trim();
}

/** Method signatures in a type body, joining multi-line ones by bracket depth. */
export function collectSigs(body: string[]): Map<string, Signature> {
  const out = new Map<string, Signature>();
  for (let i = 0; i < body.length; i++) {
    const m = SIG.exec(body[i] as string);
    if (!m?.groups) continue;
    const name = m.groups.name as string;
    const isPublic = !/private|internal|protected/.test(m.groups.mods ?? "");
    const buf: string[] = [];
    let depth = 0;
    let started = false;
    for (let j = i; j < Math.min(i + 30, body.length); j++) {
      let line = body[j] as string;
      if (j === i) line = line.slice(line.indexOf("(", line.indexOf("fun")));
      for (const ch of line) {
        if (ch === "(") {
          depth++;
          started = true;
        } else if (ch === ")") depth--;
        buf.push(ch);
        if (started && depth === 0) break;
      }
      if (started && depth === 0) {
        const parts = (body[j] as string).split(")");
        out.set(name, { params: buf.join(""), ret: parts[parts.length - 1] as string, isPublic });
        break;
      }
      buf.push(" ");
    }
  }
  return out;
}

/** The parameter list of a declaration header, split on top-level commas. */
function ctorParts(header: string): string[] {
  const i = header.indexOf("(");
  if (i < 0) return [];
  let depth = 0;
  const buf: string[] = [];
  for (const ch of header.slice(i)) {
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") {
      depth--;
      if (depth === 0) break;
    }
    buf.push(ch);
  }
  const inner = buf.join("").slice(1);
  const parts: string[] = [];
  let cur: string[] = [];
  depth = 0;
  for (const ch of inner) {
    if ("(<[".includes(ch)) depth++;
    else if (")>]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.join(""));
      cur = [];
    } else cur.push(ch);
  }
  parts.push(cur.join(""));
  return parts;
}

/**
 * Constructor parameters that declare a property — the ones written `val` or `var`.
 *
 * A bare parameter is a pass-through to a supertype's constructor and declares
 * nothing. Treating the two alike makes every subtype look like it owns its
 * parent's identifier: `Photo(id: MediaId, …) : MediaItem(id, …)` would claim
 * `MediaId` just as loudly as the `MediaItem(val id: MediaId, …)` that has it.
 */
export function ctorDeclared(header: string): { name: string; type: string }[] {
  const out: { name: string; type: string }[] = [];
  for (let p of ctorParts(header)) {
    p = (p.split("=")[0] ?? "").replace(/\s+/g, " ").trim();
    p = p.replace(/^(?:@\w+(?:\([^)]*\))?\s*)*/, "");
    const m = /^(?:private |internal |protected |override )*(?:val|var)\s+(\w+)\s*:\s*(.+)$/.exec(
      p,
    );
    if (m) out.push({ name: m[1] as string, type: (m[2] as string).trim() });
  }
  return out;
}

/** Constructor parameters in the declaration header — where a data class or
 * exception keeps its contract. */
export function ctorParams(header: string): string[] {
  const parts = ctorParts(header);
  const res: string[] = [];
  for (let p of parts) {
    p = (p.split("=")[0] ?? "").replace(/\s+/g, " ").trim();
    p = p
      .replace(/^(?:@\w+(?:\([^)]*\))?\s*)*/, "")
      .replace(/^(?:private |internal |protected |override |val |var )*/, "")
      .trim();
    if (p.includes(":")) res.push(p);
  }
  return res;
}

/** For an enum the constants are the contract, one-liners included. */
export function enumEntries(body: string): string[] {
  const i = body.indexOf("{");
  if (i < 0) return [];
  let depth = 0;
  const out: string[] = [];
  let cur: string[] = [];
  for (const ch of body.slice(i + 1)) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) break;
      depth--;
    }
    if ((ch === "," || ch === ";") && depth === 0) {
      out.push(cur.join(""));
      cur = [];
      if (ch === ";") break;
    } else cur.push(ch);
  }
  out.push(cur.join(""));
  const res: string[] = [];
  for (const e of out) {
    const m = /^\s*([A-Z][A-Za-z0-9_]*)/.exec(e);
    if (m) res.push(m[1] as string);
  }
  return res;
}

/** Supertype names from a declaration header. Telling IMPLEMENTS from EXTENDS
 * needs symbol lookup and happens a layer up. */
export function parseSupertypes(lines: string[], start: number): string[] {
  const buf: string[] = [];
  let depth = 0;
  let seenColon = false;
  for (let li = start; li < Math.min(start + 80, lines.length); li++) {
    let line = lines[li] as string;
    const cpos = line.indexOf("//");
    if (cpos >= 0) line = line.slice(0, cpos);
    for (const ch of line) {
      if ("(<[".includes(ch)) depth++;
      else if (")>]".includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === "{" && depth === 0) return supertypeNames(buf.join(""), seenColon);
      else if (ch === ":" && depth === 0) seenColon = true;
      buf.push(ch);
    }
    const stripped = buf.join("").trimEnd();
    if (depth === 0 && stripped) {
      const last = stripped[stripped.length - 1] as string;
      if (seenColon) {
        if (last !== "," && last !== ":") return supertypeNames(buf.join(""), seenColon);
      } else if (li > start || !stripped.includes("(") || stripped.endsWith(")")) {
        if (!stripped.endsWith(",")) return [];
      }
    }
    buf.push("\n");
  }
  return supertypeNames(buf.join(""), seenColon);
}

function supertypeNames(text: string, seenColon: boolean): string[] {
  if (!seenColon) return [];
  let depth = 0;
  let idx = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if ("(<[".includes(ch)) depth++;
    else if (")>]".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return [];
  const parts: string[] = [];
  let cur: string[] = [];
  depth = 0;
  for (const ch of text.slice(idx + 1)) {
    if ("(<[".includes(ch)) depth++;
    else if (")>]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.join(""));
      cur = [];
    } else cur.push(ch);
  }
  parts.push(cur.join(""));
  const names: string[] = [];
  for (const p of parts) {
    const head = (p.split(/\bby\b/)[0] ?? "").trim();
    const m = /^([A-Za-z_][\w.]*)/.exec(head);
    if (m) names.push((m[1] as string).split(".").pop() as string);
  }
  return names;
}
