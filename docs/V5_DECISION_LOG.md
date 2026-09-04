# V5 decision log

## 2026-09-04 — preserve confirmation; improve account readback; screen noise separately

The owner explicitly asked not to redesign confirmation. `server/policy.js` remains byte-identical, and the voice prompt is unchanged. Completed-action responses now include server-derived from/to facts and a fresh current-plan snapshot with clarification guidance. These are read-back data, not new authority. A replay distinguishes its historical result from today's account. The new sequence field counts verified plan changes; it is not a universal version for every possible account update.

Added a removable, default-off provider-native start-sensitivity trial and actual browser-setting telemetry. Only `startOfSpeechSensitivity` changes; endpoint timing and interruption clearing remain unchanged. The UI discloses quiet-caller risk and absence of speaker identification. This is a documented trial, not promoted performance.

Two pretrained filters were evaluated outside the app on public audio. RNNoise is promising for ordinary noise, but no custom filter met all gates or rejected background-only speakers. Neither is shipped in the audio path. The reviewed speaker-extraction candidates do not yet justify a new training/integration claim; REAL-T evaluation audio cannot be used to train. See [full results and next steps](../../research/V5_NOISE_AND_PRIMARY_SPEAKER_RESULTS_2026-09-04.md).

The new public-audio work is explicitly authorized by the owner's latest request and supersedes the old V5 plan's acoustic-research deferral only for this named failure. V1–V4 remain frozen. No cloud training or new provider is authorized by this change.

## Historical decisions — 2026-09-03

**Date:** 2026-09-03, India time.
**Plan:** [`../../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md`](../../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md)

Why each V5 choice was made, what was actually verified, and what remains
unknown. Feature *status* lives in [`V5_TEST_RESULTS.md`](V5_TEST_RESULTS.md);
this file is about the reasoning.

---

## 1. Provider compatibility — what we checked and what we found

Everything below was read from Google's own documentation on **2026-09-03** and
cross-checked against the **actually installed** `@google/genai` **2.20.0** type
definitions and bundled runtime. Where the two disagreed, the installed SDK won,
because that is the code that will run.

### 1.1 The dedicated transcription model exists

