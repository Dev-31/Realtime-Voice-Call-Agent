# V5 demo script — about three minutes

**Date:** 2026-09-03.
**Status:** a script to rehearse, not a record of a rehearsal. Nothing here has
been performed yet.

Read `V5_TEST_RESULTS.md` before presenting any of this. Every claim below is
written so it stays true even if the natural style is never promoted.

---

## The one-sentence version

> Most voice demos prove an AI can talk. This one proves you can cut it off
> mid-sentence during real customer-service work, change your mind, and it still
> gets the business action right — exactly once, with no money moved.

---

## Before you walk in

- [ ] `npm run dev` in `Prodapt IPL project V5`. App on **5175**.
- [ ] Signed in as **CUST-1002 / 1002** (Akash, Premium, ₹18 disputed).
- [ ] Second window signed in as the billing team, on the Call Flight Recorder.
- [ ] **V5's demo data reset** so the review you create is genuinely new:
      stop the server, delete `data/actionguard-v5.db*`, restart.
      *Showing a review that already existed is not a demonstration.*
- [ ] **Headphones on.** Not optional — open-speaker behaviour is not validated.
- [ ] Delivery style set to whichever the listening screen chose. If that screen
      has not been run, **use Baseline** and say so if asked.
- [ ] Transcript lab closed. Open it only for the part where you want it.

---

## Act 1 · The interruption (about 60 seconds)

**You:** "Hi, there's an eighteen rupee charge on my bill I don't recognise."

The agent looks up the real account and starts explaining the billing-review
process.

**While it is still talking, cut in:**

> "Wait — I do not want money issued. Please send only the eighteen rupee charge
> to Billing for review."

**Say to the room:** *"Notice three things. It stopped as soon as I started
talking. It didn't start over or re-introduce itself. And it took the
correction, not the sentence it was halfway through."*

---

## Act 2 · Two turns, one action (about 60 seconds)

The agent reads the request back and asks you to confirm.

**Say to the room, before you answer:** *"Nothing has happened yet. Asking is
not doing. The server has prepared a request and is waiting for a separate
confirming turn — the turn that asked can never be the turn that confirms."*

**Then confirm.**

**Switch to the billing-team window.** Show:

- exactly **one** pending human review, with its reference;
- **₹0 money issued** — the agent has no money-movement authority at all;
- the call's gate scorecard: response times, interruption stop times, and
  "report matches the database".

**Say:** *"A refund can only ever become a request for a human to review. That
isn't the model being careful. It's a server rule the model cannot reach."*

---

## Act 3 · The two transcripts (about 45 seconds)

Open the **transcript lab** on the caller page and play a short recorded clip of
disfluent speech.

Show the two columns:

- **Original machine transcript** — every "um" and false start.
- **Readable transcript — machine edited** — the provider's own tidy-up.

**Say, and do not soften this:**

> *"Two recognisers can hear different words. This shows where two machines
> disagreed — it does not show which one is right. And neither column can
> authorise anything: the transcript view cannot reach a tool, a confirmation,
> or the ledger. We test that specifically."*

If real provider calls are switched off, press **Plan the run** instead and say:
*"It's showing exactly what it would send, without contacting anything. That's
the default."*

---

## Act 4 · What happens when it breaks (about 15 seconds)

Turn the transcript helper off mid-demo, or just point at the panel.

**Say:** *"The transcript helper is a sidecar. If it fails, times out, or is
switched off, the call keeps going. It runs on its own connection, its own
queue, and it can never block the microphone path."*

---

## Closing line

> "It's built on Google's Gemini Live model and the browser's own audio
> processing — we didn't train either. What we built is the part that decides
> what's safe to do: stop fast, know exactly which words actually reached the
> caller, and act exactly once. It's designed for a phone line; today it runs on
> browser audio because a phone number needs a carrier, not a model."

---

## Claims you may make

- ✅ Direct Gemini Live. One provider, no orchestration layer.
- ✅ Interruption clears queued audio immediately, and the model is told which
     words actually reached the caller.
- ✅ Prepare and commit are separate turns; a replayed call reuses the same
     reference instead of acting twice.
- ✅ Refunds are human-review only. The agent has no money authority.
- ✅ The transcript view is display-only and provably cannot authorise an action.
- ✅ V1–V4 are frozen and unchanged; V5 runs on its own ports and database.
- ✅ 186 automated tests pass, including a suite whose whole job is proving the
     transcript feature has no authority.

## Claims you may NOT make

- ❌ "This is a phone call." It is browser audio standing in for the phone leg.
  Say *"the direct-provider voice core for our phone agent"*.
- ❌ "Our speech recognition is better." We call Google's. Cleaner text is not
  more accurate text.
- ❌ "The agent understands you better because of the transcript." The agent
  hears audio. It never sees that text.
- ❌ "The natural voice is better" — **unless the listening screen has actually
  been run and it won.** Until then it is *implemented, not approved*.
- ❌ Any accuracy or confidence percentage. We have not measured one, and there
  is no calibrated confidence figure to quote.
- ❌ "Validated" or "production ready". The 20-call gate has not been run on V5.
- ❌ "It handles noisy rooms / Hinglish / overlapping speakers." Unmeasured, and
  speaker identity is explicitly unsolved in this project.

---

## If it goes wrong on stage

| Problem | What to do | What to say |
|---|---|---|
| Voice will not connect | Check `GEMINI_API_KEY` in V5's `.env` | "Credential issue — one moment." |
| The agent talks over you | Check headphones are actually on | Move on; note it afterwards. |
| It commits the wrong thing | **Stop the demo.** Show the recorder. | "That's a real failure and it's exactly why every action is replayable." Honesty beats recovery. |
| The transcript lab errors | Close it. Continue. | "The sidecar failed and the call carried on — that's the design." |
| Everything is broken | `cd "../Prodapt IPL project V4" && npm run dev` (port 5174) | V4 is untouched and needs no restore. Acts 1 and 2 work there. |

---

## Rehearsal checklist

Run these five before demo day, and record the actual before/after state:

1. Ask about the plans; listen to the delivery.
2. Acknowledge while it explains; check it continues without re-introducing.
3. Interrupt and change your mind; check **no plan change happened**.
4. Ask for a billing review, confirm in a later turn; check **one** pending
   review and **zero** money issued.
5. Replay a disfluent clip in the lab, then disable the helper and confirm the
   normal call still works.

An awkward phrasing or one slow response is a documented limitation, not a
reason to scrap the demo. A wrong action, an ignored withdrawal, an invented
amount, an exposed secret, or a transcript driving an action are hard blockers —
fix those before presenting.
