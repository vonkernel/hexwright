# 2 · Reviewing a branch

*The work is done. You are looking at a branch — yours, a teammate's, or a coding
agent's — and deciding whether it matches the design.*

A text diff answers "which lines moved". It does not answer "did a new dependency
appear between two bounded contexts", which is the question that decides whether
the change is right. That answer is structural, and it is what this scenario is
for.

## One picture for the PR

```bash
npx hexwright render --repo ~/work/my-service --src server \
  --base main --image delta.png
```

```
  view    what this branch added and changed
  drew    10 types · 18 relations · 0 violations
  wrote   delta.svg  (17 KB)
  wrote   delta.png  (802×614)
```

Attach `delta.png` to the pull request. It draws **only what changed** — added
types with a solid orange outline, modified ones with a violet dash, new
relations in orange.

That narrowing loses nothing. Every relation the branch introduced has both ends
inside the changed set, so drawing only the changed set keeps all of them while
dropping the dependencies the modified types already had. On the branch above
that is 10 types instead of 61, and the image lands in a comment at full size
instead of being scaled down until the labels are unreadable.

## Who else is affected

```bash
npx hexwright render --repo ~/work/my-service --src server \
  --base main --view impact --image impact.png
```

`--view impact` keeps everything above and adds every type that depends on
something the branch changed. On the same branch that grows from 10 types in one
domain to 30 types across seven — which is the honest blast radius of a change
that looked local.

Use `delta` to answer *what was built* and `impact` to answer *what might break*.

## The picture that no longer exists

Both renders above answer *what this branch built*. On a branch that removes
violations, or replaces one port with another, the more useful half is the state
it started from — and that is precisely the state your working tree no longer has.

`--at base` draws the same types the delta covers, as they stood before the branch:

```bash
# before — the state this branch is changing
npx hexwright render --repo . --src server --base origin/main \
  --at base --image before.png

# after — what it becomes
npx hexwright render --repo . --src server --base origin/main \
  --image after.png
```

```
my-service @ main
  view    the types this branch touches, as they stand
  drew    21 types · 18 relations · 7 violations
  wrote   before.svg  (19 KB)
```

Note the ref in the header: `main`, not the branch. The picture is the base.

The pair reads as **state → change**:

| | answers |
|---|---|
| `--at base` | these types as they were, breaches in red |
| the default | what the branch adds and modifies |

For a PR that *fixes* structure rather than adding it, that pair is the artifact
that answers the reviewer's actual question — and the `after` half showing no red
means far more next to a `before` that has seven.

### Why the before picture has no orange

It carries no delta styling at all, and that is deliberate. Delta annotations are
forward-looking: a type is *added* relative to something. In a picture of the past
nothing can be added or modified, and a type the branch is about to **delete**
drawn with the solid orange outline that means *new* is worse than no annotation —
it says the opposite of the truth.

Violations stay red, because a violation is a verdict on a state rather than a
delta annotation. "Where does it breach" is the whole question a before picture
exists to answer.

### Only the breaches

`--view violations` narrows any render to the types a violation runs through, and
only the violating edges:

```bash
npx hexwright render --repo . --src server --view violations --image viol.png
```

It is a state view, so it works with or without `--base`, and combines with
`--at base`. On a large codebase this is the difference between a readable image
and an unreadable one: 21 types instead of the 247 that `--view core` draws.

The web UI's `⚠ Violations only` toggle is narrowed by the component filter, so
under the default Core-only preset a breach whose far end is an Adapter keeps the
core endpoint and loses the line. The flag deliberately does not do that — a
standalone image with a half-drawn violation is worse than one with none.

### The two images line up

Put them side by side, or flip between them: a type sits in the same place in
both, the domain boxes match, the colours match and the canvases are the same
size. Where the branch deleted something, the after image has a gap exactly where
it used to be.

That does not happen by itself. Positions, boxes, hues and canvas width are all
derived from the set of types being laid out, and the two halves differ by
whatever the branch added or removed — so laying each out from its own set makes
all four disagree. Each render instead lays out from the **union** of both halves
and draws only its own.

Neither command takes a flag for it, and neither can be run "wrong" by forgetting
one: both halves hold the base graph and the head graph, so each works the union
out on its own and they arrive at the same answer without being told about each
other.

### One limit worth knowing

**A branch that only adds types has no before state.** Nothing it draws exists in
the base, so there is nothing to render. The command says so and **exits 0** — the
default delta view already answers that case, and failing would break a script
that renders both halves unconditionally.

```
my-service @ main
  nothing this branch touches exists here — nothing to draw
```

The same applies to `--view violations` on a clean branch: `no violations —
nothing to draw`, exit 0. That is the good outcome, and it is reported as one.

Costwise the pair is nearly free: the base snapshot is already extracted to
compute the delta, so `--at base` chooses what to draw rather than analysing
twice.

## When the change is between two contexts

A delta render answers *what this branch built*. When the change is one bounded
context reaching into another, the question underneath is narrower: what does it
use over there, and through which contract.

```bash
npx hexwright interface --repo . --src server \
  --provider pay --consumer order --image iface.png
```

```
order → pay
  drew    2 contracts · 4 operations used · 1 held by id
```

Three columns with the provider's contract in the middle. On the left the
consumer classes, each with the role it plays in its own domain and the methods
that do the calling; on the right whoever implements that contract. A line runs
from a calling method to the operation it calls, so the picture reads as a
sentence rather than a diagram to trace.

