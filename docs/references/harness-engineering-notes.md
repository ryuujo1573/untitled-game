# Harness Engineering Notes

This file captures practical takeaways adapted from OpenAI's harness engineering article.

## Key Takeaways

1. Keep AGENTS short and map-like.
2. Store context in repository-local docs, not external chat/docs.
3. Treat plans and trackers as first-class artifacts.
4. Enforce architecture and taste via mechanical checks over time.
5. Turn recurring failures into codified guardrails.
6. Continuously perform "garbage collection" on stale docs and patterns.

## Mapping To This Repository

- Map-style entrypoint: [../../AGENTS.md](../../AGENTS.md)
- System-of-record docs root: [../index.md](../index.md)
- Design alignment and beliefs: [../design-docs/core-beliefs.md](../design-docs/core-beliefs.md)
- Execution plans: [../exec-plans/index.md](../exec-plans/index.md)
- Auto-correct loop: [auto-correct-loop.md](auto-correct-loop.md)
- Context freshness: [context-refresh-log.md](context-refresh-log.md)
- Quality trend visibility: [../quality-score.md](../quality-score.md)
