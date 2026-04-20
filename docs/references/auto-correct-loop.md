# Auto-Correct Loop

Use this loop whenever a failure, regression, or mismatch is found.

## Loop

1. Detect
   - Capture symptom and where it was observed.
2. Classify
   - Bug, regression, docs drift, flaky check, or tooling gap.
3. Reproduce
   - Create deterministic reproduction steps.
4. Fix
   - Implement minimal correction.
5. Guard
   - Add test, lint, runtime assertion, or clearer doc guidance.
6. Record
   - Update issue/task/debt trackers and relevant plan.
7. Verify
   - Re-run affected checks and capture evidence.

## Failure To Guardrail Matrix

| Failure class            | Typical correction          | Durable guardrail                    |
| ------------------------ | --------------------------- | ------------------------------------ |
| Logic bug                | Code fix                    | Unit/integration test                |
| Runtime mismatch         | Data boundary validation    | Runtime assertion + error message    |
| Docs drift               | Doc correction              | Freshness log update + tracker entry |
| Repeated review feedback | Refactor + style correction | Rule in beliefs, docs, or lint       |
| Tooling gap              | New helper script/tool      | Add to references and plan template  |
