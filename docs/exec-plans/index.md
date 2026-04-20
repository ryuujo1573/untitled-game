# Execution Plans And Trackers

Execution plans are first-class artifacts for non-trivial work.

## When A Plan Is Required

Create a plan when any of these are true:

- Change spans multiple files or crates.
- Change includes migration or risky behavior shifts.
- Work needs iterative validation.
- Work is expected to take more than one focused session.

## Plan Lifecycle

1. Create plan in [active](active/README.md) from [template](active/EXEC-PLAN-TEMPLATE.md).
2. Track progress and validation evidence in the plan.
3. Link all related tasks/issues/debt entries.
4. Move plan to [completed](completed/README.md) when done.

## Trackers

- Task tracker: [task-tracker.md](task-tracker.md)
- Issue tracker: [issue-tracker.md](issue-tracker.md)
- Tech debt tracker: [tech-debt-tracker.md](tech-debt-tracker.md)
