# ADR-0009: Static call-graph confidence policy

- Status: accepted · Date: 2026-11-08

## Decision
Call edges are created only for statically provable targets — same-file unique declarations,
imported bindings to resolved exports, namespace members, `this`/`self` methods declared in the
enclosing class, unambiguous constructors — with `high` confidence, and for static member access
through a class name with `medium`.

Everything else (inherited members, `super`, dynamic dispatch, expression receivers, computed
names, callbacks, dependency injection, reflection) stays an `unresolved` reference with a reason.
Same-name candidates are `ambiguous`. Calls into external packages are `resolved_external`
references without edges. `low` confidence never produces an edge.

## Consequences
The call graph under-approximates and says so; users can inspect unresolved call references in the
JSON export. Inheritance-aware member lookup is a candidate for v0.2.
