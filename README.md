# hexwright

Design graph for **hexagonal-architecture** codebases. Extracts the type graph
from source, checks **ports-and-adapters** boundaries, and renders exactly what a
branch changed — structurally, not as a text diff.

*(`hex` here is the hexagon, not hexadecimal.)*

## Why

A coding agent produces structure faster than anyone can review it, and the
review is where the risk now sits. A text diff answers *which lines moved*. It
does not answer *did a controller start reaching into another context's
aggregate* — which is the question that decides whether the change was right.

That question is structural, so hexwright answers it structurally, in both
directions:

- **A human confirms in seconds, by looking.** The delta renders as one picture:
  what the branch added, what it modified, and every relation it introduced. Not
  a claim about the code — a fact drawn from it. Cheap enough to attach to every
  PR, and cheap enough to attach to a *design*, before any logic exists, because
  the graph reads declarations from the working tree rather than commits.
- **The agent checks itself first.** Boundary verdicts are computed over the
  whole graph, so they are not something an agent can grep for and therefore not
  something it can skip by accident. Three MCP tools let it ask what it changed,
  what that reaches, and whether it broke a rule — before it asks you to look.

The human stays in the loop; what changes is that the loop costs a glance rather
than a careful reading, and that most breaks are caught before it starts.

Runs as a sidecar: it never writes to the target repository.

```bash
npx hexwright extract --repo ~/work/my-service --base main --out .design
npx hexwright check   --repo ~/work/my-service --base main --scope delta  # CI gate
npx hexwright render  --repo ~/work/my-service --base main --image delta.png
```

### Usage guides

Walkthroughs by scenario, rather than a list of flags.

