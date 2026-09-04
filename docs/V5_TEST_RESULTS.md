# V5 test results

## 2026-09-04 update — account readback and noise research

Current suite: **235/235** tests pass; production build succeeds. The earlier sections below preserve historical stage results. The owner has since described V5 as a good demo candidate; that is not a formal acoustic or telephone pass.

- Five new account-reconciliation tests cover from/to facts, a fresh current-plan snapshot, no automatic reversal, replay after another change, and historical versus current price. Confirmation policy and the original voice prompt are unchanged. Spoken clarification has not been retested with Gemini after this edit.
- Four new tests cover the optional provider-native start-sensitivity control and privacy-safe microphone-setting telemetry. Default is Baseline. Less sensitive is explicitly a trial, not denoising or primary-speaker recognition.
- Isolated browser check: synthetic in-memory account login and trial-button selection succeeded. No call was started. The Google Fonts stylesheet was the only observed external browser resource.
- H41 ran 184 cases each through GTCRN and correctly aligned RNNoise. RNNoise improved 30/36 noisy mixtures at 16 kHz and 29/36 after telephone-codec replay, but both candidates failed primary-speaker rejection and neither passed every promotion criterion. Neither is integrated into live capture.
- H41 harness: five tests pass; independent audit verifies source/checkpoint hashes, all 368 valid result rows, denominators and summary noise gates. Initial misaligned RNNoise pilot is explicitly excluded and preserved.

Full findings: [Noise and primary-speaker results](../../research/V5_NOISE_AND_PRIMARY_SPEAKER_RESULTS_2026-09-04.md). No new model training, paid inference, secret copying, account reset or V1–V4 mutation occurred.

## Historical implementation report — 2026-09-03

**Date:** 2026-09-03, India time.
**Build:** `hcr-actionguard-v5@0.5.0`, `@google/genai` 2.20.0, Node v22.19.0.

This file records what was **actually executed** and what the output was. It is
deliberately separate from the design documents, because a plan is not a result.

## The four words this project uses, and what they mean here

| Word | Meaning | Applies to |
|---|---|---|
| **Implemented** | The code exists and runs. | Delivery style, transcript lab, live helper adapter, eval harness |
| **Automatically tested** | A test asserts the behaviour and passes. | 226 tests, listed below |
| **Owner-approved demo candidate** | A person listened and chose it. | **Nothing yet** |
| **Formally validated** | The frozen gate passed on physical calls. | **Nothing.** V4's gates were V4's. |

Nothing in V5 is past "automatically tested".

---

## 1. Automated tests — RUN, PASSING

```
$ npm test
# tests 226
# suites 0
# pass 226
# fail 0
```

| Suite | Tests | What it covers |
|---|---|---|
| `policy.test.js` | inherited | Deterministic policy matrix |
| `heard-state.test.js` | inherited | Heard/unheard split |
| `actions.test.js` | inherited | prepare → confirm → commit, idempotency, supersession |
| `flight-recorder.test.js` | inherited | Timeline, metrics, confirmation evidence |
| `api.test.js` | inherited | HTTP surface, roles, auth |
| **`delivery-style.test.js`** | new | Baseline byte-equality, style isolation, config deep-equality |
| **`transcription-lifecycle.test.js`** | new | Interim vs final, late arrival, generations, queue bounds, timeouts, audio maths |
| **`transcription-api.test.js`** | new | Token constraints, allowlist, rate limit, no credential leak, path guard |
| **`transcription-isolation.test.js`** | new | **No transcript can authorise anything** |
| **`port-guard.test.js`** | new | V5 refuses to start on a V1-V4 port |
| **`playback-mode.test.js`** | new | The tick fix, the scheduling cushion, and the V4-compatible path |
| **`voice-identity.test.js`** | new | Voice catalogue, and that a browser cannot name a model |

The 51 inherited V4 tests were carried over unmodified and all still pass. No
test was deleted, skipped, or had an assertion loosened.

### The single most important test

`transcription-isolation.test.js` →
*"V5 observation events cannot manufacture the playback evidence a commit
needs."*

