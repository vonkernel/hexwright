import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractKotlin } from "../src/extract/kotlin.ts";
import type { Graph } from "../src/model.ts";
import { type IdentityRule, loadProfile } from "../src/profile.ts";
import { BASE_PACKAGE, SRC } from "./fixture.ts";

/**
 * Identifier references — a type holding another aggregate's id.
 *
 * That is a reference to the aggregate, and a deliberately weaker one than holding
 * the aggregate itself. Drawing it as a dependency on the id stops the picture at
 * the identifier and leaves the aggregate unconnected, which is what these pin.
 *
 * The shapes come from a real domain model: `MediaItem` is a sealed root with
 * `Photo` and `Video` variants, `Blob` owns the content bytes, and media points at
 * blob by id.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function graphOf(files: Record<string, string>, identity?: IdentityRule | null): Graph {
  const dir = mkdtempSync(join(tmpdir(), "hexwright-identity-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, SRC, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const profile = loadProfile("profiles/hexagonal-kotlin.yml", { base: BASE_PACKAGE });
  if (identity === null) profile.identity = undefined as unknown as IdentityRule;
  else if (identity) profile.identity = identity;
  return extractKotlin(join(dir, SRC), profile, "t", "HEAD");
}

/** `Src -REL-> Dst`, packages stripped. */
const edges = (g: Graph): string[] =>
  g.edges.map((e) => `${e.src.split(".").pop()} -${e.rel}-> ${e.dst.split(".").pop()}`).sort();

const MODEL = "com/example/media/domain/model/";
const OTHER_DOMAIN = `package ${BASE_PACKAGE}.pay.domain.model\n\n@JvmInline\nvalue class Payment(val id: String)\n`;

/** Blob owns its own identity; MediaItem points at it by id. */
const BLOB =
  `package ${BASE_PACKAGE}.media.domain.model\n\n` +
  "@JvmInline\nvalue class BlobId(val value: String)\n\n" +
  "class Blob private constructor(\n" +
  "    val id: BlobId,\n" +
  "    val storageKey: String,\n" +
  ")\n";

/** The sealed root declares the id; the variants only pass it up. */
const MEDIA =
  `package ${BASE_PACKAGE}.media.domain.model\n\n` +
  "@JvmInline\nvalue class MediaId(val value: String)\n\n" +
  "sealed class MediaItem(\n" +
  "    val id: MediaId,\n" +
  "    val blobId: BlobId,\n" +
  ")\n\n" +
  "class Photo internal constructor(id: MediaId, blobId: BlobId) : MediaItem(id, blobId)\n\n" +
  "class Video internal constructor(id: MediaId, blobId: BlobId) : MediaItem(id, blobId)\n";