| | guide | for when you are |
|---|---|---|
| 1 | **[The agent's loop](docs/1-agent-loop.md)** | wiring the graph into a coding agent — design confirmed before any logic is written, boundaries checked before the PR |
| 2 | **[Reviewing a branch](docs/2-review.md)** | looking at finished work, by hand or as a CI gate |
| 3 | **[Exploring the architecture](docs/3-explore.md)** | trying to understand a system you did not write |
| 4 | **[Everything else](docs/4-recipes.md)** | after the command that fits a one-off question |

## Render

An image for the PR — what this branch changed, in one picture.

```bash
hexwright render --repo ~/work/my-service --base main --image delta.png
```

```
  view    what this branch added and changed
  drew    10 types · 18 relations · 0 violations
  wrote   delta.svg  (17 KB)
  wrote   delta.png  (802×614)
```

The default draws **only what changed** — nothing pre-existing. That is not a
loss of information: every relation the branch introduced has both ends inside
the changed set, so narrowing keeps all of them while dropping the dependencies
the modified types already had. On the branch above that is 10 types instead of
61, and the image fits a PR comment at full size instead of being scaled down
until the labels are unreadable.

Use `--view impact` when the question is who is affected rather than what was
built — it adds everything that depends on a changed type (30 types, 7 domains
on the same branch).

Added types get a solid orange outline, modified ones a violet dash, new
relations orange. Everything unchanged stays as dimmed context. Red is reserved
for boundary violations — domain hues never enter the red or orange band, so a
red line always means a breach.

The delta is laid out **organically**: each domain is a dense block ordered
Entity → Service → UseCase → Port → DTO, and the blocks are placed by how much
they actually couple. A change spanning several contexts therefore draws itself
as a hub with the domains that touch it around it.

| `--view` | what it draws |
|---|---|
| `delta` *(default)* | only the added and modified types, and the relations between them |
| `impact` | the above plus everything that depends on a changed type |
| `core` | Entity · Service · UseCase · Port · Event — the whole shape |
| `all` | everything, adapters and DTOs included |
| `violations` | only the breaches, and the types they run through |
| `domain:<name>` | one bounded context and what it touches |

`violations` is a **state** view: it draws what is wrong now, not what this branch
changed. Unlike the toggle in the web UI it is not narrowed by component, because
a violation with one end hidden reads as no violation at all.

### Before and after

A branch that *removes* violations, or swaps one port for another, is not
described by the delta alone. The picture worth showing is the state it started
from — which is exactly the state the working tree no longer has. `--at base`
draws the same types in their pre-branch state:

```bash
hexwright render --repo . --base main --at base --image before.png
hexwright render --repo . --base main            --image after.png
```

The before picture carries **no delta styling** — nothing in a picture of the past
can be added or modified — and violations stay red, which is the question it
exists to answer. It needs `--base`. A branch that only adds types has no before
state at all; the command says so and exits 0.

A before/after pair **lines up**. Positions, domain boxes, colours and canvas
width all follow the set of types being laid out, and the two halves differ by
whatever the branch added or removed — so each render lays out from the union of
both and draws only its own half. A type keeps its place across the pair, and a
deletion leaves the gap where it used to be. Neither command needs a flag for
this and neither can be run "wrong": both derive the union from the same two
graphs.

There is no browser involved — the coordinates are a pure function, so the SVG
is written directly and CI needs no headless Chrome. The same graph always draws
the same file.

`--image x.png` also writes `x.svg`. PNG needs the optional `@resvg/resvg-js`;
without it the SVG is still written and the command says so. GitHub does not
render SVG in comments, so attach the PNG there and keep the SVG as the artifact.

Layout follows the view — `organic` for `delta`, `domain:` and `violations`, `hex`
for `core` and `all` (concentric rings, read as a shape). `--layout
organic|grid|hex` overrides; `grid` lists domains left to right, ignoring
coupling.

## Exit codes

| command | 1 | 0 |
|---|---|---|
| `check` | the repository has a violation — with `--scope delta`, only one the branch introduced | otherwise |
| `render` | a bad argument, or a base ref that is not in the clone | an image was written, **or there was nothing to draw** |
| `extract` | the source root or the base ref cannot be read | otherwise |

`render` treats an empty picture as an answer rather than a failure. `--view
violations` on the branch that removed the last one, and `--at base` on a branch
that only adds types, both print what happened and exit 0 — a non-zero exit there
would break the very script that produces the pair.

## MCP

Serve the graph to a coding agent over stdio:

```bash
hexwright mcp --repo ~/work/my-service --base main
```

```json
{ "mcpServers": { "hexwright": {
    "command": "npx",
    "args": ["-y", "hexwright", "mcp", "--repo", "/abs/path", "--base", "main"] } } }
```

Three read-only tools. Anything an agent can get by reading a file is not one of
them — it already has Read and Grep, and they are usually faster. What is left is
what files cannot answer.

| tool | what only the graph knows |
|---|---|
| `check_violations(scope)` | a verdict over the whole graph. `scope: "delta"` = only what this branch introduced |
| `get_delta()` | the structural diff against the base, per changed type |
| `dependencies(name, direction, hops)` | which methods a consumer actually calls, and which a port declares that nobody does |

Each description says *when* to reach for the tool, not only what it returns —
that is most of why this is an MCP server rather than a CLI the agent has to be
taught. What a description cannot carry is a sequence, or an instruction to stop
and wait for a human; [the agent loop](docs/1-agent-loop.md) covers that.

`dependencies` is the one that pays off:

```
MediaPolicyPort [Port] media
depended on by (2):
  ← MediaObjectEventService  uses: maxPhotoSizeBytes, photoQuality, … (13)
  ← UploadService            uses: maxPhotoSizeBytes, maxVideoDurationSec,
                                   maxVideoSizeBytes, photoAllowedFormats,
                                   videoAllowedFormats

declares 17, never called (4):
  hqPhotoMaxLongSidePx(): Int
  ...
```

Four dead methods and two consumers overlapping in five of seventeen — an
interface asking to be split. The port file shows declarations, not callers, so
reading it does not tell you this.

## Assumptions

Single-module **Gradle** project, **Kotlin**, **Spring Boot**, with a
domain-first (package-by-feature) hexagonal layout.

The source root is found by Gradle convention — `build.gradle(.kts)` up to two
levels deep, then `<module>/src/main/kotlin`. A monorepo with several Kotlin
modules stops with the list and asks you to pick one:

```
found 3 Gradle modules with Kotlin sources (client/androidApp, media-processor, server).
hexwright assumes a single module — pass --src to pick one.
```

`--src` takes either a module path (`server`) or a source root
(`server/src/main/kotlin`). If `settings.gradle` declares subprojects, it warns
and analyzes only the selected module.

Expected package layout — the domain is the segment right after the common
package prefix, which is inferred automatically:

```
<base>.<domain>.domain.model        Entity · VO
<base>.<domain>.domain.event        Event
<base>.<domain>.application.port.inbound   UseCase · DTO
<base>.<domain>.application.port.out       Port · DTO
<base>.<domain>.application.service        Service
<base>.<domain>.adapter.web                inbound adapter
<base>.<domain>.adapter.out                outbound adapter
<base>.common                              Shared
```

## What it produces

```
nodes 701  Adapter 230 · DTO 126 · UseCase 113 · Port 60 · VO 55 · Service 46 · Entity 25
edges 2211 DEPENDS_ON 2021 · IMPLEMENTS 188 · EXTENDS 2
domains 16

delta vs main
  added 6 nodes · 15 edges   modified 4 nodes   removed 0
    + MediaLabelQueryPort [Port] media
    ~ MediaService [Service] media

violations 7
  AdminAuthController → admin.AdminAccount   inbound adapter touches Entity
```

`--out` writes two files:

- `graph.json` — full graph including public contracts
- `graph.tsv` — one line per node/edge, sorted, prefix-stripped. Commit this and
  `git diff` shows structural change in readable form.

## Principles

**Only relations that exist in the source.** No derived or inferred edges. A
reference to `UserId` is not a reference to `User` — promoting it would fabricate
facts and every metric built on top would be wrong.

**Deterministic classification.** Component roles come from path + language
construct only. No human judgement, so results are reproducible and comparable
across commits.

**Signature-following.** When a type is only held in a local variable, its name
never appears in the source. The extractor reads the callee's signature to
recover the reference, so `service.save(x)` resolves `x` through
`Repository.findById(): Record?`.

## Profiles — adapting it to your layout

Every convention lives in a profile, not in code. `port/in` versus
`port/inbound`, `infrastructure/` versus `adapter/`, a different package depth —
all of that is a config change rather than a fork.

Start from the bundled one:

```bash
curl -O https://raw.githubusercontent.com/vonkernel/hexwright/main/profiles/hexagonal-kotlin.yml
npx hexwright extract --repo . --profile ./hexagonal-kotlin.yml
```

A profile has five parts, and they are read in this order.

**Where the domain is.** The domain is a package segment, found after stripping a
common prefix. Leave `base` empty and the longest common prefix is inferred —
which is right for a multi-domain codebase and wrong for a single-domain one,
where it swallows the domain too. Set it explicitly then, or pass
`--base-package`.

```yaml
domain:
  from: package
  base: ""     # com.acme.service — empty means infer
  at: 0        # which segment after the prefix is the domain
```

**Which layer a path is in.** Fragments, matched top to bottom, first hit wins.
Rename these and the whole tool follows:

```yaml
layers:
  adapter: /infrastructure/     # instead of /adapter/
  application: /application/
  domain: /domain/
  common: /shared/
```

**Subdivisions and adapter direction.** `sublayers` is what separates an inbound
port from an outbound one; `adapterKinds` is what lets an outbound adapter map
aggregates while an inbound one may not.

```yaml
sublayers:
  port/inbound: /application/port/in/    # instead of /port/inbound/
  port/out: /application/port/out/
  service: /application/service/
  model: /domain/model/

adapterKinds:
  out: /infrastructure/out/
  in: /infrastructure/rest/
```

**What each type is.** Ordered rules, first match wins. A rule may test the
layer, the sublayer, the language construct (`kinds`), the structural kind
(`structs`), or a name suffix:

```yaml
components:
  - { nameEnds: Exception, as: Error }
  - { sublayer: model, kinds: [value class], as: VO }
  - { sublayer: model, as: Entity }
  - { sublayer: port/out, structs: [interface], as: Port }
  - { sublayer: port/out, as: DTO }
  - { as: DTO }                       # fallback
```

Order carries the meaning. `port/out` + `interface` is a Port; the same path
without `interface` is a DTO, because that is what a class in a port package
actually is.

**What counts as a violation.** Both rules are explicit, so a codebase with a
different opinion can hold it:

```yaml
rules:
  entityAccess:
    allow: [Service, Port, Entity]    # may touch an Entity, same domain only
    allowAdapterKinds: [out]          # outbound adapters map aggregates
    crossDomain: deny
  layering:
    - from: [application, domain]
      to: [adapter]
      message: layer back-reference
```

Check a new profile against the tool's own reading before trusting it — if the
component counts look wrong, a path fragment is wrong:

```
nodes 701  Adapter 230 · DTO 126 · UseCase 113 · Port 60 · VO 55 · Service 46 · Entity 25
domains 16
```

Zero Ports or a domain count of 1 means the paths or the base package are not
matching your layout yet.

## Boundary rules

An Entity may be touched by, within the same domain: `Service`, `Port`, `Entity`,
and outbound adapters (port implementations must map aggregates). Everything else
is a violation:

- cross-domain Entity access — bounded context breach
- inbound adapter touching an Entity — controllers should speak DTOs
- a DTO or UseCase exposing an Entity — domain model leaked into a contract
- application/domain referencing adapter — layer back-reference

## Releasing

Trunk-based, tag-triggered. There is no release branch: `main` is the only branch
that ships, and one can always be cut from a tag later if a backport ever needs
one.

```bash
npm version minor -m "release: v%s"   # bumps package.json, commits, tags
git push --follow-tags
```

Pushing the tag runs [`release.yml`](.github/workflows/release.yml), which
refuses to publish unless the tagged commit is on `main` and the tag matches the
version in `package.json` — a tag that disagrees with what npm receives is worse
than a failed release, because it is only found out later. It then runs the same
gate a pull request has to clear, publishes with provenance, and opens a GitHub
Release for the tag.

There is no npm token. npm is configured to trust this repository and this
workflow **by filename**, and the OIDC token GitHub mints for the job is exchanged
for publish rights — so nothing has to be stored, rotated, or kept from expiring.
The catch is the filename: renaming `release.yml` breaks publishing until npm's
trusted-publisher entry is updated to match.

## Status

Early. Kotlin extractor only; validated against one production codebase
(701 nodes, 2211 edges) with output verified against a reference implementation.

MIT
