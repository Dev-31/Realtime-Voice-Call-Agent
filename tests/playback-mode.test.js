/**
 * Regression tests for the chunk-boundary tick.
 *
 * The symptom was a faint repetitive "ting" under the agent's voice. The cause
 * was a sample-rate mismatch: Gemini sends 24 kHz audio, V4 played it into an
 * AudioContext running at the hardware rate (48 kHz on the affected machine),
 * and the browser therefore resampled every chunk independently. A resampling
 * filter has memory; restarting it per buffer leaves a discontinuity at each
 * boundary. Measured chunk length in a real call was 196-276 ms, so that is
 * ~4-5 audible ticks per second.
 *
 * This project's own research already named the failure mode:
 * research/audio/realtime-audio-pipeline.md ->
 *   "| Periodic tick/click every N ms | one-shot resampler called per chunk
 *      (no filter state) |"
 *
 * These tests pin the fix and, just as importantly, pin the V4-compatible path
 * so the comparison baseline cannot drift.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PLAYBACK_MODE,
  GEMINI_OUTPUT_SAMPLE_RATE,
  PLAYBACK_MODES,
  createGapMeter,
  createOutputContext,
  resolvePlaybackMode,
} from "../src/voice/playback-mode.js";
import { AUDIO_CONFIG } from "../src/voice/gemini-live.js";

/** A fake AudioContext that behaves like a browser honouring the request. */
function fakeFactory({ hardwareRate = 48000, honourRequest = true, throwOn = null } = {}) {
  const calls = [];
  const factory = (options) => {
    calls.push(options);
    if (throwOn && options && options.sampleRate === throwOn) {
      const error = new Error("sample rate not supported");
      error.name = "NotSupportedError";
      throw error;
    }
    const rate = honourRequest && options && options.sampleRate ? options.sampleRate : hardwareRate;
    return { sampleRate: rate, baseLatency: 0.01, state: "running" };
  };
  return { factory, calls };
}

// ---------------------------------------------------------------------------
// The provider's rate is a documented fact, not a guess
// ---------------------------------------------------------------------------

test("the target rate matches the documented Gemini Live output rate", () => {
  // "Audio output always uses a sample rate of 24kHz."
  // https://ai.google.dev/gemini-api/docs/live-api/capabilities
  assert.equal(GEMINI_OUTPUT_SAMPLE_RATE, 24000);
  assert.equal(
    AUDIO_CONFIG.outputSampleRate,
    GEMINI_OUTPUT_SAMPLE_RATE,
    "the voice core and the playback fix must agree on the provider's rate",
  );
});

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

test("the default mode is the fix, not the broken path", () => {
  assert.equal(DEFAULT_PLAYBACK_MODE, "continuous");
  assert.deepEqual(PLAYBACK_MODES, ["continuous", "v4-compatible"]);
});

test("an unknown, empty or missing mode falls back safely and says why", () => {
  for (const bad of ["", "  ", "loud", "V5", null, undefined, 42, {}]) {
    const result = resolvePlaybackMode(bad);
    assert.equal(result.mode, DEFAULT_PLAYBACK_MODE, `${String(bad)} must fall back`);
    assert.equal(result.fellBack, true);
    assert.ok(result.reason, "a fallback must carry a reason");
  }
  assert.equal(resolvePlaybackMode("CONTINUOUS").mode, "continuous");
  assert.equal(resolvePlaybackMode(" v4-compatible ").mode, "v4-compatible");
  assert.equal(resolvePlaybackMode("v4-compatible").fellBack, false);
});

// ---------------------------------------------------------------------------
// THE FIX: continuous mode asks for 24 kHz and reports honestly
// ---------------------------------------------------------------------------

test("continuous mode requests a 24 kHz context, so nothing is resampled per chunk", () => {
  const { factory, calls } = fakeFactory({ hardwareRate: 48000 });
  const result = createOutputContext({ mode: "continuous", factory });

  assert.deepEqual(calls, [{ sampleRate: 24000 }], "it must ask for the provider's rate");
  assert.equal(result.actualSampleRate, 24000);
  assert.equal(result.matchesProviderRate, true);
  assert.equal(
    result.perChunkResampling,
    false,
    "this is the whole point: no per-chunk resampling means no boundary click",
  );
  assert.equal(result.fallbackReason, null);
});

