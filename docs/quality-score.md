# Quality Score

Track quality posture over time for both code and harness process.

## Grading Scale

- A: Strong, automated, low drift risk
- B: Good, mostly consistent, minor gaps
- C: Mixed, moderate drift risk
- D: Weak, frequent manual correction needed
- F: Unreliable

## Current Gradecard

| Domain                  | Grade | Evidence                                         | Biggest gap                                | Last updated |
| ----------------------- | ----- | ------------------------------------------------ | ------------------------------------------ | ------------ |
| Architecture boundaries | B     | Clear crate boundary map in ARCHITECTURE         | Add automated dependency checks            | 2026-04-20   |
| Plan hygiene            | B     | Active/completed plan flow and template in place | Enforce plan usage for all multi-step work | 2026-04-20   |
| Issue hygiene           | C     | Issue and debt trackers seeded                   | Need regular triage cadence                | 2026-04-20   |
| Doc freshness           | C     | Context refresh log established                  | No CI freshness checks yet                 | 2026-04-20   |
| Auto-correction loop    | B     | Loop and matrix documented                       | Add measurable closure SLA                 | 2026-04-20   |

## Update Rule

Update this file at least weekly or after major process changes.
