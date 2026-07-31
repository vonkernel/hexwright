# 4 · Everything else

*Short answers to one-off questions, and the two commands the other guides did
not need.*

## Keep structural change in the repository

```bash
npx hexwright extract --repo . --src server --out .design
```

Writes two files:

- `graph.json` — the whole graph, contracts included. Machine input.
- `graph.tsv` — one line per node and edge, sorted, package prefix stripped.

Commit the TSV. Because it is sorted text, `git diff` on it reads as a list of
what structurally appeared and disappeared — the same information the render
draws, in a form that survives in history and can be grepped years later.

```
# hexwright  project=my-service  ref=main@3bab2d5  prefix=com.acme.service.
# nodes=701  edges=2211
N  record.application.service.RecordService  record  Service  app/.../RecordService.kt:34
E  IMPLEMENTS  record.adapter.out.persistence.RecordPersistenceAdapter  record.application.port.out.RecordRepository
```

`N` is a type — stripped id, domain, component, location. `E` is a relation —
kind, source, target. A diff of that file after a branch:

```diff
+N  media.application.service.MediaLabelResolver  media  Service  app/.../MediaLabelResolver.kt:15
+E  DEPENDS_ON  media.application.service.MediaService  media.application.service.MediaLabelResolver
```

## Ask a question without a browser

```bash
npx hexwright extract --repo . --src server --json | jq '
  .nodes[] | select(.component=="Port") | {name, domain, api: (.api|length)}'
```

The JSON is the full graph, so anything the web UI or MCP shows can also be
computed from it. Some questions that are one `jq` away:

```bash
# ports nobody implements
--json | jq '[.nodes[]|select(.component=="Port")|.id] as $p
  | [.edges[]|select(.rel=="IMPLEMENTS")|.dst] as $i
  | $p - $i'

# the most depended-upon types
--json | jq '[.edges[]|select(.identifierOnly|not)|.dst]
  | group_by(.) | map({id: .[0], n: length}) | sort_by(-.n) | .[:10]'
```

## Gate on boundaries

```bash
npx hexwright check --repo . --src server
```

Exits 1 if the repository has any violation, 0 otherwise, and prints each breach
with its file.

```bash
npx hexwright check --repo . --src server --base origin/main --scope delta
```

`--scope delta` fails only on what the branch introduced, so a repository with
existing violations can be gated today. It needs `--base`. See
[scenario 2](2-review.md#in-ci--github-actions) for the CI workflow.

It is a boundary check, not a test — it says a controller touches an Entity, not
that the code is wrong in any other way.

A pre-push hook is the usual local home for it:

```bash
#!/bin/sh
npx -y hexwright check --repo . --src server --base origin/main --scope delta || {
  echo "this branch introduces boundary violations — see above"; exit 1; }
```

## Render something other than the delta

```bash
# the whole shape, for onboarding or a design doc
npx hexwright render --repo . --src server --view core --image arch.png

# one bounded context and its neighbours
npx hexwright render --repo . --src server --view domain:record --image record.png

# everything, adapters and DTOs included — large, for zooming into
npx hexwright render --repo . --src server --view all --image full.svg

# only the breaches, and the types they run through
npx hexwright render --repo . --src server --view violations --image viol.png
```

Layout follows the view: `organic` for `delta`, `domain:` and `violations`
(domain blocks placed by coupling), `hex` for `core` and `all` (concentric rings,
read as a shape). Override with `--layout organic|grid|hex`.

## Show what a branch changed *from*

```bash
npx hexwright render --repo . --src server --base origin/main --at base --image before.png
npx hexwright render --repo . --src server --base origin/main           --image after.png
```

`--at base` draws the types the delta covers as they stood before the branch —
the state your working tree no longer has once the change lands. Violations stay
red; the delta styling is dropped, because nothing in a picture of the past can be
added or modified.

The two images line up — same coordinates, same colours, same canvas — so they can
be flipped between as well as read side by side. Both commands work that out on
their own; there is no flag to remember and no order to run them in. See
[scenario 2](2-review.md#the-picture-that-no-longer-exists) for what the pair is
for.

Either half can legitimately come out empty — a branch that only adds types has
no before state, and a branch that fixed everything has no violations left. Both
print what happened and **exit 0**, so a script that renders both halves does not
need to special-case them.

`--image x.png` always writes `x.svg` too. PNG needs the optional
`@resvg/resvg-js`; without it the SVG is still written and the command says so.
GitHub does not render SVG in comments — attach the PNG there and keep the SVG as
the artifact.

## Adapt it to a different layout

Conventions are data, not code — `profiles/hexagonal-kotlin.yml`. Path fragments,
component rules and boundary rules are all declarative, so `port/in` versus
`port/inbound`, or `infrastructure/` versus `adapter/`, is a config change rather
than a fork:

```bash
npx hexwright extract --repo . --profile ./my-profile.yml
```

If the domain is not the segment right after the common package prefix, set the
prefix explicitly:

```bash
npx hexwright extract --repo . --base-package com.acme.service
```

## Serve the web UI and MCP together

```bash
npx hexwright serve --repo . --src server --base main --mcp --port 7800
```

You and the agent then read the same graph at the same time — useful in the
confirmation loop of [scenario 1](1-agent-loop.md), where you are looking at a
picture while the agent answers questions about it.

---

Back to [the scenario list](README.md).
