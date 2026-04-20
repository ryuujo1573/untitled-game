# Execution Plan: Harness Documentation System

## Metadata

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Plan ID           | 2026-04-20-harness-doc-system |
| Owner             | agent                         |
| Status            | Done                          |
| Created           | 2026-04-20                    |
| Target completion | 2026-04-20                    |
| Related issue(s)  | ISSUE-000                     |

## Context

Repository had architecture docs but no structured harness docs for alignment, correction loops, freshness, and trackers.

## Goals

- Create a short map-style AGENTS file.
- Add doc index and design belief docs.
- Add execution-plan workflow and templates.
- Add task, issue, and debt trackers.
- Add auto-correct and freshness references.

## Task Breakdown

- [x] Define AGENTS map and source-of-truth order.
- [x] Add docs index and design-doc index.
- [x] Add core beliefs and decision log.
- [x] Add execution plan lifecycle docs.
- [x] Add task/issue/debt trackers.
- [x] Add auto-correct and context refresh docs.

## Validation Evidence

- Confirmed all target files exist under docs.
- Confirmed cross-links are repository-local.
- Confirmed trackers contain initial seed entries.

## Decisions

- Keep AGENTS concise and route details to docs.
- Keep trackers in markdown for low-friction edits.
- Seed with one closed task and one monitoring issue to model usage.

## Follow-Up

- Add mechanical checks in CI for stale links and freshness fields.
- Establish recurring doc-gardening cadence.
