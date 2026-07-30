# Usage

hexwright answers one question in several ways: **does the code have the shape
it is supposed to have?** It exists because a coding agent can now produce
structure faster than anyone can review it — so a human needs to confirm the
shape by looking rather than by reading, and the agent needs to catch its own
breaks before asking.

Each guide below is a scenario — a situation you are actually in — rather than a
list of flags.

| | scenario | you are |
|---|---|---|
| 1 | [The agent's loop](1-agent-loop.md) | wiring the graph into a coding agent — design confirmed before any logic is written, boundaries checked before the PR |
| 2 | [Reviewing a branch](2-review.md) | looking at someone else's — or an agent's — finished work |
| 3 | [Exploring the architecture](3-explore.md) | trying to understand a system you did not write |
| 4 | [Everything else](4-recipes.md) | looking for the command that fits a one-off question |

## Before any of them

Nothing to install — every command runs through `npx`.

```bash
npx hexwright extract --repo ~/work/my-service
```

```
my-service @ main@3bab2d5
  nodes 701  Adapter 230 · DTO 126 · UseCase 113 · Port 60 · VO 55 · Service 46 · Error 29 · Entity 25 · Shared 14 · Event 3
  edges 2211  DEPENDS_ON 2021 · IMPLEMENTS 188 · EXTENDS 2
  domains 16
  source  server/src/main/kotlin  (gradle)
```

If that prints your source root and a plausible domain count, everything else in
these guides will work. If it stops asking which module to analyze, pass `--src`
once and reuse it:

```
found 3 Gradle modules with Kotlin sources (client/androidApp, media-processor, server).
hexwright assumes a single module — pass --src to pick one.
```

```bash
npx hexwright extract --repo ~/work/my-service --src server
```

Two options recur everywhere and are worth learning first.

**`--base <ref>`** turns on branch comparison. Without it hexwright only knows
the current state; with it, every command can tell you what *this branch*
changed. Use the branch you will merge into — usually `main`.

**`--src <path>`** picks the Gradle module when the repository has more than one.

hexwright never writes to the repository it analyzes. The base snapshot is taken
with `git archive` into a temp directory, so no worktree metadata is left behind.
