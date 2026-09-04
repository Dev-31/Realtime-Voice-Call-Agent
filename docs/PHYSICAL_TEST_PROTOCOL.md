# Physical test protocol — Gates 1, 2, 3, 5

Everything in this file needs a **real person, a real microphone and headphones**.
Code tests cannot pass these gates. Nothing here may be reported as passed from
reasoning alone.

## Before every session

1. Headphones on. The judged baseline is headphones. Open-speaker echo handling
   is **not** validated and must not be claimed.
2. Start the stack:
   ```
   cd "Prodapt IPL project V4"
   npm run dev
   ```
   API on `http://127.0.0.1:4175`, app on `http://127.0.0.1:5174`.
3. Sign in as the caller: `CUST-1002 / 1002` (Akash, Premium, ₹18 disputed
   charge).
4. Keep a second browser profile signed in as the billing team
   (`employee@prodapt.demo / TwinForge#2026`) to read the Call Flight Recorder.
5. **Inspect the newest report after every physical test, before changing any
   code.** This is the rule that stopped V2 and V3 from drifting.

The fixed sentences below are repeatable test inputs only. The shipped
behaviour must not branch on them, and the same test is invalid if the code
starts recognising the wording rather than the meaning.

---

## Gate 1 — interruption mechanics

**20 turns across one or more calls: 5 takeovers, 10 acknowledgements, 5 slow-pause sentences.**

### 1a. Genuine takeover (run 5)

While the assistant is mid-sentence, cut in with a real request, for example:
"Wait — I do not want money issued."

Pass, per attempt:
- The audio stops. You should not hear a trailing word after you begin.
- The report shows a `response_interrupted` row for that turn.
- The assistant does not reintroduce itself in its next reply.

### 1b. Acknowledgement (run 10)

While the assistant is mid-explanation, say a short listening signal — "mm-hm",
"right", "okay" — and then stay quiet.

Pass, per attempt: the assistant carries on from where it stopped rather than
restarting, re-greeting, or asking a fresh question. In the report this shows as
`preserved_or_resumed` under **What happened after each interruption**.

Note honestly: Gemini's automatic VAD treats any sound as activity, so the
provider *will* stop generating. The gate is about what happens next, not about
whether the stop occurred.

### 1c. Slow-pause sentence (run 5)

Speak a sentence with a deliberate 700–900 ms pause in the middle, for example:
"I want to ask about … the eighteen rupee charge."

Pass, per attempt: the assistant does not answer during the pause.

### Gate 1 verdict

| Criterion | Target |
|---|---|
| Takeovers that stopped playback | 5 / 5 |
| Audible-stop p95 | ≤ 500 ms |
| Acknowledgements preserved or resumed | ≥ 9 / 10 |
| Repeated introductions | 0 |
| Premature answers in the slow-pause cases | 0 |

Read the first two straight off the call's gate scorecard. Score the third and
fourth **by listening**, then compare against the recorder's estimate. If the
listening result and the estimate disagree, the listening result wins and the
disagreement gets written down.

**If Gate 1 fails, stop and diagnose that cell. Do not add tools, emotion,
diarization or filler layers on top of a failing Gate 1.**

---

## Gate 2 — HCR conversation integrity

Run these three on top of a Gate 1 pass.

1. **Correction replaces the stale draft.** Let the assistant start explaining a
   refund, cut in with a correction, and check that its next reply acts on the
   correction and does not finish the old sentence as though you had heard it.
2. **Resume happens once.** Acknowledge mid-explanation, then ask it to carry
   on. It should resume from the next unfinished point exactly once, not restart
   and not repeat.
3. **No false delivery claims.** Interrupt early, then ask about something in
   the part that never played. It must not say it already told you.

In the report, each of these should show:
- an `unheard_content_quarantined` row with the exact unheard words, and
- a `resume_context_injected` row immediately after it.

If `resume_context_failed` appears instead, the heard-state note never reached
the model, and any preservation result from that turn is void.

---

## Gate 3 — exactly-once billing review

The judged call, run start to finish:

1. Ask about the disputed charge. The assistant reads the account.
2. It begins explaining the billing-review process.
3. Interrupt: "Wait — I do not want money issued. Please send only the ₹18
   charge to Billing for review."
4. It stops, does not reintroduce itself, and reflects the correction.
5. It reads back the prepared request and asks for confirmation.
6. Confirm.
7. Exactly one `pending_human_review` request exists. Zero money is issued.

Then run the four adverse cases, each on a fresh call:

| Case | How to run it | Required outcome |
|---|---|---|
| Negation | Ask, then when it asks for confirmation, say no. | Zero rows written. |
| No confirmation | Ask, then end the call. | Zero rows written. |
| Replay | After a successful commit, ask it to do the same thing again. | The same reference is reused. No second row. |
| Unrelated media | Play a recording of someone discussing a refund near the mic. | Zero rows written. |

The last one is the weakest of the four: the project has **no validated
solution** for proving the primary caller when another voice reaches the same
microphone. Record what happened; do not claim it as solved.

Check the database directly after each case:

```
node -e "const{openDatabase}=await import('./server/db.js');const db=openDatabase('./data/actionguard.db');console.log(db.prepare('SELECT reference,status,amount FROM service_requests').all(),db.prepare('SELECT id,status FROM action_intents').all())" --input-type=module
```

---

## Gate 5 — frozen final run

20 fresh calls: 5 normal, 5 backchannel, 5 correction/takeover, 5 safety/adverse.
Change nothing between them.

```
npm run gate:report
```

Final pass requires every line to read PASS across all 20 calls:

- Response latency p95 ≤ 2,500 ms
- Audible stop p95 ≤ 500 ms
- Interrupted explanation preserved or resumed ≥ 9 in 10
- Zero repeated introductions
- Zero wrong or duplicate business actions
- Zero money issued
- Report and database match after every call

The preservation and reintroduction lines are text-overlap estimates. Confirm
both by listening before writing the result anywhere.

---

## What must never be claimed from these runs

Passing every gate above still does not validate:

- PSTN or SIP calling of any kind
- Open-speaker echo cancellation
- Primary-speaker identity when a second person speaks into the same microphone
- Emotion recognition or diarization
- Production readiness

The accurate sentence is: *"This is the direct-provider voice core for our phone
agent. The demo proves interruption-safe conversation and exactly-once BPO
actioning in the browser path."*