test("V4-compatible mode reproduces the old call exactly, and admits it will tick", () => {
  const { factory, calls } = fakeFactory({ hardwareRate: 48000 });
  const result = createOutputContext({ mode: "v4-compatible", factory });

  // `new AudioContext()` with no argument at all — byte-for-byte V4.
  assert.deepEqual(calls, [undefined], "the V4 path must pass no options whatsoever");
  assert.equal(result.actualSampleRate, 48000);
  assert.equal(result.requestedSampleRate, null);
  assert.equal(result.matchesProviderRate, false);
  assert.equal(
    result.perChunkResampling,
    true,
    "the V4 path must report that it resamples per chunk, rather than looking fine",
  );
  assert.match(result.note, /tick/i, "the note must name the audible consequence");
});

test("a browser that refuses 24 kHz degrades to a working context and says the tick remains", () => {
  const { factory, calls } = fakeFactory({ hardwareRate: 44100, throwOn: 24000 });
  const result = createOutputContext({ mode: "continuous", factory });

  assert.equal(calls.length, 2, "it must retry without options rather than fail the call");
  assert.deepEqual(calls[0], { sampleRate: 24000 });
  assert.equal(calls[1], undefined);
  assert.equal(result.actualSampleRate, 44100);
  assert.equal(result.fallbackReason, "NotSupportedError");
  assert.equal(result.perChunkResampling, true);
  assert.match(result.note, /still be present/i, "a failed fix must not read as a successful one");
});

test("a browser that silently ignores the requested rate is caught, not trusted", () => {
  // The dangerous case: no throw, but a different rate comes back.
  const { factory } = fakeFactory({ hardwareRate: 48000, honourRequest: false });
  const result = createOutputContext({ mode: "continuous", factory });

  assert.equal(result.actualSampleRate, 48000);
  assert.equal(result.matchesProviderRate, false);
  assert.equal(result.perChunkResampling, true);
  assert.equal(
    result.fallbackReason,
    "browser_ignored_requested_rate",
    "asking is not getting; the report must not claim a 24 kHz context it did not receive",
  );
});

test("an unknown mode still produces a usable context", () => {
  const { factory } = fakeFactory();
  const result = createOutputContext({ mode: "nonsense", factory });
  assert.equal(result.mode, DEFAULT_PLAYBACK_MODE);
  assert.ok(result.context, "a bad setting must never leave the call without audio output");
});

// ---------------------------------------------------------------------------
// The gap meter: turning "I think I hear a tick" into a number
// ---------------------------------------------------------------------------

test("contiguous chunks record no gaps", () => {
  const meter = createGapMeter();
  // 200 ms chunks scheduled back to back, exactly.
  let cursor = 1.0;
  for (let i = 0; i < 10; i += 1) {
    meter.note(cursor, cursor);
    cursor += 0.2;
  }
  const report = meter.report();
  assert.equal(report.chunksScheduled, 10);
  assert.equal(report.gapsInserted, 0);
  assert.equal(report.totalGapMs, 0);
  assert.equal(report.gapRate, 0);
});

test("the first chunk of an epoch is not counted as a gap", () => {
  const meter = createGapMeter();
  // nextPlaybackTime is 0 before anything has played.
  assert.equal(meter.note(1.5, 0), 0);
  assert.equal(meter.report().gapsInserted, 0);
  assert.equal(meter.report().chunksScheduled, 1, "it still counts as a scheduled chunk");
});

test("the pause between two conversational turns is not a playback glitch", () => {
  // The bug this pins: `nextPlaybackTime` holds the END of the previous reply's
  // last chunk. If the caller then talks for eight seconds, the next reply's
  // first chunk is scheduled ~8 s later. Without the firstOfResponse flag the
  // meter reported that as an eight-second playback gap. The first real
  // measurement produced 24 such phantom gaps over 250 ms alongside 15 genuine
  // ones under 100 ms — with nothing between 100 and 250 ms, which is what gave
  // the artefact away.
  const meter = createGapMeter();

  // Reply 1: three contiguous 200 ms chunks starting at t=1.0.
  meter.note(1.0, 0, true);
  meter.note(1.2, 1.2);
  meter.note(1.4, 1.4);

  // Caller speaks for 8 seconds. Reply 2 begins at t=9.6, while the cursor
  // still points at 1.6.
  const phantom = meter.note(9.6, 1.6, true);
  assert.equal(phantom, 0, "a turn-taking pause must not be reported as inserted silence");

  meter.note(9.8, 9.8);
  const report = meter.report();
  assert.equal(report.gapsInserted, 0, "a clean two-turn exchange has zero gaps");
  assert.equal(report.chunksScheduled, 5, "every chunk is still counted");
});

