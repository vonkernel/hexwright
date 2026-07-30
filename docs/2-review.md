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
  `IMPLEMENTS` is a long-dashed curve with a hollow triangle, `EXTENDS` a
  short-dashed one.

Coordinates are deterministic — the same graph always draws the same file — so
two renders of two branches can be compared directly.

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
