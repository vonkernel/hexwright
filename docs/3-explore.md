# 3 · Exploring the architecture

*You did not write this system and you need to understand its shape — where the
boundaries are, what crosses them, and what one type is entangled with.*

```bash
npx hexwright serve --repo ~/work/my-service --src server
```

```
hexwright — my-service @ main@3bab2d5
  701 nodes · 2211 edges · 7 violations
  web http://localhost:7800
```

The page opens on **Core only** — Entity, Service, UseCase, Port, Event — because
adapters and DTOs are two thirds of the nodes and none of the shape.

## Reading the picture

Each bounded context is a box. Inside it, the **Hexagonal** layout puts Entity at
the centre and works outward: Entity → Service → UseCase → Port → DTO·VO. So the
distance of a node from its domain's centre tells you its role before you read
its name.

The boxes themselves are placed by coupling — contexts that reference each other
sit close. Colour identifies the domain; saturation is the position in the
hexagon, dark at the core and lighter outward.

Coordinates are fixed, so the same project always draws the same picture and two
branches line up. **Organic re-layout** re-packs the boxes for whatever is
currently visible, which is what you want while filtering; switching it off
returns to the fixed coordinates exactly.

## One node at a time

Click a node. The panel shows its role, layer, file location, public contract,
and its connections split three ways:

```
RecordService  [Service] record
  Both 10      ← In 0      Out → 10
```

`← In` is who depends on this, `Out →` is what it depends on. A Service with zero
inbound is normal — adapters depend on the use-case interface, not on the
implementation. An Entity with a large inbound count is the centre of its domain.
An **Entity with inbound edges from another domain** is a boundary problem, and
it will already be drawn in red.

Click any item in the list to jump to that node and keep walking. `Esc` clears.

Click an **edge** and the panel shows which contract methods the source actually
calls on the target — not just that a dependency exists, but which part of the
interface it uses.

## Boundaries between contexts

Two switches answer most boundary questions.

**Cross-domain edges only** hides everything internal, leaving just the traffic
between bounded contexts. This is the interface map of the system.

**REFERENCES** is a dependency held through an identifier. A type keeping a
`BlobId` rather than a `Blob` is pointing at that aggregate, and pointing at it
the deliberately weaker way — no object graph to traverse, no shared transaction.
The edge is drawn at the aggregate, not at the id, and drawn lighter than a
direct dependency, so the two read differently at a glance. Turn it off to see
only what a type reaches for directly.

Which id belongs to which aggregate is a project convention, so the profile says
how to read it — see [Identity](../README.md#identity).

**Show value-type edges** is off by default. What is left under it once
identifiers resolve is references to the value objects and enums a domain model
is made of — `MediaLocation`, `ProcessingStatus` — plus identifiers whose
aggregate is outside the analysed source. Nearly every type touches those, and
leaving them on makes the graph a hairball.

**Violations only** keeps just the nodes and edges a violation runs through. It
combines with the filters above rather than overriding them — so if the default
Core-only preset is hiding Adapters, a violation whose one end is an adapter will
show its endpoint but not its edge. Press **All** first when you want to see
every breach.

## Comparing against a branch

```bash
npx hexwright serve --repo ~/work/my-service --src server --base main
```

With `--base`, added nodes get an orange outline and modified ones a violet dash,
and the **Branch delta only** checkbox reduces the view to just those. It is
independent of the component filter, so combining it with **Core only** answers
"what did this branch change to the actual structure, ignoring DTO churn".

## When the picture is too big

`all` on a large codebase is a wall. Three ways down:

- **Grid** layout lists domains left to right instead of by coupling — better for
  scanning names than for seeing shape.
- Turn domains off in the sidebar until only the ones you are studying remain,
  with **Organic** on so the rest closes up.
- Or stop using the browser and ask a question directly —
  [scenario 4](4-recipes.md) covers the query commands.

---

Next: [4 · Everything else](4-recipes.md)
