# V5 owner test guide

## Latest change — 2026-09-04

You do not need to create a lab dataset. Public-recording comparisons have now been run; see [the results](../../research/V5_NOISE_AND_PRIMARY_SPEAKER_RESULTS_2026-09-04.md). The original instructions below are historical, not a new request to repeat the whole test session.

- Your confirmation flow stays the same. The tool now supplies the previous/new plan and current account state so the agent can explain a completed change and clarify what you want next. This has passed code tests, not a new spoken-call test.
- The V5 experiment panel now has **Noise-triggered stops**. **Baseline** preserves current listening; **Less sensitive · trial** uses Gemini's native lower start sensitivity. Choose it before a call if you want to try it during normal use. It may miss a quiet interruption, so Baseline is always available.
- This is not a trained speaker-recognition feature. Neither experimental denoiser is enabled in the call. No noise performance claim follows merely from selecting the trial.
- The report now captures the browser's reported microphone-processing settings, without device identifiers. No new audio recording is enabled.

## Earlier natural-style/transcript guide

**Date:** 2026-09-03.
**Who this is for:** you, with headphones and about 30 minutes.

Everything below needs a real person, a real microphone and headphones. Code
tests cannot pass any of it, and nothing here has been done yet.

---

## 0. Before you start (5 minutes, once)

### Give V5 its own key

V5 does **not** share V4's `.env`. Create its own:

```bash
cd "E:/Voice Agent 1/Prodapt IPL project V5"
cp .env.example .env
```

Then open `.env` and put your real Gemini key in `GEMINI_API_KEY=`. Everything
else can stay as it is — the defaults are the safe ones.

> **Copy the key *value* only — do not copy V4's whole `.env` file.** V4's copy
> contains `PORT=4175`, which is V4's port. V5 would bind that, its dev server
> would still look for the API on 4176, and the app would fail on every request
> with nothing on screen explaining why. This actually happened on the first
> real start. The server now refuses to boot on a V1–V4 port and tells you
> exactly this, so it cannot fail silently again — but the fix is still to have
> `PORT=4176` in V5's `.env`.

### Start it

```bash
npm run dev
```

- App: **http://127.0.0.1:5175**
- API: **http://127.0.0.1:4176**

Those are V5's own ports. V4 stays on 5174/4175 and is untouched — you can run
both at once, and signing out of one will not sign you out of the other.

### Sign in

- **Caller:** `CUST-1002` / `1002` — Akash, Premium, with the ₹18 disputed charge.
- **Billing team** (use a second browser profile or a private window):
  `employee@prodapt.demo` / `TwinForge#2026`.

**Headphones on.** Open-speaker echo handling is not validated and must not be
claimed either way.

### Sanity check

On the caller page you should see a new **V5 experiment** panel with:

- a Baseline / Natural delivery-style switch,
- an "Open the lab" button, and
- a **Live transcript helper: Off** row, with the reason shown.

That "Off" is correct and deliberate. Do not switch it on yet — section 4
explains when it becomes appropriate.

---

## 1. Does V5 still do what V4 did? (5 minutes)

Do this **first**. If V5 has broken the thing that already worked, nothing else
matters.

Keep the style on **Baseline**. Start a call and:

1. Ask about the ₹18 charge. → It should read your account and give you the real
   number.
2. While it is explaining, say "mm-hm" and stay quiet. → It should carry on from
   where it was, **not** re-introduce itself or restart.
3. Cut in mid-sentence with: *"Wait — I do not want money issued. Please send
   only the ₹18 charge to Billing for review."* → It should stop immediately,
   not re-introduce itself, and act on the correction.
4. It reads the request back and asks you to confirm. **Confirm.**
5. End the call.

Now open the billing-team window. You should see exactly **one** pending review
and **₹0 money issued**.

**If any of that fails, stop and tell me.** Do not go on to the style
comparison — a broken baseline would make every later comparison meaningless.

---

## 1b. The tick — did the fix work? (2 minutes) — **please check this first**

You reported a faint repetitive "ting ting" under the agent's voice. I found the
cause and fixed it, but **I cannot hear it, so I need you to confirm.**

**What it was:** Gemini sends its speech at 24 kHz. V4 played it into an audio
context running at your hardware rate (48 kHz — I read that out of your call
recording). So the browser had to convert every chunk on its own, and it
restarts its conversion filter at each chunk. That leaves a tiny click at every
join. Your chunks were 196–276 ms long, so that is about **4–5 clicks per
second** — exactly the "ting ting" you heard.

**What the fix does:** runs the output at Gemini's own 24 kHz, so there is
nothing to convert per chunk and the joins are exact.

**The check:**

