# Agent Entry Point

This repository follows an agent-first workflow inspired by harness engineering.
Use this file as a map, not a manual.

## Fast Start

1. Read [docs/index.md](docs/index.md) for the knowledge map.
2. Read [ARCHITECTURE.md](ARCHITECTURE.md) for crate boundaries.
3. If the task is non-trivial, create or update an execution plan in [docs/exec-plans/active](docs/exec-plans/active/README.md).
4. Keep trackers current while you work.
5. Before finishing, update relevant docs and logs.

## Source Of Truth Order

1. Code and tests
2. [ARCHITECTURE.md](ARCHITECTURE.md)
3. [docs/](docs/index.md)
4. [README.md](README.md)
5. External references

If docs and code disagree, treat code as current state and file a correction in [docs/exec-plans/issue-tracker.md](docs/exec-plans/issue-tracker.md).

## Where To Look

- Self-alignment principles: [docs/design-docs/core-beliefs.md](docs/design-docs/core-beliefs.md)
- Architectural map: [ARCHITECTURE.md](ARCHITECTURE.md)
- Design index and verification state: [docs/design-docs/index.md](docs/design-docs/index.md)
- Active work plans: [docs/exec-plans/active](docs/exec-plans/active/README.md)
- Completed plans: [docs/exec-plans/completed](docs/exec-plans/completed/README.md)
- Task tracker: [docs/exec-plans/task-tracker.md](docs/exec-plans/task-tracker.md)
- Issue tracker: [docs/exec-plans/issue-tracker.md](docs/exec-plans/issue-tracker.md)
- Tech debt tracker: [docs/exec-plans/tech-debt-tracker.md](docs/exec-plans/tech-debt-tracker.md)
- Auto-correct loop: [docs/references/auto-correct-loop.md](docs/references/auto-correct-loop.md)
- Context freshness log: [docs/references/context-refresh-log.md](docs/references/context-refresh-log.md)
- Quality gradecard: [docs/quality-score.md](docs/quality-score.md)

## Standard Agent Loop

1. Align
   - Restate objective, constraints, and acceptance criteria.
   - Confirm relevant beliefs, architecture boundaries, and existing plans.
2. Plan
   - Use a plan file for multi-step work.
   - Link plan items to tasks and issues.
3. Execute
   - Keep diffs small and scoped.
   - Update progress log while implementing.
4. Validate
   - Run targeted checks first, then broader checks.
   - Record validation evidence in the plan.
5. Auto-correct
   - If failure appears, classify and trace root cause.
   - Add or update test/check/doc so failure is less likely to recur.
6. Publish context
   - Update design docs, trackers, and freshness logs.
   - Move plan from active to completed when done.

## Definition Of Done

- Code and tests pass required checks.
- Plan status is current.
- Task and issue trackers are updated.
- Relevant docs reflect current behavior.
- Any newly discovered gap is logged as issue or tech debt.

## Doc Hygiene Rules

- Keep this file short; route details into docs.
- Prefer additive, timestamped entries over silent rewrites of history.
- When updating behavior, update docs in the same change.
- Convert repeated review feedback into durable docs or checks.
