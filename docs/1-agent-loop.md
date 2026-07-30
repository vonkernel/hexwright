# 1 · The agent's loop

*A coding agent is about to implement a feature. You want to confirm the design
before it writes any logic, and you want the agent to catch its own boundary
breaks before you have to.*

hexwright reads **source, not commits**. So a design does not have to be a
diagram: the agent writes the interfaces and class declarations — no bodies — and
the graph draws them immediately, next to everything that already exists.

```
skeleton  →  picture  →  confirm  →  implement  →  self-check
```

Rejecting a design at the third step costs one `rm`. Rejecting it after the logic
is written costs the logic.

## Connect it

```bash
claude mcp add hexwright --scope local -- \
  npx -y hexwright mcp --repo . --src server --base main
```

`--scope local` keeps the registration out of the repository. To share it, use
`--scope project` and commit the resulting `.mcp.json`, or write it by hand:

```json
{ "mcpServers": { "hexwright": {
    "command": "npx",
    "args": ["-y", "hexwright", "mcp", "--repo", "/abs/path", "--src", "server",
             "--base", "main"] } } }
```

`--base` is what makes `get_delta` and `check_violations(scope: "delta")` work.
Without it the agent can read the structure but cannot tell what it changed.

The graph re-reads the source on every call, so an answer always reflects the
files as they are now — including an edit made a second ago. When nothing changed
a call costs about 7 ms; after an edit, about 100 ms to re-extract.

## Three tools

Anything obtainable by reading a file is not here. The agent already has Read and
Grep, and they are usually faster. What is left is what files cannot answer.

| tool | what only the graph knows |
|---|---|
| `check_violations(scope)` | a verdict over the whole graph — "cross-domain Entity access" is not something you can grep for. `scope: "delta"` reports only what this branch introduced |
| `get_delta()` | the structural diff against the base, and for each changed type exactly which contracts and relations came and went |
| `dependencies(name, direction, hops)` | `out` — what it calls, including references held only in a local variable whose type name never appears in the source. `in` — who depends on it, which of its methods each consumer uses, and which nobody calls |

`dependencies(direction: "in")` is the one worth reaching for deliberately:

```
MediaPolicyPort [Port] media — .../MediaPolicyPort.kt:12

depended on by (2):
  ← MediaObjectEventService [Service] media
      uses: maxPhotoSizeBytes, photoQuality, photoThumbnailPx, … (13)
  ← UploadService [Service] media
      uses: maxPhotoSizeBytes, maxVideoDurationSec, maxVideoSizeBytes,
            photoAllowedFormats, videoAllowedFormats

declares 17, never called (4):
  hqPhotoMaxLongSidePx(): Int
  hqPhotoQuality(): Int
  hqPhotoFormats(): List<String>
  hqVideoHeight(): Int
```

Four dead methods, and two consumers whose overlap is five of seventeen. That is
an interface asking to be split — a conclusion nobody derives by reading the port
file, because the port file shows declarations, not callers.

## The picture, and the stop

The design step produces something a human can approve:

```bash
npx hexwright render --repo . --src server --base main --image design.png
```

```
  view    what this branch added and changed
  drew    10 types · 18 relations · 0 violations
  wrote   design.svg  (17 KB)
  wrote   design.png  (802×614)
```

Proposed types get a solid orange outline, new relations orange, and anything
that breaks a boundary is red. Nothing needs to compile and **nothing needs to be
committed** — the working tree is what gets read. Only `--base` comes from git.

For a conversation rather than an attachment, serve it instead — you click the
new port to see what will depend on it, and `--mcp` lets the agent answer
questions about the same graph at the same time:

```bash
npx hexwright serve --repo . --src server --base main --mcp
```

A draft PR is a convenient place to hold the picture, but hexwright does not need
one. A branch is enough; so is an uncommitted working tree.

## Telling the agent to do this

The tool descriptions say when to use each tool, and that is enough for the agent
to reach for the right one. What they cannot express is a sequence — and above
all they cannot say **stop and wait**. That has to come from the repository's own
agent instructions: `CLAUDE.md`, `AGENTS.md`, or a skill, depending on the tool.

```markdown
## Server code — design graph (hexwright MCP)

**Before implementing** anything that adds or changes a port, use case, service,
or that crosses a bounded context:

1. Write only declarations — interfaces, class signatures, DTO shapes. Bodies
   stay `TODO()`. Do not implement yet, and do not commit.
2. Render it:
   `npx -y hexwright render --repo . --src server --base main --image design.png`
3. **Stop and ask for confirmation**, attaching the image and stating in one or
   two sentences what the shape does and which existing types it touches.
4. Only after confirmation, fill in the bodies. If the design is rejected, delete
   the skeleton rather than reworking around it.

**While implementing**, before adding a method to an existing port or use case,
call `dependencies` with direction "in" — if the consumers already use disjoint
subsets, split the interface instead of growing it.

**Before opening the PR:**

- `check_violations` with scope `"delta"` — fix what this branch introduced, or
  state in the PR why it stands.
- `get_delta` — confirm the change matches what was approved in step 3.
```

Step 3 has to be a hard stop. An agent that renders the picture and keeps going
has produced a receipt, not a checkpoint.

That file belongs to the repository being worked on, not to hexwright.

---

Next: [2 · Reviewing a branch](2-review.md)
