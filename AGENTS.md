# HCR ActionGuard **V5** — working rules

Read, in this order, before proposing or starting work in this directory:

1. [`../VISION_AND_SCOPE_GUARD.md`](../VISION_AND_SCOPE_GUARD.md)
2. [`../AGENTS.md`](../AGENTS.md)
3. [`../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md`](../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md)
   — the plan this version implements.
4. [`../research/HACKATHON_INTERRUPT_SAFE_ACTION_USP_PLAN_2026-09-02.md`](../research/HACKATHON_INTERRUPT_SAFE_ACTION_USP_PLAN_2026-09-02.md)
5. [`../research/FAILED_AND_UNRESOLVED_REGISTER.md`](../research/FAILED_AND_UNRESOLVED_REGISTER.md)

They override anything in this file.

## What V5 is

V5 is an isolated copy of V4's working voice core plus two independently
switchable additions:

- a **natural delivery style** — one extra prompt section, same voice, same
  model, same endpointing; and
- a **transcript comparison lab** — a no-authority sidecar that shows the
  original machine transcript beside a readable, machine-edited one.

Everything V4 already did is meant to keep working with both additions off.

## Hard rules for this directory

1. **Never edit V1, V2, V3 or V4.** All four are frozen: source, settings,
   databases, recordings and running processes. See
   [`docs/V5_ORIGIN_AND_FREEZE.md`](docs/V5_ORIGIN_AND_FREEZE.md). V4 is the
   fallback demo and must remain runnable without any restore step.
2. **Distinct runtime.** V5 uses frontend port **5175**, backend port **4176**,
   database `data/actionguard-v5.db`, and session-storage keys prefixed
   `v5_`. Never point a V5 process, proxy or script at a V1–V4 port or file.
   `server/db-path-guard.js` enforces the database half of this; use it
   anywhere a path can come from an argument, env var or request.
3. **No new provider.** Direct Gemini only. No Wispr API, LiveKit, Retell,
   ElevenLabs, Fish, Twilio, extra provider, paid account or phone number
   without the owner's explicit approval.
4. **No keyword branching.** No runtime conversational or business behaviour
   may branch on an exact word, memorised phrase, keyword list or regular
   expression. Interaction function is inferred semantically; business
   authority is deterministic server policy. Product-vocabulary hints exist for
   *recognition*, never for permission.
5. **Do not reintroduce the per-step semantic verifier**, and do not add a
   second semantic model or text-cleanup request inside a voice turn or a
   billing operation. F51 already measured that cost.
6. **The transcript lanes have no authority.** No sidecar or lab result may
   reach tool execution, confirmation state, the heard-state ledger, the agent
   prompt/history, the original transcript text, or a tool argument. Displayed
   transcript text is untrusted content everywhere it is rendered, exported or
   formatted.
7. **Honest labels only.** "Original machine transcript" and "Readable
   transcript — machine edited". Never "what the agent understood". No
   fabricated confidence percentages. No claim of better recognition because
   text looks cleaner.
8. **Nothing is "passing" until a physical test says so.** Distinguish
   *implemented*, *automatically tested*, *owner-approved demo candidate*, and
   *formally validated*. Do not carry V4's "Gate done" labels over as V5
   results.
9. **Browser-derived numbers are estimates**, must be labelled as such, and may
   only withhold a business action, never authorise one.
10. **Rollback is configuration, not deletion.** `VOICE_STYLE=baseline` plus
    `SMART_TRANSCRIPT_ENABLED=false` must restore V4-equivalent behaviour.

## Feature status — keep this table honest

See [`docs/V5_TEST_RESULTS.md`](docs/V5_TEST_RESULTS.md) for the current,
dated status of each stage. Do not mark anything promoted here.

## Order of work

- Stage 0 — isolated V5 exists, baseline tests and build recorded
- Stage 1 — natural delivery style, selectable before a call
- Stage 2 — transcript comparison lab on recorded clips
- Stage 3 — live transcript helper, implemented but **disabled** until the
  recorded-audio screen in the build plan section 12C passes

If a stage fails, diagnose that stage. Do not layer a new feature on top of a
failing one to hide it.

## After every physical test

Open the newest report in the billing-team view **before changing any code**.
Write down what happened, including anything that disagreed with the recorder's
estimates. Record new failures in
[`../research/FAILED_AND_UNRESOLVED_REGISTER.md`](../research/FAILED_AND_UNRESOLVED_REGISTER.md),
preserving the historical entries. Then decide.

## Language

Explain each experiment in beginner-friendly terms first, with a concrete
example from this agent (assistant speaks, caller interrupts, system reacts).
Introduce few technical terms at a time and gloss each one. Keep four things
separate and explicit: what was tested, what happened, what it means, what is
next.