It floods the flight recorder with every one of the nine `v5_*` event types, all
claiming the same response epoch, all carrying `audibleChunks: 999` and text
saying the customer agreed. It then asserts `heardEvidence()` still reports
`audibleChunks: 0` and `state: null` — and that a genuine `heard_state_transition`
still works. **If that test ever fails, the transcript feature is unsafe and must
be switched off.**

### Eleven real defects found and fixed

These were found by tests written against the implementation, and every one was
fixed in the implementation rather than by weakening the assertion.

| # | Bug | Why it mattered |
|---|---|---|
| 1 | A replayed final transcript was filed twice | The previous final had already closed its segment, so the duplicate check never fired and the sentence appeared twice. |
| 2 | A whitespace-only final became a `finalized` segment | Exactly the "empty success" the build plan forbids — a failed run would have looked like correct silence. |
| 3 | Text arriving after the lane closed joined the current column | A post-close result would have been shown as the newest thing said, and would have extended a transcript already declared finished. |
| 4 | A timed-out segment rendered blank | It kept its partial hypothesis in `interimText`, but the display fell back to the empty final text, so a failed row showed no words at all. |
| 5 | **Upsampling silenced every other sample** | Inherited from V4's resampler, which only ever downsamples a 48 kHz mic. Hand the lab an 8 kHz clip and the box-average window is empty, emitting silence — destroying the audio while looking like it worked. Fixed in the lab's copy only; the voice core's copy is deliberately untouched so the V4 baseline is preserved. |
| 6 | `__proto__` / `constructor` resolved as valid lane ids | `LANE_DEFINITIONS["__proto__"]` returns `Object.prototype`, which is truthy, so a transcript event naming it created a lane whose definition was a built-in. |
| 7 | **V5 silently bound V4's port** | Found by the owner on the first real start, not by a test. `.env` was copied from V4 to bring the API key across; that file contains `PORT=4175`. V5's API bound V4's port while its dev server still proxied `/api` to 4176, so every browser request was refused with no message explaining why — and V5 was squatting on the port V4 needs to start. Fixed by `server/port-guard.js`: V5 now **refuses to boot** on 4174/4175/5173/5174 and prints the `.env` cause. Locked in by `tests/port-guard.test.js`. |
| 8 | **A repetitive tick under the agent's voice** | Reported by the owner. Gemini outputs 24 kHz; the output AudioContext was created with no options so it took the hardware rate (48 kHz, read from the call recorder). The browser therefore resampled **every chunk independently**, restarting its filter at each boundary. Measured chunk length was 196-276 ms, so ~4-5 audible clicks per second. This project's own `research/audio/realtime-audio-pipeline.md` already listed the symptom: "Periodic tick/click every N ms — one-shot resampler called per chunk (no filter state)". Fixed by running the output context at 24 kHz (`src/voice/playback-mode.js`), switchable via `AUDIO_PLAYBACK_MODE`. **Awaiting the owner's listening confirmation.** |
| 9 | **Two concurrent voice sessions were reachable** | `toggleCall` disabled its button only *after* an `await`, and `voice ||= await import(...)` memoised the resolved module rather than the promise, so two callers could both start a session; the voice core's own guard is not armed until `ai.live.connect()` resolves, two network round-trips later. Both sessions would have fed one shared playback cursor, clicking at every boundary between the two streams. Fixed with a synchronous re-entrancy flag, promise memoisation, and the session-identity check on the audio path that the tool path already had. The call reports show one session per call, so this was **not** the cause of defect 8.
| 10 | **Only 20 ms of audio scheduling headroom** | Reported by the owner as the voice "bursting out". Gemini chunks are 196-276 ms; measurement found them arriving 2-75 ms late against V4's 20 ms window, so the scheduler inserted real silence mid-word and the audio resumed abruptly. Fixed with a 140 ms cushion on the first chunk of each reply (`PLAYBACK_LEAD_MS`). Recallability traced, not assumed: every source joins `playingSources` before `start()`, so `clearPlayback()` still stops everything - the cushion costs nothing in barge-in speed (ADR-008). Latency cost reported separately as `scheduleLeadMs`. **Awaiting listening confirmation.** |
| 11 | **My own gap meter counted turn pauses as glitches** | The instrument I added for defect 8 reported 39 "gaps" in a 350 s call, but 24 were over 250 ms and 15 under 100 ms with **nothing in between** - `nextPlaybackTime` holds the end of the *previous* reply, so an eight-second caller turn was logged as an eight-second playback fault. Fixed with a `firstOfResponse` flag. Recorded because a measurement bug that inflates a real defect is its own defect. |

