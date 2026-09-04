# HCR ActionGuard **V5**

Interruption-safe voice core for a BPO billing agent, plus two independently
switchable additions: a **natural delivery style** and a **transcript
comparison lab**.

V5 is an isolated successor to V4. **V1–V4 are frozen and were not modified.**

Planning a real call through the owner's Xiaomi/Jio number? See the
[nearby Ubuntu VM phone-demo plan](PHONE_CALL_VM_DEMO_PLAN.md).
It covers the phone test, V5 migration and proposed demo on/off control;
the telephone route has not yet been validated.

---

## What this is, in plain terms

A customer talks to an AI billing assistant as if on a phone call. They can talk
over it at any point. It stops, keeps track of which of its words actually
reached the caller's ear, takes the correction, and completes exactly one
business action — or none, which is often the right answer.

V5 adds two things to that:

1. **A natural delivery style.** One extra paragraph of instructions about *how
   to sound*. Same voice, same model, same rules about what it may do. You pick
   Baseline or Natural before a call starts.
2. **A transcript comparison lab.** Side by side: the plain machine transcript
   and a readable, machine-edited one. It is display-only. It cannot authorise,
   block or change anything, and there is a test suite whose entire job is
   proving that.

---

## Status — read this before claiming anything

| | |
|---|---|
| **Implemented** | Everything below. |
| **Automatically tested** | 226 tests pass, including 51 inherited from V4 unchanged. |
| **Heard by a person** | **No.** The natural style has not been listened to. |
| **Provider contacted** | Only the **voice** credential, once, successfully. The **transcription** model has never been called. |
| **Formally validated** | **No.** The 20-call gate has not been run on V5. V4's gate labels are V4's, not V5's. |

Full detail, including eleven real defects found and fixed and an explicit list of
what is *not* tested: [`docs/V5_TEST_RESULTS.md`](docs/V5_TEST_RESULTS.md).

---

## Run it

Requires **Node 22** (uses `node:sqlite`) and a `GEMINI_API_KEY`.

```bash
cd "Prodapt IPL project V5"
cp .env.example .env        # then paste your key into GEMINI_API_KEY
npm ci
npm run dev                 # app on 127.0.0.1:5175, API on 127.0.0.1:4176
```

> Copy the key **value** across from another project — never V4's whole `.env`.
> That file sets `PORT=4175`, which is V4's port; V5 would bind it, the dev
> server would still look for the API on 4176, and every request would fail
> silently. `server/port-guard.js` now refuses to start on a V1–V4 port and says
> so, but keeping `PORT=4176` is the actual fix.

V5 uses **its own** ports, database and browser session keys, so it can run
beside V4 without interfering with it.

| | V4 | V5 |
|---|---|---|
| App | 5174 | **5175** |
| API | 4175 | **4176** |
| Database | `data/actionguard.db` | **`data/actionguard-v5.db`** |
| Session keys | `actionguard_*` | **`v5_actionguard_*`** |

Sign in as the caller with **`CUST-1002` / `1002`** (Akash, Premium, ₹18
disputed charge). The billing team view is `employee@prodapt.demo` /
`TwinForge#2026` — use a second browser profile.

**Headphones are the tested baseline.** Open-speaker echo handling is not
validated and must not be claimed.

```bash
npm test                 # 226 tests
npm run build            # production build
npm run gate:report      # gate verdict from recorded calls
npm run transcript:eval  # transcript evaluation, dry run by default
```

---

## Configuration

One authoritative source: `server/config/features.js`, surfaced at
`GET /api/v5/features`. The server decides; a browser cannot switch on something
the server reports as off.

| Variable | Default | Effect |
|---|---|---|
| `VOICE_STYLE` | `baseline` | `baseline` reproduces V4's prompt byte-for-byte. `natural` appends one delivery section. |
| `SMART_TRANSCRIPT_ENABLED` | `false` | The live transcript helper. While false the token endpoint **refuses**, so no credential exists to misuse. |
| `TRANSCRIPT_LAB_ENABLED` | `true` | The on-demand comparison lab. No background calls. |
| `TRANSCRIPT_LAB_LIVE_CALLS` | `false` | Lets the lab make real provider calls. While false it plans the run and contacts nothing. |
| `TRANSCRIPT_LAB_STORE_AUDIO` | `false` | Writing clip audio to disk. Off by default. |
| `VOICE_NAME` | `Kore` | One of 30 documented prebuilt voices. Anything else falls back. |
| `VOICE_MODE` | `standard` | `standard` is Gemini 3.1, the V4 baseline. `expressive` is Gemini 2.5 with affective dialogue - a different model, and unverified. |
| `VOICE_EXPRESSIVE_ENABLED` | `false` | Server gate for the expressive engine. While false the token endpoint refuses it and downgrades to standard. |
| `AUDIO_PLAYBACK_MODE` | `continuous` | `continuous` runs the output at Gemini's own 24 kHz, removing the chunk-boundary tick. `v4-compatible` reproduces V4's playback exactly, tick included. |