1. Reload the page. In the V5 panel you now have an **Audio playback** switch:
   **Clean** (default, the fix) and **V4 original**.
2. On **Clean**, make a short call and just listen. Is the tick gone?
3. Switch to **V4 original**, make another short call. Does the tick come back?

If it is gone on Clean and back on V4 original, that confirms the diagnosis.
If it is still there on Clean, tell me — the fix did not work and I have the
wrong cause.

You can also check it without your ears. Open the call in the billing-team view;
there is now an **Audio playback quality** row showing:

- `Per-chunk resampling` — should read **no** on Clean, **YES** on V4 original
- `Output context` — should read **24000 Hz** on Clean
- `Scheduler gaps` — silence the player had to insert because a chunk arrived
  late. Each one is a separate click, so a high count here means a second,
  different problem (a slow network rather than the sample rate).

---

## 1c. The "bursting out" check, and picking a voice (5 minutes)

### Was it the stalling?

You said the voice was "bursting out". The recorder showed why: V4 only ever
guaranteed **20 ms** of scheduling headroom, while Gemini's audio arrives in
200-276 ms chunks. Measurement found chunks arriving 2-75 ms late fairly often,
and every time one missed that 20 ms window the player had to insert real
silence mid-word - then the audio resumed abruptly. Stall, burst, stall.

It now schedules the first chunk of each reply **140 ms** ahead, building a
cushion the rest of the reply rides on. Later chunks stay exactly contiguous, so
nothing is slowed or stretched once it starts talking.

**This does not slow down interruption.** I traced it rather than assuming:
every audio buffer is registered before it starts playing, and the interrupt
handler stops all of them including ones that have not begun. So a barge-in
still silences everything instantly - which is the rule ADR-008 exists to
protect.

It does add up to 140 ms before the first word. The report now shows that
separately (`scheduleLeadMs`) so it never quietly inflates the latency number we
compare against V4.

**Please listen for:** does the voice still stall and burst mid-sentence? And
separately - does it still stop instantly when you talk over it? The second
question matters more.

### Pick a voice

V4 used **Kore**, whose descriptor is "Firm". That may be a lot of why it reads
as machine-like for a support call.

The V5 panel now has a **Voice** row with seven to audition. Switch between
calls and pick by ear:

| Voice | Google's descriptor | Why it is worth hearing |
|---|---|---|
| **Kore** | Firm | V4's. The baseline to compare against. |
| **Sulafat** | Warm | The only descriptor that names warmth directly. |
| **Vindemiatrix** | Gentle | Calmer. Test whether it reads as less competent. |
| **Achird** | Friendly | Approachable without being bright. |
| **Achernar** | Soft | Restraint for an annoyed caller - may be too quiet for prices. |
| **Schedar** | Even | Steady and unperformed. A control. |
| **Algieba** | Smooth | Tests whether smooth reads as natural or more synthetic. |

**An important caveat.** Google publishes those one-word descriptors and nothing
else - **no gender, no accent, no language.** And these models choose the
language themselves; an Indian-English accent cannot be requested. So I cannot
tell you which one sounds like Maya. That table is a list to try, not a
recommendation. Tell me which you prefer and I will make it the default.

---

## 1d. About "adding emotions" - read this before switching it on

I did not build an emotion system, and I want to be straight about why.

**What I found:** Google's capability matrix lists affective dialogue - the
model adapting its style to the tone of your voice - as **"Not supported"** on
`gemini-3.1-flash-live-preview`, the model we run. It is supported on the older
**Gemini 2.5** live model.

So "add emotions" is really "change the model". That is a much bigger change
than it sounds: voice character, response timing and turn-taking all move at
once, so if it sounds better you cannot tell which of those did it.

**What I built:** an **Expression** switch offering that 2.5 engine, with
affective dialogue on. It is **off by default and gated on the server**
(`VOICE_EXPRESSIVE_ENABLED=false`), because it is unverified against this
agent's two business tools, its transcription, and its interruption path - all
of which the demo depends on.

**What I deliberately did not build:** fake breaths, "um"s, sighs, filler
sounds, an emotion classifier, or pitch rules. Your own research register lists
all of those as deferred, and the reasoning is sound - they tend to sound
theatrical and they do not help the agent understand anyone.

If you want to try the 2.5 engine, set `VOICE_EXPRESSIVE_ENABLED=true`, restart,
and A/B it against standard on the same situations. Expect to find bugs; tell me
what breaks.

---

## 2. The listening comparison (15 minutes) - **this is the one I need**

This decides whether the natural delivery style is kept or thrown away. I cannot
do it; it needs your ears.

### How to run it fairly

- Same account, same headphones, same room, same session.
- Do **one situation at a time**: run it on Baseline, then the same situation on
  Natural.