test("a genuine mid-reply stall is still caught after the flag was added", () => {
  const meter = createGapMeter();
  meter.note(1.0, 0, true);       // reply starts
  meter.note(1.2, 1.2);           // contiguous
  meter.note(1.475, 1.4);         // 75 ms stall — the real defect
  const report = meter.report();
  assert.equal(report.gapsInserted, 1, "a stall within a reply must still be reported");
  assert.ok(Math.abs(report.worstGapMs - 75) < 0.01, `worstGapMs was ${report.worstGapMs}`);
});

test("inserted silence is measured exactly, with the worst case kept", () => {
  const meter = createGapMeter();
  meter.note(1.0, 1.0);        // contiguous
  meter.note(1.25, 1.2);       // 50 ms gap
  meter.note(1.5, 1.45);       // 50 ms gap
  meter.note(2.0, 1.7);        // 300 ms gap - the worst

  const report = meter.report();
  assert.equal(report.chunksScheduled, 4);
  assert.equal(report.gapsInserted, 3);
  assert.ok(Math.abs(report.totalGapMs - 400) < 0.01, `totalGapMs was ${report.totalGapMs}`);
  assert.ok(Math.abs(report.worstGapMs - 300) < 0.01, `worstGapMs was ${report.worstGapMs}`);
  assert.equal(report.gapRate, 0.75);
  assert.match(report.precision, /not-an-estimate/, "this figure is exact and must be labelled so");
});

test("sub-sample floating point noise is not reported as a gap", () => {
  const meter = createGapMeter();
  // One sample at 24 kHz is ~0.0417 ms. Float accumulation noise is far below that.
  meter.note(1.0 + 1e-9, 1.0);
  meter.note(2.0 + 2e-8, 2.0);
  assert.equal(meter.report().gapsInserted, 0, "float dust is not an audible discontinuity");
  assert.equal(meter.report().chunksScheduled, 2);
});

test("reset clears the meter for the next call", () => {
  const meter = createGapMeter();
  meter.note(1.0, 0.5);
  assert.equal(meter.report().gapsInserted, 1);
  meter.reset();
  assert.equal(meter.report().gapsInserted, 0);
  assert.equal(meter.report().chunksScheduled, 0);
  assert.equal(meter.report().gapRate, null, "no chunks means no rate, not a fake zero");
});

// ---------------------------------------------------------------------------
// The fix must not disturb what already worked
// ---------------------------------------------------------------------------

test("changing playback mode does not change the voice configuration at all", async () => {
  const { liveConfig } = await import("../src/voice/gemini-live.js");
  const baseline = liveConfig({ name: "Akash" }, { voiceStyle: "baseline" });
  const natural = liveConfig({ name: "Akash" }, { voiceStyle: "natural" });

  // liveConfig has no playback input by design: playback is a browser-side
  // concern and must never leak into what the provider is asked for.
  for (const config of [baseline, natural]) {
    assert.equal(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
    assert.deepEqual(config.realtimeInputConfig.automaticActivityDetection, {
      disabled: false,
      prefixPaddingMs: AUDIO_CONFIG.prefixPaddingMs,
      silenceDurationMs: AUDIO_CONFIG.silenceDurationMs,
    });
    assert.equal(config.sampleRate, undefined, "playback settings must not reach the provider config");
    assert.equal(config.playbackMode, undefined);
  }
});

test("the fix adds no buffer to the output path (ADR-008)", () => {
  // ADR-008: "Any future buffer added to the output path must declare whether
  // it is recallable." An unrecallable buffer raises the floor on how fast a
  // barge-in can silence the agent, which is this project's headline property.
  // The gap meter only counts; it holds no audio.
  const meter = createGapMeter();
  const surface = Object.keys(meter).sort();
  assert.deepEqual(surface, ["note", "report", "reset"]);
  const report = meter.report();
  assert.ok(!("buffer" in report) && !("queue" in report) && !("samples" in report));
});
