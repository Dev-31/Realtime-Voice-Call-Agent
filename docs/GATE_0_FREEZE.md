# Gate 0 — frozen sources

**Date:** 2026-09-02
**Plan:** [`research/HACKATHON_INTERRUPT_SAFE_ACTION_USP_PLAN_2026-09-02.md`](../../research/HACKATHON_INTERRUPT_SAFE_ACTION_USP_PLAN_2026-09-02.md)

## What is frozen

| Project | Role from here on | Touched by V4? |
|---|---|---|
| `Prodapt IPL project V1` | Emergency demo. Working plan-change and human-review paths. | No. Read only. |
| `Prodapt IPL project V2` | Research evidence: Smart Turn, custom acoustics, HCR state ideas. | No. Read only. |
| `Prodapt IPL project V3` | Research evidence: direct-audio and observability primitives. | No. Read only. |
| `Prodapt IPL project V4` | **HCR ActionGuard.** The hackathon track. | Yes. All new work lands here. |

V4 is a new directory. Nothing in V1, V2 or V3 was edited, moved or deleted while
building it.

## What V4 inherited, and from where

**From V1 — the working business policy shape**

- Deterministic policy matrix; refunds are human-only.
- Idempotency-keyed terminal executors for a plan change and a review request.
- The HCR ledger and audit-event tables.

**From V3 — direct-audio and observability primitives only**

- The Gemini Live ephemeral-token issuer.
- PCM16 capture at ~21 ms chunks, resampling, and base64 framing.
- Epoch-guarded playback with immediate buffer clearing. This is the mechanism
  that measured 0–0.1 ms queue clears in V3's physical call.
- The prepare → distinct later confirmation → idempotent commit intent shape.
- The idea of a per-call event store with derived percentiles.

**From V2 — the HCR state idea only, re-implemented**

- The notion that an unfinished response must be tracked as a first-class object
  rather than assumed delivered. None of V2's code was copied.

## What V4 deliberately did NOT inherit

Each of these is closed by the plan, and each was left out on purpose:

| Left out | Why |
|---|---|
| V2 Smart Turn / manual activity endpointing | The complete physical path reached about 8.4 s p50 and 29.1 s p95. V4 uses provider-native automatic VAD. |
| V2 custom acoustic routing, denoisers, custom AEC replay | Untested against physical echo; the browser's WebRTC front end is requested instead and its actual settings are recorded. |
| V2 diarization and speaker fingerprints | No validated solution exists in this project for proving the primary caller. |
| **V3 `server/voice-semantic-verifier.js`** | A per-step LLM verdict on every prepare and commit. This was the single largest latency cost. V4 replaces it with deterministic server guards that cost microseconds. |
| Duration-only interruption intent, pitch/DSP turn cues | Closed by the plan. Interaction function is inferred semantically by the model. |
| Random filler, generated breaths, voice cloning, emotion-driven authority | Closed by the plan. |

The one browser-energy component that survives is
[`src/hcr/speech-energy-probe.js`](../src/hcr/speech-energy-probe.js). It exists
solely to timestamp roughly when the caller began making sound so the flight
recorder can report audible-stop latency. It gates nothing and authorises
nothing, and every number it produces is labelled an estimate.

## Verification

```
cd "Prodapt IPL project V4"
npm test          # 51 tests across policy, heard state, actions, recorder, HTTP
npm run build     # vite production build
npm start         # API on 127.0.0.1:4175
```

V1, V2 and V3 remain runnable on their own ports (4174 for V1/V2/V3, 4175 for
V4; Vite 5173 for V1/V2/V3, 5174 for V4), so the emergency demo can be brought
up alongside the hackathon track without a port clash.
