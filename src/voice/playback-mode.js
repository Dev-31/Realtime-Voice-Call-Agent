/**
 * V5 Stage 1b — output playback mode.
 *
 * THE BUG THIS FIXES, IN PLAIN TERMS
 * ----------------------------------
 * The owner heard a faint repetitive "ting ting" underneath the agent's voice.
 * It was a click at the seam between every audio chunk.
 *
 * Gemini streams its speech as raw 16-bit PCM at **24 kHz** (documented: "Audio
 * output always uses a sample rate of 24kHz"). V4 played each chunk by building
 * an AudioBuffer tagged 24 kHz and handing it to an AudioContext created with
 * `new AudioContext()` -- no options -- which takes the *hardware* rate. On the
 * owner's machine that is **48 kHz** (confirmed from the call recorder).
 *
 * So the browser had to resample every single chunk from 24 k to 48 k. It does
 * that **per buffer, independently**, with no filter state carried from one
 * buffer to the next. A resampling filter has memory; restarting it at every
 * boundary leaves a small discontinuity there. The measured chunk length in a
 * real call is 196-276 ms, so that is roughly **4-5 discontinuities per
 * second** -- slow enough to hear as individual ticks rather than a buzz.
 *
 * This project already had the answer written down. From
 * `research/audio/realtime-audio-pipeline.md`, "Failure modes and their
 * symptoms":
 *
 *     | Periodic tick/click every N ms | one-shot resampler called per chunk
 *                                        (no filter state) |
 *
 * and from `research/audio/audio-fundamentals.md`:
 *
 *     "calling a one-shot resampler per chunk creates a discontinuity at every
 *      chunk boundary -- an audible periodic tick. Classic bug, easy to miss
 *      because each chunk sounds fine in isolation."
 *
 * The twist is that the one-shot resampler was not ours. It was the browser's,
 * invoked implicitly by the sample-rate mismatch.
 *
 * THE FIX
 * -------
 * Ask for an AudioContext that already runs at 24 kHz:
 *
 *     new AudioContext({ sampleRate: 24000 })
 *
 * Then a 24 kHz buffer needs no conversion at all, and there is no per-chunk
 * filter to restart. The device still has to reach 48 kHz, but that conversion
 * happens once, continuously, in the audio output layer -- it has no per-buffer
 * seams to click at.
 *
 * WHY IT IS A SWITCH AND NOT JUST A CHANGE
 * ----------------------------------------
 * V5's whole purpose is comparing against V4, so V4-identical behaviour has to
 * stay reproducible. `v4-compatible` reproduces the old path exactly, ticks
 * included, so the owner can A/B by ear and so a latency comparison can be run
 * against genuinely identical playback.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It adds no buffer to the output path. ADR-008 requires any new output buffer
 * to declare whether it is recallable, because an unrecallable buffer raises the
 * floor on how fast a barge-in can stop the audio -- the project's headline
 * property. Changing the context's sample rate adds no queue, no jitter buffer
 * and no latency of our own, so `clearPlayback()` still drops every queued
 * source exactly as before and the heard-state accounting in ADR-004 is
 * untouched.
 *
 * It also does not touch `resampleTo16k` on the microphone path. That is the
 * capture resampler, F55 records an explicit instruction not to change it, and
 * it cannot produce this artefact.
 */

export const PLAYBACK_MODES = Object.freeze(["continuous", "v4-compatible"]);

/**
 * Default to the fix.
 *
 * This is a defect, not a feature: leaving a known audible artefact switched on
 * by default would be the wrong call. `v4-compatible` remains one setting away.
 */
export const DEFAULT_PLAYBACK_MODE = "continuous";

/** Documented Gemini Live output rate. Not a guess, and not negotiable. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

/**
 * How far ahead the FIRST chunk of a reply is scheduled, in milliseconds.
 *
 * Sized from measurement, not taste. A 350-second call logged genuine
 * mid-reply stalls of 2, 10.6, 48, 58.6 and 74.6 ms against V4's 20 ms of
 * headroom -- so chunks were routinely arriving after the deadline and the
 * scheduler had to insert silence, which is heard as the voice stalling and
 * then bursting back in.
 *
 * 140 ms clears the worst observed stall (75 ms) with roughly the same margin
 * again, while staying well inside the frozen p95 budget: the V4 baseline
 * measured 1,552 ms p50 / 1,932 ms p95 against a 2,500 ms target, so there is
 * about 568 ms of headroom and this spends a quarter of it.
 *
 * Only the first chunk of a reply gets this. Everything after it is scheduled
 * exactly contiguously, so speech is never stretched or delayed mid-sentence --
 * the cushion is consumed once, at the start, and then simply absorbs jitter.
 */
export const PLAYBACK_LEAD_MS = 140;

/** V4's headroom, kept for the compatibility mode and for the tests. */
export const V4_PLAYBACK_LEAD_MS = 20;

export function resolvePlaybackMode(requested) {
  const value = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (PLAYBACK_MODES.includes(value)) {
    return { mode: value, requested: requested ?? null, fellBack: false, reason: null };
  }
  return {
    mode: DEFAULT_PLAYBACK_MODE,
    requested: requested ?? null,
    fellBack: true,
    reason: value ? "unknown_playback_mode" : "no_playback_mode_supplied",
  };
}