---

## 2. Build — RUN, PASSING

```
$ npm run build
dist/index.html                        0.84 kB
dist/assets/panel-GnpoDsSe.css         5.33 kB
dist/assets/index-C-F2HlXC.css        24.77 kB
dist/assets/panel-CZwPHRSH.js         13.13 kB
dist/assets/gemini-live-DG4lKqTH.js   27.58 kB
dist/assets/index-DqbdDcFn.js         32.46 kB
dist/assets/lab-CBT-bLOl.js           41.30 kB
dist/assets/web-DKU1x01g.js          348.11 kB
✓ built in 1.31s
```

The lab is its own chunk (`lab-*.js`, 41 kB), loaded only when the caller opens
it. "Feature off means no extra work" is therefore literally true, not a claim.

---

## 3. API smoke — RUN, PASSING

Against a real Express app on an in-memory database:

| Check | Result |
|---|---|
| `GET /api/health` | `ok: true`, plus a `v5` block, `configurationErrors: []` |
| `GET /api/v5/features` unauthenticated | **401** |
| `GET /api/v5/features` as caller | 200 · style `baseline` · helper `false` · lab `true` · real calls `false` |
| Features payload contains a credential | **No** (recursively checked) |
| `POST /api/v5/transcription/token` unauthenticated | **401** |
| …as employee | **403** |
| …as caller, feature off | **503** `feature_disabled`, blockers `real_provider_calls_disabled, no_gemini_api_key`, **and no provider call attempted** |
| …asking for the voice model | **400** `field: "model"` |
| …smuggling `systemInstruction` | **400** `field: "systemInstruction"` |
| `GET /api/customer/dashboard` | 200 · Premium · ₹18 disputed |
| `GET /api/employee/dashboard` | 200 · **money issued: 0** |

---

## 4. Isolation from V1–V4 — RUN, PASSING

```
$ node scripts/gate-report.js --db ".../Prodapt IPL project V4/data/actionguard.db"
Error: Refusing to open a database outside this V5 project.
```

```
$ node scripts/transcription-eval.js --dir "../Prodapt IPL project V4/data"
Refusing to use a clip directory outside this V5 project.
$ node scripts/transcription-eval.js --out "../Prodapt IPL project V4/pwned.json"
Refusing to use a report path outside this V5 project.
```

**V4 verified unchanged after the whole build:** all 30 source files re-hashed
and byte-identical to the copy-time manifest in `V5_ORIGIN_AND_FREEZE.md`. V4's
`data/` timestamps are still 2026-09-02, i.e. before this work began.

*Observation, not a change we made:* V4's dev server was listening on 5174/4175
at the start of this session and is not listening now. No process was stopped by
this build. V4's files are intact, so `npm run dev` in that directory restores
it.

---

## 5. Evaluation harness — RUN (dry run only)

```
$ node scripts/transcription-eval.js --help          -> usage printed, exit 0
$ node scripts/transcription-eval.js                 -> dry run; no clips yet; exit 1
$ node scripts/transcription-eval.js --live          -> refused both env opt-ins;
                                                        continued as a DRY RUN
```

The `--live` refusal is the important one. Even with the flag given, it printed:

```
  --live was requested but refused. Both environment opt-ins must also be set:
    TRANSCRIPT_LAB_LIVE_CALLS=true is not set.
    GEMINI_API_KEY is not set.
  Continuing as a dry run. Nothing will be sent.
```

