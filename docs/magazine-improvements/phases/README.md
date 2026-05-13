# Magazine Improvements — Phase Index

The master plan is [`../PLAN.md`](../PLAN.md) (locked). It is split into the phases below for execution by Sonnet. Each phase file is **self-contained**: it states its goal, the files it touches, the exact changes to make, and the acceptance criteria. Read only the phase you are about to execute — you do not need the others in your context.

## Execution order

Phases must be done in this order. Each one is shippable on its own.

| # | File | Stream | Est. | Depends on |
|---|------|--------|------|------------|
| 01 | [PHASE-01-font-upload.md](PHASE-01-font-upload.md) | §2 Font upload + preview | 1–2 d | — |
| 02 | [PHASE-02-live-text-render.md](PHASE-02-live-text-render.md) | §1A Live text render on canvas | 1 d | 01 |
| 03 | [PHASE-03-backend-text-autofit.md](PHASE-03-backend-text-autofit.md) | §C Backend auto-fit / wrap | 0.5 d | — (can run parallel to 02) |
| 04 | [PHASE-04-snap-engine.md](PHASE-04-snap-engine.md) | §1B/C/D Snap + nudge + hit-test | 1 d | 02 |
| 05 | [PHASE-05-typography-fields.md](PHASE-05-typography-fields.md) | §1F Typography fields | 1 d | 02, 03 |
| 06 | [PHASE-06-fg-alignment.md](PHASE-06-fg-alignment.md) | §3 BG+FG alignment editor | 1 d | 04 (reuses snap engine) |
| 07 | [PHASE-07-slot-placement.md](PHASE-07-slot-placement.md) | §4 Head-top anchor + capture guide + test panel | 2 d | — |
| 08 | [PHASE-08-feature-toggles.md](PHASE-08-feature-toggles.md) | §5 Feature toggles | 1 d | runs last |

Total rough estimate: ~9 working days.

## Conventions for every phase file

- **Goal** — 1–2 sentences.
- **Context** — what already exists in the repo (so Sonnet doesn't re-discover).
- **Acceptance criteria** — a check-list. Phase is done when all are true.
- **Files to touch** — explicit paths.
- **Steps** — numbered, code-level. Include data shapes, endpoint signatures, function names.
- **Testing** — how to verify locally.
- **Out of scope** — what NOT to do (so we don't scope-creep).

## Locked decisions (from PLAN.md)

Re-stated inline in each phase where relevant, but the canonical record is the "Decisions — locked" section at the end of [`../PLAN.md`](../PLAN.md).