- **The style is locked once a call starts.** Change it between calls, not
  during one. The panel enforces this.
- Alternate which one you hear first where you can, so "second one sounds
  better" does not decide it for you.
- I have not told you which one is supposed to win, and you should not assume.
  **A tie is a real and useful answer.** So is "baseline is better".

### The eight situations

For each: run it, then note **A** (baseline), **B** (natural) or **tie**, and
whether anything factual or behavioural got worse.

| # | Situation | What to say |
|---|---|---|
| 1 | Ordinary explanation | "What do I get on the Premium plan?" |
| 2 | Frustrated complaint | "This is the second time I've been charged for something I didn't ask for." (sound annoyed) |
| 3 | Price readback | "How much is Business a month?" |
| 4 | Unclear input | Mumble a half-question, or trail off mid-sentence. |
| 5 | Acknowledgement | Say "mm-hm" while it explains, then stay quiet. |
| 6 | Correction | "Move me to Premium — actually no, don't change anything, just explain Business." |
| 7 | Decline | Ask for a plan change, then when it asks you to confirm, say no. |
| 8 | Interruption then continue | Cut in mid-sentence, then ask it to carry on. |

### What to write down

For each of the eight: **which felt clearer or more natural**, plus:

- ❗ Did it state a **wrong fact** (a price, a plan name, an amount)?
- ❗ Did it **do something** it should not have — especially on 6 and 7?
- ❗ Was the **interruption noticeably slower or worse**?
- Anything that sounded fake, over-cheerful, or theatrical.

### The proposed bar

Natural is kept only if: **at least 6 of 8 preferred**, **zero new wrong facts
or wrong actions**, and **no clearly worse interruption behaviour**.

The three ❗ items are hard blockers. A wrong action outranks any number of
"sounded nicer" votes. If it is close or you are unsure, the honest answer is
*inconclusive* and we keep baseline.

Afterwards, open the newest call in the billing-team view. Each call now carries
a **"V5 experiment · not a gate result"** block showing which style ran and its
prompt fingerprint, so you can confirm the two calls really did differ only in
style. Also check response p95 in the gate scorecard for both.

---

## 3. The transcript lab (5 minutes, optional today)

This one you can look at without recording anything and without sending
anything anywhere.

1. On the caller page, press **Open the lab**.
2. Press **Choose recordings…** and pick any short audio file (under 30
   seconds). *Nothing is sent when you pick it.*
3. Press **Plan the run (no network)**. You will see exactly what would be sent:
   the model, the mode, the config, the chunk count, and the clip's hash.
4. The **Run against the provider** button is disabled, with the reason shown.

That is the intended state today. To go further you need real recorded speech —
see `V5_TRANSCRIPT_CORPUS.md`, which lists 24 specific clips to record and the
scoring sheet to fill in. **Please read its consent and data-use section before
recording anything**: Google's pricing page says free-tier audio is used to
improve their products, and that is your call to make, not mine.

To enable real calls later, set `TRANSCRIPT_LAB_LIVE_CALLS=true` in `.env` and
restart. The server, not the browser, controls this.

---

## 4. The live transcript helper — leave it off

It is implemented and its failure paths are tested, but it is **deliberately
disabled** and I am not asking you to turn it on.

The order matters: the recorded-clip comparison in section 3 has to pass first.
Enabling a live second connection before knowing whether its output is any good
would risk the call for no demonstrated benefit — and the call is the demo.

---

## 5. If something goes wrong

**Turn everything V5-specific off** — in `.env`:

```
VOICE_STYLE=baseline
SMART_TRANSCRIPT_ENABLED=false
TRANSCRIPT_LAB_ENABLED=false
```

Restart. V5 now behaves as V4 does. No files need deleting and no restore is
needed.

**Fall back to V4 entirely:** `cd "../Prodapt IPL project V4" && npm run dev`.
V4 was never modified — its 30 source files are byte-for-byte what they were,
verified after this build — so it needs no restore step at all.

**Reset V5's demo data** so a billing scenario can create a genuinely new
review: stop the server, delete `data/actionguard-v5.db*`, restart. This touches
only V5's own database. (Reading an existing review is not the same as creating
one, so reset before you score section 1 step 5.)

---

## 6. What I need back from you

1. **Section 1:** did the baseline call still work? Yes / no, and what broke.
2. **Section 2:** the eight A/B/tie results, plus any ❗ item you hit.
3. **Section 3:** whether you want to record the 24 clips, and which billing
   tier this key is on.
4. Anything that sounded wrong, looked wrong, or made you uneasy.

Until I have at least 1 and 2, the natural style stays labelled *implemented,
not approved*, and I will not describe it as an improvement.