**Rollback is configuration, not deletion.** `VOICE_STYLE=baseline` plus
`SMART_TRANSCRIPT_ENABLED=false` gives V4-equivalent behaviour with no files
removed. V4 itself needs no restore because it was never changed.

---

## Layout

```
server/
  app.js                    HTTP surface, + /api/v5/features and the token endpoint
  auth.js  db.js  tools.js  policy.js  ledger.js      inherited from V4, unchanged
  db-path-guard.js          NEW · refuses any database path outside this project
  agent/voice-modes.js      NEW · server-owned engine allowlist; the browser names a mode, not a model
  port-guard.js             NEW · refuses to start on a V1-V4 port
  config/features.js        NEW · the one authoritative feature source
  transcription/
    config.js               NEW · server-side model/mode/vocabulary allowlist
    token.js                NEW · model-and-config-locked short-lived credentials
  flight-recorder/index.js  + nine v5_* observation-only event types, + a report block
  agent/gemini-live.js      inherited from V4, unchanged

src/
  voice/prompt.js           inherited from V4, UNCHANGED ON PURPOSE
  voice/delivery-style.js   NEW · baseline = that file verbatim; natural = it + one section
  voice/playback-mode.js    NEW · 24 kHz output context + a 140 ms scheduling cushion
  voice/voices.js           NEW · the 30 documented voices and an audition shortlist
  voice/gemini-live.js      + style selection, + a non-blocking sidecar audio tap
  transcription/
    audio-normalize.js      NEW · pure audio maths, testable without a browser
    transcript-store.js     NEW · ordered lanes, no imports, no authority
    gemini-transcriber.js   NEW · one dedicated connection, bounded queue, lifecycle
    lab.js  panel.js        NEW · the comparison lab (loaded on demand)
  main.js                   + the V5 panel, + the report's experiment block

tests/    5 inherited suites + 7 new ones
scripts/  gate-report.js (now V5-path-guarded) · transcription-eval.js (NEW)
docs/     origin & freeze · decision log · test results · owner guide · demo script · corpus
```

---

## The safety boundary

The transcript lanes have **no authority**. Specifically:

- `transcript-store.js` imports **nothing at all** — it is a data structure with
  no session, no tool executor, no ledger and no API client.
- The nine `v5_*` recorder events are observation-only, and the
  confirmation-audibility guard reads neither of them.
- The token endpoint pins its credential to one model **and** one config, and
  refuses rather than falling back to an unconstrained credential.
- V5 refuses to boot on a V1-V4 port, so it can never squat the fallback demo's
  port or leave its own frontend talking to nothing.
- Transcript text is untrusted content everywhere it is rendered or exported.

`tests/transcription-isolation.test.js` asserts all of this behaviourally —
walking real import graphs and driving the real recorder — not by grepping
source for keywords.

Labels on screen are **"Original machine transcript"** and **"Readable
transcript — machine edited"**, never "what the agent understood": the agent
hears audio and never sees that text.

---

## Credit and honesty

The voice model and the speech recognition are **Google Gemini's**. Echo
cancellation and noise suppression are **the browser's WebRTC front end**. We
trained neither, and no Wispr Flow code is present — that product's approach was
read about, not integrated.

Browser microphone and speaker stand in for the phone leg. Describe it as
*"the direct-provider voice core for our phone agent"*, never as a validated
telephone deployment: a real phone call needs a carrier, which no model provider
supplies.

---

## Documentation

- [`AGENTS.md`](AGENTS.md) — working rules for this directory
- [`docs/V5_ORIGIN_AND_FREEZE.md`](docs/V5_ORIGIN_AND_FREEZE.md) — where V5 came from, hash manifest, proof V4 is untouched
- [`docs/V5_DECISION_LOG.md`](docs/V5_DECISION_LOG.md) — why each choice was made, verified provider facts, honest unknowns
- [`docs/V5_TEST_RESULTS.md`](docs/V5_TEST_RESULTS.md) — what was actually run, and what was not
- [`docs/V5_OWNER_TEST_GUIDE.md`](docs/V5_OWNER_TEST_GUIDE.md) — **start here to test it**
- [`docs/V5_TRANSCRIPT_CORPUS.md`](docs/V5_TRANSCRIPT_CORPUS.md) — the 24 clips and the scoring rules
- [`docs/V5_DEMO_SCRIPT.md`](docs/V5_DEMO_SCRIPT.md) — the three-minute story, with the claims you may and may not make
- [`docs/PHYSICAL_TEST_PROTOCOL.md`](docs/PHYSICAL_TEST_PROTOCOL.md), [`docs/GATE_0_FREEZE.md`](docs/GATE_0_FREEZE.md) — inherited from V4; their results are V4's, not V5's
