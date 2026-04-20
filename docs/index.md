# AI Harness Knowledge Base

This directory is the repository-local system of record for agent context.

Goal: give agents a map, not a giant manual.

## Capability Map

| Capability              | Primary docs                                                                                                                                                                             | Update trigger                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Self-alignment          | [design-docs/core-beliefs.md](design-docs/core-beliefs.md), [quality-score.md](quality-score.md)                                                                                         | Team principles change, repeated review feedback |
| Auto-correct            | [references/auto-correct-loop.md](references/auto-correct-loop.md), [exec-plans/issue-tracker.md](exec-plans/issue-tracker.md)                                                           | Build/test/runtime failures, regressions         |
| Up-to-date context      | [design-docs/index.md](design-docs/index.md), [references/context-refresh-log.md](references/context-refresh-log.md)                                                                     | Behavior changes, stale docs found               |
| Task and issue tracking | [exec-plans/task-tracker.md](exec-plans/task-tracker.md), [exec-plans/issue-tracker.md](exec-plans/issue-tracker.md), [exec-plans/tech-debt-tracker.md](exec-plans/tech-debt-tracker.md) | New work, bugs, debt discovery                   |

## Navigation

- Design docs: [design-docs/index.md](design-docs/index.md)
- Execution plans and trackers: [exec-plans/index.md](exec-plans/index.md)
- Reference procedures: [references/index.md](references/index.md)
- Top-level architecture map: [../ARCHITECTURE.md](../ARCHITECTURE.md)
- Agent entry point: [../AGENTS.md](../AGENTS.md)

## Operating Model

1. Start from [../AGENTS.md](../AGENTS.md).
2. Pull only the docs needed for current task.
3. Execute with plan + validation loop.
4. Write back context as part of completion.

## Freshness Contract

- Every non-trivial change updates one of:
  - an execution plan,
  - a tracker,
  - and a related design/reference doc.
- Any discovered mismatch between docs and code becomes an issue entry.
- Completed work moves from active plans to completed plans.

## Last Updated

- Date: 2026-04-20
- Reason: initial harness documentation system setup