Two things it shows that a graph view cannot:

**Operations offered and never called** stay in the picture, dimmed. That is how
you see a consumer using a contract badly — reaching for three operations when the
interface offers a fourth that was built for exactly this.

**What is held by identifier** is listed under the columns rather than among them.
Depending on a contract binds you to the other context's API; holding an id is
what you do to avoid that. Drawing them alike would hide which one you have.

`--provider` and `--consumer` are roles, not a pair — reverse them for the other
direction. A direction with no dependency is a real answer and gets a sentence
rather than an empty picture, so a script can render both halves without
special-casing either.

## The same thing as text

If you want the change in the terminal, or in a comment body rather than an
image:

```bash
npx hexwright extract --repo ~/work/my-service --src server --base main
```

```
delta vs main
  added   6 nodes · 15 edges
  modified 4 nodes
  removed 0 nodes · 0 edges
    + MediaLabelQueryAdapter [Adapter] media
    + LabelView [DTO] media
    + MediaLabelQueryPort [Port] media
    + PersonTagRow [DTO] media
    + PlaceTagRow [DTO] media
    + MediaLabelResolver [Service] media
    ~ MediaDetailView [DTO] media
    ~ MediaSummaryView [DTO] media
    ~ BestCutService [Service] media
    ~ MediaService [Service] media
```

Through MCP, `get_delta` goes further and says *what* changed inside each
modified type, so "modified" is actionable without opening the file:

```
  ~ MediaService [Service] media — .../MediaService.kt:48
      + property  labelResolver: MediaLabelResolver
      + depends   MediaLabelResolver
      + depends   LabelView
```

## Reading the picture

Three things carry meaning, and they are independent of each other:

- **Colour is the domain.** Hues are assigned per bounded context and never enter
  the red or orange band, so a red line always means a violation and an orange
  one always means new.
- **Shape is the component.** Entity is a barrel, Service a rectangle, Port a
  cut-rectangle, Event a rhomboid, DTO a dashed outline.
- **Line style is the relation.** `DEPENDS_ON` is straight with an open V,
  `REFERENCES` a finely dotted curve, `IMPLEMENTS` a long-dashed curve with a
  hollow triangle, `EXTENDS` a short-dashed one. `REFERENCES` is drawn lightest
  on purpose — it is a dependency held through an identifier rather than on the
  type, which is the weaker coupling by design.

Coordinates are deterministic — the same graph always draws the same file — so
re-rendering a branch is stable and nothing drifts between runs. They follow the
set of types drawn, so two renders of two different sets would place the same type
differently; a before/after pair works around that by laying both out from the
union, which is what makes [the pair
comparable](#the-picture-that-no-longer-exists).

## Checking boundaries

```bash
npx hexwright check --repo ~/work/my-service --src server
```

```
violations 7
  AdminAuthController → admin.AdminAccount   inbound adapter touches Entity
      app/famtography/admin/adapter/web/AdminAuthController.kt
  ...
```

Exit 1 if the repository has any violation. On a codebase that already has some,
that fails forever — so gate on what the branch *introduced* instead:

```bash
npx hexwright check --repo . --src server --base origin/main --scope delta
```

```
violations 0 new  (7 pre-existing, not gated)
```

Exit 0. Introduce one and it says so, names it, and exits 1. This is what lets
you put the gate on a repository today rather than after paying off the debt.

The comparison is between **violation sets**, not between edges. A type moved
into the adapter package, or a profile rule changed, can turn a relation that
already existed into a violation — the edge is unchanged, the verdict is not.
Those count as new.

## In CI — GitHub Actions

Any CI works; the command is just `check`. What it needs from the runner is the
same everywhere: **Node 22 or newer**, and **the base branch present locally** so
the comparison can be made. The example below is GitHub Actions — see the note
after it for other runners.

```yaml
name: architecture
on: pull_request

jobs:
  boundaries:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the base ref has to exist locally
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: >
          npx -y hexwright check --repo . --src server
          --base origin/${{ github.base_ref }} --scope delta
```

`fetch-depth: 0` matters. The default checkout is shallow and the base branch is
not in it; hexwright then stops with the fetch command you need rather than a git
stack trace.

To attach the picture as well, render it and upload it — GitHub does not render
SVG in comments, and there is no built-in way to inline an image from a job, so
the PNG goes up as an artifact and the run links to it:

```yaml
      - run: >
          npx -y hexwright render --repo . --src server
          --base origin/${{ github.base_ref }} --image delta.png
      - uses: actions/upload-artifact@v4
        with:
          name: design-delta
          path: delta.*
```

## On other runners

Only two lines are GitHub-specific: the checkout depth and where the base branch
name comes from. Everywhere else, fetch the base branch yourself and pass it:

```bash
git fetch --no-tags --depth=1 origin "$TARGET_BRANCH:refs/heads/$TARGET_BRANCH"
npx -y hexwright check --repo . --src server --base "$TARGET_BRANCH" --scope delta
```

The branch being merged into is named differently per system — GitLab CI has
`$CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, Jenkins `$CHANGE_TARGET`, CircleCI does
not expose one and you pass it in. Everything after that is identical, and
`--image` for the render behaves the same; only the artifact upload step changes.

---

Next: [3 · Exploring the architecture](3-explore.md)