| Question | Answer | Evidence |
|---|---|---|
| Does `gemini-3.5-transcribe-live` exist? | **Yes, and it is GA** (released 2026-08-26), not preview. | [models](https://ai.google.dev/gemini-api/docs/models), [live-transcribe](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), changelog |
| Modalities | Audio in, **text out**. | models page |
| Is it the same model as the voice core? | **No.** The voice core is `gemini-3.1-flash-live-preview`. These are two different models on two different connections. | capabilities page |

This matters for how the feature is described. The voice model hears audio
directly; its on-screen transcript is a by-product, not an input. The dedicated
recogniser is a **second, independent listener**. Two independent listeners can
write down different words — that is not one of them "editing" the other, and
the interface must not imply that it is.

### 1.2 Configuration shape — confirmed in the installed SDK

Documented config, and every field is present in the installed
`AudioTranscriptionConfig` interface:

```js
{
  responseModalities: ["TEXT"],
  inputAudioTranscription: {
    languageCodes: [],                 // [] = provider auto-detects
    customVocabulary: ["Prodapt", ...] // up to 1,000 terms; ~100 works best
    mode: "SMART",                     // or "VERBATIM" (the default)
  },
}
```

`AudioTranscriptionConfigMode.VERBATIM` / `.SMART` are a **runtime enum** in the
installed bundle, not merely a type. The SDK passes `inputAudioTranscription`
through to `setup.inputAudioTranscription` unmodified, so `mode` and
`languageCodes` reach the server exactly as written.

**Decision:** SMART mode is the readable lane. We did **not** add a text-cleanup
LLM. The plan forbids it, F51 measured what an extra semantic call costs, and
the provider already does this cleanup inside the same request.

### 1.3 The finality trap

**There is no `isFinal`, `finished` or `turnComplete` flag on the live
transcription path.** Finality is signalled by *which field arrives*:

| Field | Meaning |
|---|---|
| `serverContent.interimInputTranscription.text` | speculative partial, may still change |
| `serverContent.inputTranscription.text` | finalised segment, authoritative for that piece of speech |

This is a real difference from the voice path, where `turnComplete` does exist.
V4's transcript handling branches on `input.finished !== false` — that idiom
would **silently never finalise** on this model.

**Decision:** `readTranscriptionEvents()` in
[`src/transcription/gemini-transcriber.js`](../src/transcription/gemini-transcriber.js)
branches on field presence only, and returns **both** events when one message
carries both. Gemini 3.1 is documented as able to put several parts in one
event, so handling only the first match would drop text.

### 1.4 Audio contract

Raw 16-bit PCM, **16 kHz, mono, little-endian**, MIME `audio/pcm;rate=16000`,
sent in ~100 ms chunks (1,024–2,048 frames).

**Decision:** this is exactly what the voice core already produces for its own
send. So the sidecar tap hands the helper *the same bytes that were just sent*,
after they were sent. No second resample, no format conversion, and no work at
all inside the audio callback beyond one copy and one array push. If the two
lanes were resampled differently, part of any measured word-accuracy difference
would be our own arithmetic rather than the recogniser.

### 1.5 Session limits are NOT the same for the two models

| | Live transcription | Live voice |
|---|---|---|
| Session cap | **10 minutes** | 15 minutes audio-only |
| Documented extension | **none** | context-window compression, session resumption |

The transcription page states 10 minutes as a limitation and mentions neither
`sessionResumption` nor `contextWindowCompression`.

**Decision:** we do not assume a transcription session can be extended. Our own
ceiling is **420 s**, below the provider's, so we degrade on our terms rather
than being cut mid-segment. `TRANSCRIPTION_LIMITS.providerSessionSeconds`
records the provider figure separately from our own so the two are never
confused.

### 1.6 Ephemeral tokens can be locked to a model AND a config

Documented and present in the installed SDK's `CreateAuthTokenConfig`:

```ts
liveConnectConstraints?: { model?: string; config?: LiveConnectConfig }
lockAdditionalFields?: string[]
uses?: number
expireTime?: string
newSessionExpireTime?: string
```

Two SDK gotchas found by inspection, both of which would have bitten us:

- The property is **`ai.authTokens`**, not `ai.tokens`. The SDK's own JSDoc
  examples say `ai.tokens.create(...)` in all four samples and are **stale**;
  there is no `tokens` getter in 2.20.0.
- `create()` takes `{ config: {...} }`, wrapped. And the constraints field is
  `liveConnectConstraints`, not the `LiveEphemeralParameters` the JSDoc invents.

**Decision:** V5's transcription token endpoint issues a **model-and-config
locked** credential over the same REST route V4 already proves works
(`POST /v1beta/auth_tokens`), with `liveConnectConstraints` added.

**Why not reuse V4's helper?** Because
[`server/agent/gemini-live.js`](../server/agent/gemini-live.js) asks for
`{uses, expireTime, newSessionExpireTime}` and nothing else. That token is
**unconstrained**: whoever holds it can open a Live session against any model
with any configuration, including a conversational model with tools. That was
tolerable for the voice session the same authenticated caller was about to open
anyway. It is not a pattern to copy onto a second, wider surface. The plan says
so explicitly, and inspection confirmed it.

**Two independent guards**, because a provider-side constraint we have not
observed being enforced is not something to rely on alone:

1. The **server** picks the model, mode, language hints and vocabulary from its
   own allowlist. Nothing a client sends is forwarded. Unknown fields are a
   rejection, not a merge.
2. `liveConnectConstraints` locks the issued credential to that same choice.

Guard 1 is fully covered by local tests. Guard 2 is reported honestly:
`constraintEnforcementVerified: false` travels in the response, because no real
provider call has yet observed the lock being applied.

If the provider ever rejects the constrained request with an unknown-field
error, the endpoint fails with `code: "constraint_unsupported"` (501) and
**does not retry without the constraint**. Falling back would silently hand out
a wide credential, which is worse than the feature being unavailable.

### 1.7 What the voice model does NOT support

`enableAffectiveDialog`, `proactivity.proactiveAudio` and non-blocking
(`behavior: NON_BLOCKING`) function calling are documented as **2.5-only** and
explicitly "Not supported" on `gemini-3.1-flash-live-preview`.

**Decision:** none of them appear in `liveConfig()`. Sending them would be a
silent no-op at best. This is why the natural style is done as a **prompt
section** and is correctly described as *provider-native speaking-style
conditioning*, not as an emotion or affect system.

### 1.8 Free tier data use — needs the owner's decision

Google's pricing page marks the free tier for these live models
**"Used to improve our products: Yes"**, and the paid tier **"No"**.

**Decision:** V5 does not enable billing, create an account, or make any real
provider call by default. `TRANSCRIPT_LAB_LIVE_CALLS=false` ships as the
default, and the warning text is surfaced in the UI and in
`/api/v5/features`. Only synthetic or explicitly consented demo speech may be
used. This is the owner's call, not ours.

### 1.9 Version pinning

Installed `@google/genai` is **2.20.0**; the registry's latest is **2.21.0**
(published 2026-09-02). V5 stays on 2.20.0 deliberately: the research was done
against it, and it already contains every field this build needs. Moving the pin
means re-running the baseline before attributing any behaviour change to a V5
feature.

---

## 2. Delivery style — why it is one appended section

**The problem with comparing two speaking styles** is that almost any change
also changes something else. So the baseline is produced by calling V4's
untouched `systemInstruction(customer)`, and the natural style is *that exact
string* plus `"\n\n" + NATURAL_DELIVERY_SECTION`.

That makes byte-equality of the baseline a **testable assertion** rather than a
promise. `prompt.js` is never edited.

Also identical across both styles: voice (`Kore`), model, `responseModalities`,
tool declarations, `prefixPaddingMs` (120), `silenceDurationMs` (500),
`activityHandling`. Only `systemInstruction` differs, and the test suite asserts
deep equality of everything else.

The section states principles, not scripts: no exact word, phrase, keyword list
or regex, and no canned reply. It also closes with an explicit ceiling —
delivery may never change a fact, make an uncertain thing sound certain, widen
what the agent may do, or imply an outcome a tool has not returned.

**Locked at connect time.** Changing style mid-call would make a paired
comparison meaningless, so the selector disables itself while connected and the
session's style is captured in the call report with a prompt fingerprint.

**Not done:** no emotion inference call, no voice change, no silence-threshold
tweak, no breaths, no filler. All are deferred by the plan.

---

## 3. Transcript lanes — three columns, no authority

| Lane | Where its text comes from | Label on screen |
|---|---|---|
| `voice-core-raw` | the voice model's own `inputTranscription` | Original machine transcript |
| `dedicated-verbatim` | dedicated recogniser, `mode: VERBATIM` | Original machine transcript |
| `dedicated-smart` | dedicated recogniser, `mode: SMART` | **Readable transcript — machine edited** |

Never "what the agent understood". The agent hears audio; it never sees this
text.

**There is no function anywhere that derives one lane from another.** Lanes are
append-only and independent. An "original" transcript reconstructed backwards
out of SMART text would be a fabrication, so the code has no path to produce
one.

### 3.1 Late results are filed where they belong

The hard case: the caller interrupts, and the recogniser finishes that earlier
sentence *afterwards*. Attaching it to "the latest turn" would put words in the
caller's mouth.

[`transcript-store.js`](../src/transcription/transcript-store.js) keys every
segment on `(lane, connection generation, sequence)`. A late event is filed
under **its own** generation, flagged `lateArrival`, listed in
`snapshot().lateEvents`, and kept out of `laneView().current`. A reconnect always
opens a **new generation** with `precededByGap: true`, so two halves of a
sentence either side of a gap are never shown as continuous speech.

### 3.2 Alignment is deliberately conservative

- **In the lab:** lanes are aligned on the **SHA-256 of the exact normalised
  samples**. Every lane replays byte-identical audio, so "same input" is a
  checkable fact. `canPairSegments()` returns true and a per-segment diff is
  allowed — captioned as an inspection aid, not as evidence either lane is
  right.
- **Live:** `independent-streams-approximate-by-receipt-time`, and
  `canPairSegments()` returns **false**. Two independently scrolling columns,
  never a falsely paired per-turn diff. No matching by latest turn, array
  position, nearest event or text similarity.

### 3.3 Failure is visible, not absent

States: `pending`, `provisional`, `finalized`, `unavailable`, `timed_out`,
`cancelled`, `manually_reviewed`. A lane that produced nothing still gets a
visible terminal row, so a failed run **stays in the denominator** instead of
quietly improving the average.

There is no confidence percentage anywhere. We have no calibrated measure, so
inventing one would be a fabrication.

---

## 4. The sidecar boundary

| Requirement | How it is met |
|---|---|
| Never await the sidecar in a hot callback | `pushAudio()` is synchronous: one `slice()` and one `push()`. No await, no allocation loop, no network. |
| A helper error must not end the call | The tap is wrapped in `try/catch`; after 3 failures the helper is detached and the call continues. |
| Resampling/buffering outside the hot path | The helper receives already-encoded 16 kHz PCM16. Chunk aggregation and sending happen in its own drain loop. |
| Bounded queue | `maxQueuedChunks: 200`. On overflow the helper **stops and reports degraded** — it does not drop chunks and then present gappy text as complete. |
| Stop on every teardown | `disconnectVoiceAgent()` stops the helper **first**; logout and `beforeunload` tear down the lab. |
| Ignore late messages after reconnect | Messages are checked against the current session object **and** generation; mismatches are counted as `stale_message_ignored` and discarded. |
| One extra connection maximum, live | Live mode uses one dedicated SMART connection beside the voice core's own raw transcript. VERBATIM comparison belongs in the lab, not a third always-on socket. |
| No sidecar result reaches business state | The store imports nothing. It has no session, no tool executor, no heard-state tracker and no API client. |

### 4.1 The confirmation guard cannot be influenced

The commit guard reads `heard_state_transition` and `response_audio_started`
from the flight recorder. The nine new `v5_*` event types are listed in
`V5_OBSERVATION_ONLY_EVENTS` and are in neither set, so no volume of transcript
telemetry can manufacture the playback evidence that lets a commit through.
`tests/transcription-isolation.test.js` asserts this directly.

---

## 5. Choices we made that the plan left open

| Decision | Choice | Reasoning |
|---|---|---|
| Fingerprint algorithm | FNV-1a 64 + length, labelled `fnv1a64-identity-check-not-a-security-hash` | Synchronous, identical in browser and Node, zero dependencies. It answers "was the same text sent twice", which is all the report needs. Calling it a security hash would be a false claim. |
| Clip hash | SHA-256 via `crypto.subtle` | This one **is** load-bearing: it is the same-input guarantee for the whole comparison. |
| Product vocabulary | 10 terms: brand, 4 plan names, 5 domain nouns | Recognition bias only. Contains **no** confirmation word, negation word, amount or account field — putting those there would be the keyword branching the scope guard forbids. |
| Default lab mode | dry run | The lab plans the run and shows exactly what it would send, contacting nothing. Two independent opt-ins are needed for a real call. |
| Default transcription mode when unspecified | `SMART` | It is the lane the feature exists to evaluate. `VERBATIM` is still explicitly requestable. |
| Where V5 CSS lives | new `src/v5.css` | The inherited stylesheets stay byte-identical, so a reviewer can see exactly what V5 added. |
| Lab code loading | dynamic `import()` on first open | Makes "feature off means no extra work" literally true rather than a claim. |
| V5 report block | its own `v5_experiment` object | Structurally separate from the gate metrics, so experiment numbers can never be mistaken for gate results. |

---

## 6. Honest unknowns

Recorded here rather than guessed:

1. **Whether the provider actually enforces `liveConnectConstraints`.** The
   field is documented and typed, but no real call in this build has observed
   the lock rejecting a mismatched model. Reported as
   `constraintEnforcementVerified: false`.
2. **Whether `gemini-3.5-transcribe-live` is reachable on this credential.** The
   model is GA, but GA does not prove this project or key can call it. Untested.
3. **Real end-to-final latency.** Unmeasured. The 1,500 ms p95 target in the
   plan is *our proposal*, not a provider guarantee.
4. **Whether SMART mode helps on Indian-English or Hindi-English speech.** A
   documented language list is not a demonstration.
5. **Concurrent session limits.** Not published on any page fetched; the
   rate-limits page defers to per-account limits in AI Studio.
6. **Whether the sidecar measurably slows the live call.** Designed not to, and
   the design is testable, but the *physical* answer needs matched call pairs.
7. **Whether the natural style sounds better.** Nobody has heard it yet.
8. **Whether `sessionResumption` works on the transcription model.** Not
   mentioned in its documentation. Assumed unavailable.

---

## 7. Open-source references — borrowed design, no imported code

`OpenWhispr` and `jgvilchezc/flow` were read for design patterns only
(transcript-as-data, cancellation, keeping formatting responsibility separate
from intent). **No code was copied from either project**, so no licence notice
is required. Their literal replacement and snippet rules were specifically NOT
imported: those are exactly the exact-phrase intent logic the scope guard
forbids.

Moonshine, VoxCPM2, Dia/Dia2, PersonaPlex and F-Actor remain research
references. Nothing was downloaded, and no local model runs in V5.
