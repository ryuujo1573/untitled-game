# Doc Gardening Checklist

Run this checklist regularly to keep context current.

## Per Change

- Confirm plan and tracker entries are current.
- Confirm behavior-changing code has matching doc updates.
- Add issue entry for any discovered docs mismatch.

## Weekly

- Review active plans for stale status.
- Move completed plans out of active.
- Review issue tracker for resolved items that can be closed.
- Review debt tracker and pick at least one repayment candidate.
- Update [../quality-score.md](../quality-score.md) grades.

## Monthly

- Verify [../../ARCHITECTURE.md](../../ARCHITECTURE.md) still matches crate boundaries.
- Review core beliefs and retire outdated guidance.
- Ensure reference docs still match actual development workflow.

## Suggested Validation Commands

- cargo check --workspace
- cargo test --workspace