/**
 * Create the output AudioContext for a mode.
 *
 * `factory` is injectable so tests can assert what was requested without a
 * browser. It receives the options object, or `undefined` for the V4 path --
 * `new AudioContext(undefined)` and `new AudioContext()` are equivalent, but
 * passing nothing keeps the V4 call byte-for-byte what it was.
 *
 * A browser that refuses the requested rate must not break the call, so a
 * failure falls back to the default context and reports that it did. Silence
 * about a fallback would be worse than the tick: it would look fixed.
 */
export function createOutputContext({
  mode = DEFAULT_PLAYBACK_MODE,
  factory = (options) => (options === undefined ? new AudioContext() : new AudioContext(options)),
  targetSampleRate = GEMINI_OUTPUT_SAMPLE_RATE,
} = {}) {
  const resolved = resolvePlaybackMode(mode);

  if (resolved.mode === "v4-compatible") {
    const context = factory(undefined);
    return {
      context,
      mode: resolved.mode,
      requestedSampleRate: null,
      actualSampleRate: context.sampleRate ?? null,
      matchesProviderRate: context.sampleRate === targetSampleRate,
      perChunkResampling: context.sampleRate !== targetSampleRate,
      fallbackReason: null,
      note:
        "V4-identical path: the context takes the hardware rate, so the browser resamples every chunk independently. Expect a tick at each chunk boundary when the rates differ.",
    };
  }

  let context = null;
  let fallbackReason = null;
  try {
    context = factory({ sampleRate: targetSampleRate });
  } catch (error) {
    // Some browsers/devices refuse an arbitrary rate. Degrade, do not fail.
    fallbackReason = error?.name || "sample_rate_refused";
  }

  if (!context) {
    context = factory(undefined);
  }

  const actualSampleRate = context.sampleRate ?? null;
  // Asking is not getting: a browser may hand back a different rate.
  if (!fallbackReason && actualSampleRate !== targetSampleRate) {
    fallbackReason = "browser_ignored_requested_rate";
  }

  return {
    context,
    mode: resolved.mode,
    requestedSampleRate: targetSampleRate,
    actualSampleRate,
    matchesProviderRate: actualSampleRate === targetSampleRate,
    perChunkResampling: actualSampleRate !== targetSampleRate,
    fallbackReason,
    note: fallbackReason
      ? "Requested a 24 kHz output context and did not get one, so the browser is still resampling every chunk. The tick will still be present."
      : "Output context runs at the provider's own 24 kHz, so no per-chunk resampling occurs and chunk boundaries are sample-exact.",
  };
}

/**
 * Track how much silence the scheduler had to insert.
 *
 * `startAt = Math.max(nextPlaybackTime, currentTime + 0.02)` is a correct
 * safety clamp -- audio cannot be scheduled in the past -- but when the stream
 * stalls it inserts a real gap mid-word, which is its own click. V4 never
 * measured this, so nobody could tell whether it was happening.
 *
 * Counting it turns "I think I hear a tick" into a number in the call report.
 */
export function createGapMeter() {
  let gaps = 0;
  let totalGapMs = 0;
  let worstGapMs = 0;
  let chunks = 0;

  return {
    /**
     * @param {number} startAt         when the chunk was actually scheduled
     * @param {number} idealStartAt    `nextPlaybackTime` — where it would have been contiguous
     * @param {boolean} firstOfResponse first chunk of this reply, so nothing precedes it
     *
     * `firstOfResponse` is load-bearing, and getting it wrong made this meter
     * lie. `nextPlaybackTime` holds the end of the PREVIOUS reply's last chunk.
     * If the caller then talks for eight seconds, the next reply's first chunk
     * is scheduled ~8 s after that cursor — and without this flag the meter
     * counted the conversation's own turn-taking pause as an eight-second
     * playback glitch. The first real measurement showed 24 such phantom
     * "gaps" over 250 ms and 15 genuine ones under 100 ms, with nothing in
     * between: two different phenomena in one number.
     */
    note(startAt, idealStartAt, firstOfResponse = false) {
      chunks += 1;
      // Nothing precedes the first chunk of a reply, so there is no seam to break.
      if (firstOfResponse) return 0;
      if (!Number.isFinite(idealStartAt) || idealStartAt <= 0) return 0;
      const gapMs = Math.max(0, (startAt - idealStartAt) * 1000);
      // Sub-sample float noise is not a gap. One sample at 24 kHz is ~0.042 ms.
      if (gapMs <= 0.05) return 0;
      gaps += 1;
      totalGapMs += gapMs;
      if (gapMs > worstGapMs) worstGapMs = gapMs;
      return gapMs;
    },
    report() {
      return {
        chunksScheduled: chunks,
        gapsInserted: gaps,
        totalGapMs: Number(totalGapMs.toFixed(2)),
        worstGapMs: Number(worstGapMs.toFixed(2)),
        gapRate: chunks ? Number((gaps / chunks).toFixed(4)) : null,
        precision: "exact-scheduler-arithmetic-not-an-estimate",
        meaning:
          "A gap is silence the scheduler had to insert because the next chunk arrived too late to be contiguous. Each one is an audible discontinuity.",
      };
    },
    reset() {
      gaps = 0;
      totalGapMs = 0;
      worstGapMs = 0;
      chunks = 0;
    },
  };
}