describe("resolving what an identifier identifies", () => {
  it("draws the aggregate, not the identifier", () => {
    const g = graphOf({ [`${MODEL}Blob.kt`]: BLOB, [`${MODEL}Media.kt`]: MEDIA });
    expect(edges(g)).toContain("MediaItem -REFERENCES-> Blob");
    expect(edges(g).some((e) => e.includes("-> BlobId"))).toBe(false);
  });

  it("resolves an aggregate whose name is not the identifier's stem", () => {
    // `MediaId` identifies `MediaItem`. Stripping the suffix gives `Media`, which
    // does not exist — the structural signal is the only one that gets this right.
    const g = graphOf({ [`${MODEL}Blob.kt`]: BLOB, [`${MODEL}Media.kt`]: MEDIA });
    expect(g.nodes.map((n) => n.name)).not.toContain("Media");
    expect(edges(g).some((e) => e.includes("MediaId"))).toBe(false);
  });

  it("ignores a parameter that only passes through to a supertype", () => {
    // Photo takes `id: MediaId` with no `val` — it declares nothing, so it does not
    // claim the identifier its root owns.
    const g = graphOf({ [`${MODEL}Blob.kt`]: BLOB, [`${MODEL}Media.kt`]: MEDIA });
    expect(edges(g)).toContain("Photo -EXTENDS-> MediaItem");
    expect(edges(g)).not.toContain("Photo -REFERENCES-> MediaItem");
  });

  it("takes the inheritance root when a subtype re-declares the id", () => {
    const g = graphOf({
      [`${MODEL}Blob.kt`]: BLOB,
      [`${MODEL}Media.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        "@JvmInline\nvalue class MediaId(val value: String)\n\n" +
        "sealed class MediaItem(open val id: MediaId, val blobId: BlobId)\n\n" +
        "class Photo(override val id: MediaId, blobId: BlobId) : MediaItem(id, blobId)\n",
    });
    // Both declare it, so the root decides. Neither may end up referencing the other.
    expect(edges(g)).not.toContain("Photo -REFERENCES-> MediaItem");
    expect(edges(g)).toContain("MediaItem -REFERENCES-> Blob");
  });

  it("leaves an identifier alone when its aggregate is out of scope", () => {
    const g = graphOf({
      [`${MODEL}Blob.kt`]: BLOB,
      [`${MODEL}Media.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        "@JvmInline\nvalue class OwnerId(val value: String)\n\n" +
        "class Album(val ownerId: OwnerId)\n",
    });
    // No type declares `val id: OwnerId`, so nothing is known about what it points
    // at. Dropping the edge would lose a reference that is really there.
    expect(edges(g)).toContain("Album -DEPENDS_ON-> OwnerId");
  });

  it("does not resolve when unrelated types claim the same identifier", () => {
    const g = graphOf({
      [`${MODEL}Blob.kt`]: BLOB,
      [`${MODEL}Rival.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` + "class Rival(val id: BlobId)\n",
      [`${MODEL}Holder.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` + "class Holder(val blobId: BlobId)\n",
    });
    // Blob and Rival both declare `val id: BlobId` and are unrelated, so there is no
    // answer in the source. The reference stays on the identifier rather than being
    // pointed at a guess.
    expect(edges(g)).toContain("Holder -DEPENDS_ON-> BlobId");
    expect(edges(g).some((e) => e.startsWith("Holder -REFERENCES->"))).toBe(false);
  });
});

describe("edges that must not become a reference", () => {
  it("drops a type's edge to its own identifier", () => {
    const g = graphOf({ [`${MODEL}Blob.kt`]: BLOB });
    expect(edges(g).some((e) => e.startsWith("Blob -"))).toBe(false);
  });

  it("drops a subtype's edge to the identifier its root owns", () => {
    const g = graphOf({ [`${MODEL}Blob.kt`]: BLOB, [`${MODEL}Media.kt`]: MEDIA });
    expect(edges(g)).not.toContain("Photo -REFERENCES-> MediaItem");
    expect(edges(g)).not.toContain("Video -REFERENCES-> MediaItem");
  });

  it("keeps the direct dependency when a type has both", () => {
    const g = graphOf({
      [`${MODEL}Blob.kt`]: BLOB,
      [`${MODEL}Mover.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        "class Mover(val blobId: BlobId) {\n" +
        "    fun move(b: Blob): Blob = b\n" +
        "}\n",
    });
    // A direct dependency subsumes the id reference; one fact, one line.
    expect(edges(g)).toContain("Mover -DEPENDS_ON-> Blob");
    expect(edges(g)).not.toContain("Mover -REFERENCES-> Blob");
  });

  it("leaves an edge out of an identifier alone", () => {
    const g = graphOf({
      [`${MODEL}Blob.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        "@JvmInline\nvalue class BlobId(val value: String) {\n" +
        "    companion object {\n" +
        "        fun new(): BlobId = BlobId(Keys.next())\n" +
        "    }\n" +
        "}\n\n" +
        'object Keys {\n    fun next(): String = ""\n}\n\n' +
        "class Blob private constructor(val id: BlobId)\n",
    });
    // Only edges *into* an identifier are rewritten.
    expect(edges(g)).toContain("BlobId -DEPENDS_ON-> Keys");
  });
});

describe("the profile decides the convention", () => {
  const SUFFIX_CASE = {
    [`${MODEL}Blob.kt`]:
      `package ${BASE_PACKAGE}.media.domain.model\n\n` +
      "@JvmInline\nvalue class BlobId(val value: String)\n\n" +
      "class Blob(val storageKey: String)\n",
    [`${MODEL}Holder.kt`]:
      `package ${BASE_PACKAGE}.media.domain.model\n\n` + "class Holder(val blobId: BlobId)\n",
  };

  it("suffix resolves an aggregate that does not carry its own id", () => {
    // Blob declares no `id` here, so the property strategy cannot see it.
    expect(edges(graphOf(SUFFIX_CASE, { from: "property", property: "id" }))).toContain(
      "Holder -DEPENDS_ON-> BlobId",
    );
    expect(edges(graphOf(SUFFIX_CASE, { from: "suffix", suffix: "Id" }))).toContain(
      "Holder -REFERENCES-> Blob",
    );
  });

  it("without an identity block the graph is what it always was", () => {
    const files = { [`${MODEL}Blob.kt`]: BLOB, [`${MODEL}Media.kt`]: MEDIA };
    const off = edges(graphOf(files, null));
    expect(off.some((e) => e.includes("REFERENCES"))).toBe(false);
    expect(off).toContain("MediaItem -DEPENDS_ON-> BlobId");
    expect(off).toContain("Blob -DEPENDS_ON-> BlobId");
  });
});

describe("a reference by id is not a breach", () => {
  it("carries crossDomain but no violation", () => {
    const g = graphOf({
      "com/example/pay/domain/model/Payment.kt": OTHER_DOMAIN,
      "com/example/blob/domain/model/Blob.kt":
        `package ${BASE_PACKAGE}.blob.domain.model\n\n` +
        "@JvmInline\nvalue class BlobId(val value: String)\n\n" +
        "class Blob private constructor(val id: BlobId)\n",
      [`${MODEL}Media.kt`]:
        `package ${BASE_PACKAGE}.media.domain.model\n\n` +
        `import ${BASE_PACKAGE}.blob.domain.model.BlobId\n\n` +
        "class MediaItem(val blobId: BlobId)\n",
    });
    const ref = g.edges.find((e) => e.rel === "REFERENCES");
    expect(ref?.dst.endsWith(".Blob")).toBe(true);
    // Pointing at another context by id is how you avoid coupling to it. Reporting
    // it would penalise the design that got it right.
    expect(ref?.crossDomain).toBe(true);
    expect(ref?.violation).toBe("");
  });
});