Verified with synthetic WAV files during development that the harness decodes
44.1 kHz stereo and 16 kHz mono PCM WAV, normalises both to the documented
16 kHz mono contract, produces stable clip hashes, refuses float32 WAV by name,
and refuses an over-30-second clip. Those synthetic files were deleted
afterwards; they were tones, not speech, and would not have been valid evidence
about recognition.

---

## 6. NOT tested — the honest list

### Provider contact so far

**Updated 2026-09-03, after the owner's first real start.** One real Google
request has now succeeded: `POST /api/voice/client-token` issued a live voice
credential with the owner's key (`model: gemini-3.1-flash-live-preview`).

That proves exactly two things and no more:

- the key in V5's `.env` is valid, and
- the `POST /v1beta/auth_tokens` route works from this machine.

It used V4's **inherited, unconstrained** token helper, not V5's new
transcription endpoint. So the following remain **UNVERIFIED**:

| Claim | Status |
|---|---|
| `gemini-3.5-transcribe-live` is reachable on this project's credential | **Unverified.** The key works for the *voice* model; that does not prove the *transcription* model is enabled for this project. |
| The provider honours `liveConnectConstraints` | **Unverified.** The field is documented and typed in the installed SDK, and we send it, but nothing here has observed the lock rejecting a mismatched model. Reported in the API response as `constraintEnforcementVerified: false`. |
| Real event shapes match `interimInputTranscription` / `inputTranscription` | **Unverified against a live socket.** Our parser follows the documentation and the installed SDK's `LiveServerContent` interface. Test fixtures are documentation-shaped, and are labelled as such. |
| Real end-to-final latency | **Unmeasured.** The 1,500 ms p95 target is our proposal. |
| Whether SMART mode helps on Indian English or Hinglish | **Unmeasured.** A supported-language list is not a demonstration. |
| Free-tier vs paid-tier data handling for this account | **Unknown to us.** Google's page says free tier is used to improve their products; which tier this key is on is the owner's to confirm. |

### Never heard by a person

| Claim | Status |
|---|---|
| The natural style sounds better | **Nobody has heard it.** Requires the 8 paired situations. |
| The natural style does not slow responses | **Unmeasured.** Needs a fresh V5 baseline versus candidate. |
| The live helper does not disturb a call | **Unmeasured.** Needs 3 matched call pairs. |
| Interruption behaviour is unchanged in V5 | **Unmeasured.** The code path is untouched, but that is an argument, not a measurement. |
| The billing-review flow works end to end in V5 | **Untested physically.** Code tests pass; no call has been made. |

### Deliberately not built

Random breaths, fillers, a progress cue, a separate cleanup LLM, a local STT
model, an emotion classifier, and any AEC/VAD/turn-detector change. All deferred
by the build plan. No placeholder switch implies otherwise.

---

## 7. Feature status table — keep this honest

| Feature | Implemented | Auto-tested | Owner-approved | Formally validated |
|---|---|---|---|---|
| V5 isolation from V1–V4 | ✅ | ✅ | — | n/a |
| Baseline reproducibility (byte-identical prompt) | ✅ | ✅ | — | n/a |
| Natural delivery style | ✅ | ✅ | ❌ **not heard** | ❌ |
| Transcript lab (dry run) | ✅ | ✅ | ❌ | ❌ |
| Transcript lab (real calls) | ✅ | ✅ (mocked) | ❌ | ❌ **transcription model never contacted** |
| Constrained token endpoint | ✅ | ✅ | — | ❌ **enforcement unobserved** |
| Live transcript helper | ✅ | ✅ | ❌ | ❌ **deliberately disabled** |
| Evaluation harness | ✅ | dry run only | ❌ | ❌ |
| Inherited V4 call behaviour | carried over | ✅ 51 tests | V4's own status | V4's own status |

---

## 8. What to run next

1. **Owner listening screen** — `V5_OWNER_TEST_GUIDE.md` §2. Eight paired
   situations, baseline versus natural.
2. **Record the 24 clips** — `V5_TRANSCRIPT_CORPUS.md`. Then the dry run, then
   a decision about whether to make real calls.
3. **Only if 2 passes** — enable `SMART_TRANSCRIPT_ENABLED` for the live helper
   trial. Not before.
