# Core Beliefs

These beliefs are the self-alignment baseline for agent work in this repository.

## Product And Engineering Beliefs

1. Correctness before cleverness.
2. Architecture boundaries are explicit and enforced.
3. Small, reviewable changes are preferred over large rewrites.
4. Behavior changes require tests or concrete validation evidence.
5. Observability and error messages should help future debugging.
6. Repeated feedback must be encoded as durable guidance.
7. Repository-local docs are the primary context source.
8. If context is missing, add it where future agents will find it.

## Golden Principles For Agents

1. Parse and validate data at boundaries.
2. Do not assume hidden context outside this repository.
3. Convert flaky assumptions into explicit checks.
4. Track debt early; do not let it become invisible.
5. Prefer deterministic behavior and reproducible steps.

## Self-Alignment Checklist

Use this checklist before opening or finalizing a change:

- Does the change follow [../../ARCHITECTURE.md](../../ARCHITECTURE.md) boundaries?
- Are acceptance criteria explicit?
- Is there a plan for non-trivial changes?
- Are failure modes tested or at least documented?
- Are task, issue, and debt trackers updated?
- Did this change add context for future agents?
