import assert from "node:assert/strict";
import test from "node:test";
import {
  ALIGNMENT_QUALITY,
  createTranscriptStore,
  LANE_DEFINITIONS,
  LANE_IDS,
  SEGMENT_STATES,
} from "../src/transcription/transcript-store.js";
import { createTranscriber, readTranscriptionEvents, TRANSCRIBER_DEFAULTS } from "../src/transcription/gemini-transcriber.js";
import {
  bytesToBase64,
  chunkPcm16,
  CLIP_LIMITS,
  FRAMES_PER_CHUNK,
  floatToPcm16,
  mixToMono,
  normalizeClip,
  pcm16DurationSeconds,
  resampleTo16k,
  sha256Hex,
  TARGET_MIME_TYPE,
  TARGET_SAMPLE_RATE,
  validateClipFile,
  validateDecodedClip,
} from "../src/transcription/audio-normalize.js";

const RAW = "voice-core-raw";
const VERBATIM = "dedicated-verbatim";
const SMART = "dedicated-smart";

/** A store with a clock we control, so no assertion depends on wall time. */
function store(startAt = 0) {
  let clock = startAt;
  const instance = createTranscriptStore({ now: () => (clock += 1) });
  instance.tick = (by) => { clock += by; };
  return instance;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A virtual clock plus setTimeout/clearTimeout replacements.
 *
 * The transcriber's grace periods, connect timeout and drain loop are all
 * measured with the injected `now` and `setTimeoutImpl`, so driving them from
 * here keeps a ten-second timeout test instantaneous. Each due callback is run
 * and then microtasks are flushed, so the code awaiting the timer actually gets
 * to advance before the next one fires.
 */
function fakeTimers() {
  let clock = 0;
  let serial = 0;
  const pending = new Map();
  return {
    now: () => clock,
    setTimeoutImpl(fn, delay) {
      serial += 1;
      pending.set(serial, { at: clock + (Number(delay) || 0), fn });
      return serial;
    },
    clearTimeoutImpl(id) { pending.delete(id); },
    get pendingTimers() { return pending.size; },
    async advance(ms) {
      const target = clock + ms;
      for (let guard = 0; guard < 20000; guard += 1) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, entry] of pending) if (entry.at < nextAt) { nextAt = entry.at; nextId = id; }
        if (nextId == null || nextAt > target) break;
        clock = nextAt;
        const entry = pending.get(nextId);
        pending.delete(nextId);
        entry.fn();
        await flush();
      }
      clock = target;
      await flush();
    },
  };
}

/** A transcriber wired to fakes only: no network, no real timer, no credential. */
function harness({ connect, requestToken, limits = {}, laneId = VERBATIM } = {}) {
  const timers = fakeTimers();
  const transcripts = createTranscriptStore({ now: timers.now });
  const metrics = [];
  const statuses = [];
  const sessions = [];

  const defaultConnect = async ({ callbacks }) => {
    const session = {
      sent: [],
      closeCalls: 0,
      sendRealtimeInput(payload) { this.sent.push(payload); },
      close() { this.closeCalls += 1; },
    };
    sessions.push({ session, callbacks });
    callbacks.onopen?.();
    return session;
  };

  const transcriber = createTranscriber({
    laneId,
    store: transcripts,
    connect: connect || defaultConnect,
    requestToken: requestToken || (async () => ({
      // Deliberately not credential-shaped: nothing in these tests may look
      // like a real key, and report() is asserted not to echo it.
      value: "fake-token-for-tests",
      model: "gemini-3.5-transcribe-live",
      mode: "VERBATIM",
      liveConfig: { responseModalities: ["TEXT"] },
    })),
    now: timers.now,
    onMetric: (metric) => metrics.push(metric),
    onStatus: (status) => statuses.push(status),
    limits: { connectTimeoutMs: 100, finalGraceMs: 200, drainIntervalMs: 20, maxSessionSeconds: 5, maxQueuedChunks: 4, ...limits },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  return { timers, store: transcripts, transcriber, metrics, statuses, sessions, laneId };
}

const interimMessage = (text) => ({ serverContent: { interimInputTranscription: { text } } });
const finalMessage = (text) => ({ serverContent: { inputTranscription: { text } } });
const kinds = (metrics) => metrics.map((metric) => metric.kind);

// ---------------------------------------------------------------------------
// 1. Interim replacement versus final accumulation
// ---------------------------------------------------------------------------

test("an interim hypothesis replaces the previous one instead of concatenating", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "the charge" });
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "the charge on my" });
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "the charge on my bill" });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 1, "an interim revision must not open a new segment");
  assert.equal(view.current[0].interimText, "the charge on my bill");
  assert.equal(view.current[0].displayText, "the charge on my bill");
  assert.equal(view.current[0].state, "provisional");
  assert.equal(view.current[0].revisions, 3);
  assert.equal(view.stats.interimReceived, 3);
});

test("consecutive finals accumulate as separate ordered segments", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "There is a charge of eighteen rupees." });
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "It was billed on the third." });
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "I would like it reviewed." });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 3, "each final must close its own segment");
  assert.deepEqual(view.current.map((segment) => segment.sequence), [0, 1, 2]);
  assert.deepEqual(view.current.map((segment) => segment.state), ["finalized", "finalized", "finalized"]);
  assert.equal(
    view.finalizedText,
    "There is a charge of eighteen rupees. It was billed on the third. I would like it reviewed.",
  );
  assert.equal(view.stats.finalsReceived, 3);
});

test("a final closes the segment its interims were building, not a new one", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "the charge on my" });
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "The charge on my bill." });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].state, "finalized");
  assert.equal(view.current[0].text, "The charge on my bill.");
  assert.equal(view.current[0].displayText, "The charge on my bill.");
  assert.equal(view.finalizedText, "The charge on my bill.");
});

test("finalizedText excludes a provisional hypothesis entirely", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "First sentence." });
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "second sentence still being guessed" });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 2);
  assert.equal(view.finalizedText, "First sentence.", "a hypothesis is not a transcript");
  assert.ok(!view.finalizedText.includes("still being guessed"));
  assert.equal(view.unresolved, 1, "the open hypothesis stays counted as unresolved");
});

test("a segment is bounded so a runaway provider cannot grow one row without limit", () => {
  const transcripts = createTranscriptStore({ now: () => 0, maxCharactersPerSegment: 32 });
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "x".repeat(500) });
  assert.equal(transcripts.laneView(SMART).current[0].text.length, 32);
});

// ---------------------------------------------------------------------------
// 2. Duplicates
// ---------------------------------------------------------------------------

test("an identical repeated interim is ignored and counted", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  assert.equal(transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "same words" }).filed, true);
  const repeat = transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "same words" });

  assert.equal(repeat.filed, false);
  assert.equal(repeat.reason, "duplicate_interim");
  const view = transcripts.laneView(SMART);
  assert.equal(view.stats.duplicatesIgnored, 1);
  assert.equal(view.stats.interimReceived, 1);
  assert.equal(view.current[0].revisions, 1, "a duplicate must not count as a revision");
});

test("an identical repeated final is ignored and counted", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "The charge on my bill." });
  const repeat = transcripts.applyEvent({ laneId: SMART, kind: "final", text: "The charge on my bill." });

  assert.equal(repeat.filed, false);
  assert.equal(repeat.reason, "duplicate_final");
  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 1, "a replayed final must not double the sentence");
  assert.equal(view.stats.duplicatesIgnored, 1);
  assert.equal(view.stats.finalsReceived, 1);
  assert.equal(view.finalizedText, "The charge on my bill.");
});

test("a genuinely different final is not mistaken for a duplicate", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "eighteen rupees" });
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "eighty rupees" });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 2);
  assert.equal(view.stats.duplicatesIgnored, 0);
});

test("an event with no text, an unknown kind or an unknown lane is rejected, not filed", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);

  assert.equal(transcripts.applyEvent({ laneId: SMART, kind: "final", text: "" }).reason, "empty_text");
  assert.equal(transcripts.applyEvent({ laneId: SMART, kind: "final" }).reason, "empty_text");
  assert.equal(transcripts.applyEvent({ laneId: SMART, kind: "partial", text: "x" }).reason, "unknown_kind");
  assert.equal(transcripts.applyEvent({ laneId: "invented-lane", kind: "final", text: "x" }).reason, "unknown_lane");
  assert.equal(transcripts.applyEvent({}).reason, "unknown_lane");

  assert.equal(transcripts.laneView(SMART).current.length, 0, "a rejected event must not open a segment");
  assert.equal(transcripts.snapshot().counts.rejectedEvents, 5, "nothing may be dropped without a record");
});

// FAILS: a whitespace-only final is filed as a `finalized` segment with no text,
// which is exactly the "empty success" the build plan forbids.
test("a whitespace-only final is not recorded as a successful empty segment", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "   " });

  const view = transcripts.laneView(SMART);
  const emptySuccesses = view.current.filter((segment) => segment.state === "finalized" && !segment.text.trim());
  assert.deepEqual(emptySuccesses, [], "a blank final must be a rejected event or a failure row, never a finalized segment");
});

// ---------------------------------------------------------------------------
// 3. Out-of-order and late arrival
// ---------------------------------------------------------------------------

test("a final tagged with an earlier generation is filed under that generation, not the newest one", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "interim", text: "the charge on my" });
  transcripts.startGeneration(VERBATIM);

  const filed = transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "The charge on my bill.", generation: 0 });

  assert.equal(filed.filed, true);
  assert.equal(filed.generation, 0);
  assert.equal(filed.late, true);

  const view = transcripts.laneView(VERBATIM);
  assert.equal(view.currentGeneration, 1);
  const older = view.generations.find((generation) => generation.index === 0);
  assert.equal(older.segments.length, 1);
  assert.equal(older.segments[0].text, "The charge on my bill.");
  assert.equal(older.segments[0].lateArrival, true, "a late result must be flagged as late");
  assert.deepEqual(view.current, [], "a late result must never be presented as the newest turn");
});

test("a late arrival is listed in the snapshot so it is auditable", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "interim", text: "half a sentence" });
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "Half a sentence finished later.", generation: 0 });

  const snapshot = transcripts.snapshot();
  assert.equal(snapshot.lateEvents.length, 1);
  assert.equal(snapshot.lateEvents[0].generation, 0);
  assert.equal(snapshot.lateEvents[0].currentGeneration, 1);
  assert.equal(snapshot.lateEvents[0].kind, "final");
  assert.equal(snapshot.counts.lateEvents, 1);
  assert.equal(transcripts.laneView(VERBATIM).stats.lateFiled, 1);
});

test("an event for a generation that was never opened is filed there rather than invented into the present", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.startGeneration(VERBATIM);
  const filed = transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "From a generation we never saw.", generation: 9 });

  assert.equal(filed.filed, true);
  assert.equal(filed.generation, 9);
  assert.equal(filed.late, true);
  const view = transcripts.laneView(VERBATIM);
  assert.equal(view.currentGeneration, 1);
  assert.deepEqual(view.current, []);
  assert.ok(view.generations.some((generation) => generation.index === 9));
});

test("an event that arrives before any generation started is refused", () => {
  const transcripts = store();
  const filed = transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "Too early." });
  assert.equal(filed.filed, false);
  assert.equal(filed.reason, "no_generation_started");
  assert.equal(transcripts.snapshot().rejectedEvents[0].reason, "no_generation_started");
});

// ---------------------------------------------------------------------------
// 4. After close
// ---------------------------------------------------------------------------

test("an event arriving after the lane is closed is recorded as a late arrival", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "Everything I said." });
  transcripts.closeLane(SMART, { state: "complete", detail: "audio_complete" });

  const filed = transcripts.applyEvent({ laneId: SMART, kind: "final", text: "One more sentence." });

  assert.equal(filed.late, true);
  const snapshot = transcripts.snapshot();
  assert.equal(snapshot.lateEvents.length, 1);
  assert.equal(snapshot.lateEvents[0].laneClosed, true);
  const view = transcripts.laneView(SMART);
  assert.equal(view.closed, true);
  const late = view.generations[0].segments.find((segment) => segment.text === "One more sentence.");
  assert.equal(late.lateArrival, true);
});

// FAILS: text that arrives after closeLane is appended to the current
// generation, so it shows up in `current` and is glued into `finalizedText` as
// though the lane had been open all along.
test("text arriving after the lane is closed does not become current text", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "Everything I said." });
  transcripts.closeLane(SMART, { state: "complete", detail: "audio_complete" });
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "One more sentence." });

  const view = transcripts.laneView(SMART);
  assert.ok(
    !view.current.some((segment) => segment.displayText === "One more sentence."),
    "a post-close result must not appear in the current column",
  );
  assert.equal(view.finalizedText, "Everything I said.", "a post-close result must not extend the closed transcript");
});

// ---------------------------------------------------------------------------
// 5. Reconnect gap
// ---------------------------------------------------------------------------

test("a reconnect opens a new generation marked as preceded by a gap", () => {
  const transcripts = store();
  const first = transcripts.startGeneration(VERBATIM);
  assert.deepEqual(first, { laneId: VERBATIM, generation: 0, precededByGap: false });
  assert.equal(transcripts.laneView(VERBATIM).stats.gaps, 0);

  transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "I want to ask about" });
  const second = transcripts.startGeneration(VERBATIM);

  assert.deepEqual(second, { laneId: VERBATIM, generation: 1, precededByGap: true });
  assert.equal(transcripts.laneView(VERBATIM).stats.gaps, 1);
});

test("two halves of a sentence either side of a reconnect are never presented as continuous", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "I want to ask about" });
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "the eighteen rupee charge." });

  const view = transcripts.laneView(VERBATIM);
  assert.equal(view.generations.length, 2);
  assert.equal(view.generations[0].precededByGap, false);
  assert.equal(view.generations[1].precededByGap, true);
  assert.equal(view.current.length, 1, "the current column holds only the newest generation");
  assert.equal(view.current[0].text, "the eighteen rupee charge.");
  assert.equal(view.current[0].generation, 1);
  assert.ok(
    !view.current.some((segment) => segment.text.includes("I want to ask about")),
    "the pre-gap half must stay in its own generation",
  );
});

test("a third reconnect keeps counting gaps rather than collapsing them", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.startGeneration(VERBATIM);
  transcripts.startGeneration(VERBATIM);
  const view = transcripts.laneView(VERBATIM);
  assert.equal(view.currentGeneration, 2);
  assert.equal(view.stats.gaps, 2);
  assert.deepEqual(view.generations.map((generation) => generation.index), [0, 1, 2]);
});

// ---------------------------------------------------------------------------
// 6. Terminal states
// ---------------------------------------------------------------------------

test("resolveOpenSegments marks every still-open segment and leaves terminal ones alone", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "final", text: "Finished before the failure." });
  transcripts.applyEvent({ laneId: VERBATIM, kind: "interim", text: "still guessing when it died" });

  const changed = transcripts.resolveOpenSegments(VERBATIM, "timed_out", { detail: "no_final_within_grace_period" });

  assert.equal(changed, 1);
  const view = transcripts.laneView(VERBATIM);
  assert.deepEqual(view.current.map((segment) => segment.state), ["finalized", "timed_out"]);
  assert.equal(view.current[1].note, "no_final_within_grace_period");
  assert.equal(view.unresolved, 0);
  assert.deepEqual(view.failures, [{ segmentId: view.current[1].id, state: "timed_out", note: "no_final_within_grace_period" }]);
});

// FAILS: a timed-out segment keeps its partial hypothesis in `interimText` but
// `displayText` falls back to the empty `text`, so a UI rendering displayText
// shows a failed row with no words at all.
test("a timed-out segment still shows the partial words it had", () => {
  const transcripts = store();
  transcripts.startGeneration(VERBATIM);
  transcripts.applyEvent({ laneId: VERBATIM, kind: "interim", text: "the charge on my" });
  transcripts.resolveOpenSegments(VERBATIM, "timed_out", { detail: "no_final_within_grace_period" });

  const segment = transcripts.laneView(VERBATIM).current[0];
  assert.equal(segment.interimText, "the charge on my", "the hypothesis itself must be kept");
  assert.equal(segment.displayText, "the charge on my", "the partial must remain visible on the failed row");
});

test("a lane that produced nothing at all still leaves one visible failure row in the denominator", () => {
  for (const state of ["unavailable", "timed_out", "cancelled"]) {
    const transcripts = store();
    const changed = transcripts.resolveOpenSegments(SMART, state, { detail: `${state}_before_any_audio` });

    assert.equal(changed, 1, `${state} produced no row`);
    const view = transcripts.laneView(SMART);
    const segments = view.generations.flatMap((generation) => generation.segments);
    assert.equal(segments.length, 1, `${state} did not create exactly one row`);
    assert.equal(segments[0].state, state);
    assert.equal(view.failures.length, 1, `${state} is not counted as a failure`);
    assert.equal(view.failures[0].note, `${state}_before_any_audio`);
    assert.equal(view.status.state, state);
    // `current` is empty here because no generation was ever started, so the
    // row lives in generations/failures. A reader counting failures still sees
    // it; a reader counting only `current` would not.
    assert.deepEqual(view.current, []);
  }
});

test("a finished lane is never given a spurious failure row", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "All done." });
  const changed = transcripts.resolveOpenSegments(SMART, "finalized", { detail: "audio_complete" });

  assert.equal(changed, 0);
  const view = transcripts.laneView(SMART);
  assert.equal(view.current.length, 1);
  assert.deepEqual(view.failures, []);
});

test("resolving an open segment as finalized promotes its hypothesis rather than losing it", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "interim", text: "the last words" });
  transcripts.resolveOpenSegments(SMART, "finalized", { detail: "audio_complete" });

  const view = transcripts.laneView(SMART);
  assert.equal(view.current[0].state, "finalized");
  assert.equal(view.current[0].text, "the last words");
  assert.equal(view.finalizedText, "the last words");
});

test("an unknown terminal state is refused instead of being written to a segment", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  assert.throws(() => transcripts.resolveOpenSegments(SMART, "probably_fine"), /Unknown segment state/);
  assert.throws(() => transcripts.resolveOpenSegments(SMART, ""), /Unknown segment state/);
  assert.ok(SEGMENT_STATES.includes("manually_reviewed"), "a human review state must exist and be distinct");
  assert.deepEqual(
    [...SEGMENT_STATES],
    ["pending", "provisional", "finalized", "unavailable", "timed_out", "cancelled", "manually_reviewed"],
  );
});

test("a human review is recorded beside the machine text without changing it", () => {
  const transcripts = store();
  transcripts.startGeneration(SMART);
  transcripts.applyEvent({ laneId: SMART, kind: "final", text: "Machine words." });
  const segmentId = transcripts.laneView(SMART).current[0].id;

  const review = transcripts.reviewSegment(SMART, segmentId, { score: 3, comment: "dropped the plan name", failureReason: "omission" });
  assert.equal(review.score, 3);
  assert.equal(review.failureReason, "omission");
  assert.equal(transcripts.laneView(SMART).current[0].text, "Machine words.", "a review must never edit machine text");
  assert.equal(transcripts.reviewSegment(SMART, "no-such-segment", { score: 1 }), null);
});

// ---------------------------------------------------------------------------
// 7. Alignment
// ---------------------------------------------------------------------------

test("segments may only be paired after an exact same-input alignment is declared", () => {
  const transcripts = store();
  assert.equal(transcripts.alignment.quality, ALIGNMENT_QUALITY.none);
  assert.equal(transcripts.canPairSegments(), false);
  assert.equal(transcripts.snapshot().pairingAllowed, false);

  transcripts.declareAlignment(ALIGNMENT_QUALITY.approximate, { note: "live streams" });
  assert.equal(transcripts.canPairSegments(), false, "two independent streams may not be paired");

  transcripts.declareAlignment(ALIGNMENT_QUALITY.none);
  assert.equal(transcripts.canPairSegments(), false);

  transcripts.declareAlignment(ALIGNMENT_QUALITY.exact, { key: "a".repeat(64), note: "clip hash" });
  assert.equal(transcripts.canPairSegments(), true);
  assert.equal(transcripts.alignment.key, "a".repeat(64));
  assert.equal(transcripts.snapshot().pairingAllowed, true);
});

test("an invented alignment quality degrades to not-established rather than unlocking pairing", () => {
  const transcripts = store();
  for (const claimed of ["exact", "same-input", true, 1, null, undefined, { quality: ALIGNMENT_QUALITY.exact }]) {
    const declared = transcripts.declareAlignment(claimed, { key: "x" });
    assert.equal(declared.quality, ALIGNMENT_QUALITY.none, `${String(claimed)} was accepted`);
    assert.equal(transcripts.canPairSegments(), false);
  }
});

test("the alignment getter hands back a copy that cannot be edited into a pairing claim", () => {
  const transcripts = store();
  transcripts.declareAlignment(ALIGNMENT_QUALITY.approximate, { note: "live" });
  const snooped = transcripts.alignment;
  snooped.quality = ALIGNMENT_QUALITY.exact;
  assert.equal(transcripts.canPairSegments(), false);
  assert.equal(transcripts.alignment.quality, ALIGNMENT_QUALITY.approximate);
});

test("the snapshot always carries the caveat that a lane difference is not proof of correctness", () => {
  const transcripts = store();
  const snapshot = transcripts.snapshot();
  assert.match(snapshot.note, /differences between machine outputs/);
  assert.ok(!/confiden|accura|% correct/i.test(snapshot.note), "no fabricated confidence claim");

  assert.deepEqual([...LANE_IDS], ["voice-core-raw", "dedicated-verbatim", "dedicated-smart"]);
  assert.equal(LANE_DEFINITIONS[RAW].label, "Original machine transcript");
  assert.equal(LANE_DEFINITIONS[VERBATIM].label, "Original machine transcript");
  assert.equal(LANE_DEFINITIONS[SMART].label, "Readable transcript — machine edited");
  for (const laneId of LANE_IDS) {
    assert.equal(LANE_DEFINITIONS[laneId].authority, "display-only");
    assert.ok(!/what the agent understood/i.test(JSON.stringify(LANE_DEFINITIONS[laneId])));
  }
});

// ---------------------------------------------------------------------------
// 8. readTranscriptionEvents against real provider message shapes
// ---------------------------------------------------------------------------

test("an interim-only provider message yields one interim event", () => {
  assert.deepEqual(readTranscriptionEvents(interimMessage("the charge on my")), [
    { kind: "interim", text: "the charge on my" },
  ]);
});

test("a final-only provider message yields one final event", () => {
  assert.deepEqual(readTranscriptionEvents(finalMessage("The charge on my bill.")), [
    { kind: "final", text: "The charge on my bill." },
  ]);
});

test("a message carrying both transcription fields yields both events, interim first", () => {
  const events = readTranscriptionEvents({
    serverContent: {
      interimInputTranscription: { text: "and the plan" },
      inputTranscription: { text: "And the plan change." },
    },
  });
  assert.equal(events.length, 2, "neither field may be discarded because the other matched");
  assert.deepEqual(events, [
    { kind: "interim", text: "and the plan" },
    { kind: "final", text: "And the plan change." },
  ]);
});

test("an empty, absent or malformed transcription payload yields no events and never throws", () => {
  const nothing = [
    null,
    undefined,
    {},
    "a string",
    42,
    [],
    { serverContent: null },
    { serverContent: "not an object" },
    { serverContent: {} },
    { serverContent: { inputTranscription: null } },
    { serverContent: { inputTranscription: {} } },
    { serverContent: { inputTranscription: { text: "" } } },
    { serverContent: { interimInputTranscription: { text: "" } } },
    { serverContent: { inputTranscription: { text: 18 } } },
    { serverContent: { interimInputTranscription: "the charge" } },
    { serverContent: { turnComplete: true, modelTurn: { parts: [{ text: "agent speech" }] } } },
    { serverContent: { outputTranscription: { text: "what the agent said" } } },
    { setupComplete: {} },
    { toolCall: { functionCalls: [{ name: "submit_billing_request" }] } },
  ];
  for (const message of nothing) {
    assert.deepEqual(readTranscriptionEvents(message), [], `${JSON.stringify(message)} produced events`);
  }
});

test("the output transcription of the agent's own speech is never read as caller input", () => {
  const events = readTranscriptionEvents({
    serverContent: {
      outputTranscription: { text: "I can send that to Billing." },
      inputTranscription: { text: "Yes please." },
    },
  });
  assert.deepEqual(events, [{ kind: "final", text: "Yes please." }]);
});

// ---------------------------------------------------------------------------
// 9. The transcriber, driven entirely by fakes
// ---------------------------------------------------------------------------

test("the happy path sends audio, files an interim then a final, and ends complete", async () => {
  const h = harness();
  const started = await h.transcriber.start();

  assert.deepEqual(started, { ok: true, generation: 0, model: "gemini-3.5-transcribe-live", mode: "VERBATIM" });
  assert.equal(h.transcriber.state, "listening");

  assert.deepEqual(h.transcriber.pushAudio(new Uint8Array(320)), { accepted: true, queueDepth: 1 });
  await h.timers.advance(40);
  assert.equal(h.transcriber.queueDepth, 0, "the drain loop must empty the queue");
  assert.equal(h.sessions[0].session.sent.length, 1);
  assert.equal(h.sessions[0].session.sent[0].audio.mimeType, TARGET_MIME_TYPE);
  assert.equal(typeof h.sessions[0].session.sent[0].audio.data, "string");

  h.sessions[0].callbacks.onmessage(interimMessage("the charge on my"));
  const ending = h.transcriber.endAudio({ graceMs: 200 });
  await h.timers.advance(40);
  h.sessions[0].callbacks.onmessage(finalMessage("The charge on my bill."));
  await h.timers.advance(200);
  const result = await ending;

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.endToFinalMs, 40);
  assert.deepEqual(h.sessions[0].session.sent.at(-1), { audioStreamEnd: true });

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "complete");
  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].state, "finalized");
  assert.equal(view.finalizedText, "The charge on my bill.");
  assert.equal(view.unresolved, 0);
  assert.deepEqual(view.failures, []);
});

test("a refused credential resolves rather than throwing, and ends the lane unavailable", async () => {
  const refusal = new Error("transcription is switched off");
  refusal.code = "transcription_disabled";
  const h = harness({ requestToken: async () => { throw refusal; } });

  const result = await h.transcriber.start();

  assert.equal(result.ok, false, "a refused credential must never reject into the caller");
  assert.equal(result.reason, "transcription_disabled");
  assert.equal(h.transcriber.state, "unavailable");
  assert.equal(h.sessions.length, 0, "no connection may be attempted without a credential");

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "unavailable");
  assert.equal(view.failures.length, 1, "the refusal must stay in the denominator");
  assert.equal(view.failures[0].state, "unavailable");
  assert.equal(view.unresolved, 0);
});

test("a connection that never opens times out on our own clock and ends the lane unavailable", async () => {
  const h = harness({ connect: () => new Promise(() => {}) });

  const started = h.transcriber.start();
  await flush();
  await h.timers.advance(150);
  const result = await started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, "connect_timeout");
  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "unavailable");
  assert.equal(view.failures[0].note, "connect_timeout");
  assert.equal(h.timers.pendingTimers, 0, "a timed-out attempt must leave no timer behind");
});

test("a connection that rejects is reported as a failed connect, not as silence", async () => {
  const h = harness({ connect: async () => { throw new Error("websocket refused"); } });
  const result = await h.transcriber.start();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "connect_failed");
  assert.equal(h.store.laneView(VERBATIM).failures[0].state, "unavailable");
  assert.equal(h.transcriber.report().errors.at(-1).area, "transcription-connect");
});

test("no final inside the grace period ends the lane timed out with its partial kept", async () => {
  const h = harness();
  await h.transcriber.start();
  h.transcriber.pushAudio(new Uint8Array(320));
  await h.timers.advance(40);
  h.sessions[0].callbacks.onmessage(interimMessage("partial words that never finished"));

  const ending = h.transcriber.endAudio({ graceMs: 200 });
  await h.timers.advance(600);
  const result = await ending;

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.graceMs, 200);
  assert.equal(result.endToFinalMs, null);

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "timed_out");
  assert.equal(view.current[0].state, "timed_out");
  assert.equal(view.current[0].interimText, "partial words that never finished", "the partial must not be discarded");
  assert.equal(view.failures.length, 1);
  assert.equal(view.finalizedText, "", "a timed-out run must not report a finalized transcript");
});

test("a bounded queue stops the helper instead of growing, and says the run is degraded", async () => {
  const h = harness({ limits: { maxQueuedChunks: 4 } });
  await h.transcriber.start();

  // The consumer is stalled: the drain loop is parked on a timer we do not
  // advance, so every push lands in the queue.
  const outcomes = [];
  for (let index = 0; index < 200; index += 1) outcomes.push(h.transcriber.pushAudio(new Uint8Array(3200)));

  assert.equal(outcomes.filter((outcome) => outcome.accepted).length, 4, "the queue must never exceed its cap");
  assert.equal(outcomes[4].reason, "queue_overflow");
  assert.equal(outcomes.at(-1).reason, "not_running", "the helper must stay stopped, not keep accepting");

  assert.equal(h.transcriber.queueDepth, 0, "the queue must be released, not held");
  assert.equal(h.transcriber.report().queueHighWaterMark, 4);
  assert.equal(h.transcriber.state, "degraded");
  assert.equal(h.timers.pendingTimers, 0, "a stopped helper must leave no timer running");
  assert.ok(kinds(h.metrics).includes("queue_overflow"));
  assert.ok(kinds(h.metrics).includes("terminated"));

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "degraded");
  assert.equal(view.failures.length, 1, "a dropped-audio run must be a visible failure, not a gappy transcript");
  assert.equal(view.failures[0].state, "timed_out");
  assert.equal(view.failures[0].note, "queue_overflow_helper_stopped");

  await h.timers.advance(500);
  assert.equal(h.transcriber.queueDepth, 0, "nothing may restart the drain loop after an overflow");
});

test("a message from the previous session object is ignored after a reconnect", async () => {
  const h = harness();
  await h.transcriber.start();
  const stale = h.sessions[0].callbacks;
  h.transcriber.stop({ reason: "reconnecting" });
  await h.transcriber.start();
  assert.equal(h.transcriber.generation, 1);

  const before = JSON.stringify(h.store.laneView(VERBATIM));
  h.metrics.length = 0;
  stale.onmessage(finalMessage("Words from the socket that already closed."));
  const after = JSON.stringify(h.store.laneView(VERBATIM));

  assert.deepEqual(kinds(h.metrics), ["stale_message_ignored"]);
  assert.equal(h.metrics[0].messageGeneration, 0);
  assert.equal(h.metrics[0].generation, 1);
  assert.equal(after, before, "a stale message must not change the store at all");
  assert.ok(!after.includes("already closed"));
});

test("the live session's own messages are still accepted after a reconnect", async () => {
  const h = harness();
  await h.transcriber.start();
  h.transcriber.stop({ reason: "reconnecting" });
  await h.transcriber.start();

  h.sessions[1].callbacks.onmessage(finalMessage("The current socket still works."));
  const view = h.store.laneView(VERBATIM);
  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].text, "The current socket still works.");
  assert.equal(view.current[0].generation, 1);
  assert.equal(view.generations[1].precededByGap, true, "the reconnect must still be shown as a break");
});

test("malformed provider messages neither throw nor create segments", async () => {
  const h = harness();
  await h.transcriber.start();
  const { onmessage } = h.sessions[0].callbacks;

  const garbage = [
    null, undefined, 0, "", "text", [], {}, { serverContent: null }, { serverContent: [] },
    { serverContent: { inputTranscription: { text: null } } },
    { serverContent: { interimInputTranscription: { notText: "x" } } },
    { serverContent: { inputTranscription: [{ text: "x" }] } },
    { serverContent: { toolCall: { functionCalls: [{ name: "submit_billing_request", args: { phase: "commit" } }] } } },
  ];
  for (const message of garbage) {
    assert.doesNotThrow(() => onmessage(message), `threw on ${JSON.stringify(message)}`);
  }

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.current.length, 0, "garbage must not open a segment");
  assert.equal(view.finalizedText, "");
  assert.equal(h.transcriber.state, "listening", "garbage must not tear down a working lane");
  assert.ok(!kinds(h.metrics).includes("terminated"));
});

test("a usage payload is reported as a metric and never as transcript text", async () => {
  const h = harness();
  await h.transcriber.start();
  h.sessions[0].callbacks.onmessage({ usageMetadata: { totalTokenCount: 40 } });

  assert.ok(kinds(h.metrics).includes("usage"));
  assert.equal(h.store.laneView(VERBATIM).current.length, 0);
  assert.equal(h.transcriber.report().usageKnown, false, "per-lane usage may not be claimed as known");
});

test("stop is idempotent, clears the queue and leaves the lane cancelled", async () => {
  const h = harness();
  await h.transcriber.start();
  h.transcriber.pushAudio(new Uint8Array(320));
  h.transcriber.pushAudio(new Uint8Array(320));
  assert.equal(h.transcriber.queueDepth, 2);

  assert.deepEqual(h.transcriber.stop(), { ok: true });
  assert.equal(h.transcriber.queueDepth, 0, "stopping must release the queued audio");
  assert.deepEqual(h.transcriber.stop(), { ok: true, alreadyStopped: true });
  assert.deepEqual(h.transcriber.stop({ reason: "again" }), { ok: true, alreadyStopped: true });
  assert.equal(h.sessions[0].session.closeCalls, 1, "the session must be closed exactly once");
  assert.equal(h.timers.pendingTimers, 0);

  const view = h.store.laneView(VERBATIM);
  assert.equal(view.status.state, "stopped");
  assert.equal(view.current[0].state, "cancelled");
  assert.equal(view.failures[0].state, "cancelled");

  assert.deepEqual(h.transcriber.pushAudio(new Uint8Array(8)), { accepted: false, reason: "not_running" });
  assert.deepEqual(await h.transcriber.endAudio(), { ok: false, reason: "not_running" });
});

test("pushAudio refuses anything that is not a non-empty byte array, without throwing", async () => {
  const h = harness();
  await h.transcriber.start();
  for (const bad of [null, undefined, "audio", 42, [], {}, new Uint8Array(0), new Int16Array(8), new ArrayBuffer(8)]) {
    const outcome = h.transcriber.pushAudio(bad);
    assert.equal(outcome.accepted, false, `${String(bad)} was accepted`);
  }
  assert.equal(h.transcriber.queueDepth, 0);
  assert.equal(h.transcriber.state, "listening");
});

test("pushed audio is copied so the voice core can reuse its own buffer", async () => {
  const h = harness();
  await h.transcriber.start();
  const scratch = new Uint8Array([1, 2, 3, 4]);
  h.transcriber.pushAudio(scratch);
  scratch.fill(9);
  await h.timers.advance(40);

  const sent = Buffer.from(h.sessions[0].session.sent[0].audio.data, "base64");
  assert.deepEqual([...sent], [1, 2, 3, 4], "the helper sent the caller's later mutation");
});

test("a second start while running is refused instead of opening a parallel session", async () => {
  const h = harness();
  await h.transcriber.start();
  const second = await h.transcriber.start();
  assert.deepEqual(second, { ok: false, reason: "already_running" });
  assert.equal(h.sessions.length, 1);
  assert.equal(h.transcriber.generation, 0);
});

test("our own session ceiling ends the lane timed out before the provider cuts us off", async () => {
  const h = harness({ limits: { maxSessionSeconds: 1 } });
  await h.transcriber.start();
  await h.timers.advance(1200);

  assert.equal(h.transcriber.state, "timed_out");
  const view = h.store.laneView(VERBATIM);
  assert.equal(view.failures[0].note, "session_duration_cap");
  assert.ok(TRANSCRIBER_DEFAULTS.maxSessionSeconds < 600, "our cap must sit below the provider's ten minutes");
});

test("a provider close mid-run ends the lane unavailable rather than looking finished", async () => {
  const h = harness();
  await h.transcriber.start();
  h.sessions[0].callbacks.onclose({ reason: "quota exhausted" });

  assert.equal(h.transcriber.state, "disconnected");
  const view = h.store.laneView(VERBATIM);
  assert.equal(view.failures.length, 1);
  assert.equal(view.failures[0].state, "unavailable");
  assert.equal(view.failures[0].note, "quota exhausted");
});

test("a send failure ends the lane unavailable instead of continuing with holes in it", async () => {
  const h = harness({
    connect: async ({ callbacks }) => {
      const session = {
        sendRealtimeInput() { throw new Error("socket already gone"); },
        close() {},
      };
      callbacks.onopen?.();
      return session;
    },
  });
  await h.transcriber.start();
  h.transcriber.pushAudio(new Uint8Array(320));
  await h.timers.advance(60);

  assert.equal(h.transcriber.state, "unavailable");
  assert.equal(h.store.laneView(VERBATIM).failures[0].note, "send_failed");
  assert.equal(h.transcriber.report().errors.at(-1).area, "transcription-send");
});

test("the report never echoes a credential and never carries audio", async () => {
  const h = harness();
  await h.transcriber.start();
  h.transcriber.pushAudio(new Uint8Array(3200));
  await h.timers.advance(40);
  h.sessions[0].callbacks.onmessage(finalMessage("Some words."));

  const report = h.transcriber.report();
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes("fake-token-for-tests"), "the report echoed the credential");
  assert.ok(!Object.hasOwn(report, "token") && !Object.hasOwn(report, "apiKey") && !Object.hasOwn(report, "value"));
  assert.ok(!serialised.includes("Some words."), "the report must not carry transcript text");
  assert.equal(report.chunksSent, 1);
  assert.equal(report.audioSecondsSent, 0.1);
  assert.equal(report.endToFinalPrecision, "wall-clock-from-known-last-sample-to-actual-receipt");
});

test("an error message is truncated and never carries a stack or a credential", async () => {
  const long = new Error("x".repeat(900));
  const h = harness({ requestToken: async () => { throw long; } });
  await h.transcriber.start();

  const [entry] = h.transcriber.report().errors;
  assert.equal(entry.message.length, 300);
  assert.ok(!Object.hasOwn(entry, "stack"));
});

// ---------------------------------------------------------------------------
// 10. audio-normalize
// ---------------------------------------------------------------------------

test("downsampling a known ramp box-averages each source pair", () => {
  const ramp = new Float32Array(100);
  for (let index = 0; index < 100; index += 1) ramp[index] = index;

  const output = resampleTo16k(ramp, 32000);
  assert.equal(output.length, 50);
  assert.equal(output[0], 0.5);
  assert.equal(output[1], 2.5);
  assert.equal(output[49], 98.5);
  for (let index = 0; index < output.length; index += 1) {
    assert.equal(output[index], 2 * index + 0.5, `sample ${index} is not the mean of its source pair`);
  }
});

test("audio already at the target rate is passed through untouched", () => {
  const samples = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(resampleTo16k(samples, TARGET_SAMPLE_RATE), samples, "the same buffer must come back, not a copy");
  assert.equal(TARGET_SAMPLE_RATE, 16000);
});

// FAILS: for sourceRate < 16000 the box-average window is shorter than one
// output sample, so every other output frame divides an empty window and comes
// back as zero. An 8 kHz clip is upsampled into an alternating zero pattern.
test("upsampling a lower-rate clip does not zero out every other sample", () => {
  const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const output = resampleTo16k(input, 8000);

  assert.equal(output.length, 8);
  const zeros = [...output].filter((sample) => sample === 0).length;
  assert.equal(zeros, 0, `upsampling produced ${zeros} zeroed samples: ${JSON.stringify([...output])}`);
});

test("resampling refuses a non-Float32Array and a non-positive rate", () => {
  assert.throws(() => resampleTo16k([0.1, 0.2], 32000), TypeError);
  assert.throws(() => resampleTo16k(new Float32Array(4), 0), RangeError);
  assert.throws(() => resampleTo16k(new Float32Array(4), -48000), RangeError);
  assert.throws(() => resampleTo16k(new Float32Array(4), NaN), RangeError);
});

test("float samples are clamped at plus and minus one and written little-endian", () => {
  const bytes = floatToPcm16(new Float32Array([1, -1, 2, -2, 0, 0.5, -0.5, NaN, Infinity, -Infinity]));
  assert.equal(bytes.byteLength, 20);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = [];
  for (let index = 0; index < bytes.byteLength / 2; index += 1) samples.push(view.getInt16(index * 2, true));
  assert.deepEqual(samples, [32767, -32768, 32767, -32768, 0, 16383, -16384, 0, 32767, -32768]);

  // Pin the byte order itself: the provider requires little-endian.
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0x7f);
  assert.throws(() => floatToPcm16([0.1]), TypeError);
});

test("chunking a non-multiple length gives a full run plus an exact short tail", () => {
  const chunks = chunkPcm16(new Uint8Array(3500));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, FRAMES_PER_CHUNK * 2);
  assert.equal(chunks[0].byteLength, 3200);
  assert.equal(chunks[1].byteLength, 300, "the tail must be the exact remainder");
  assert.equal(chunks.reduce((total, chunk) => total + chunk.byteLength, 0), 3500);
});

test("chunking an exact multiple gives no trailing empty chunk", () => {
  const chunks = chunkPcm16(new Uint8Array(6400));
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [3200, 3200]);
  assert.deepEqual(chunkPcm16(new Uint8Array(0)), []);
  assert.equal(chunkPcm16(new Uint8Array(1)).length, 1);
  assert.equal(chunkPcm16(new Uint8Array(1))[0].byteLength, 1);
});

test("each chunk is an independent copy of its slice of the source", () => {
  const source = new Uint8Array(8).fill(7);
  const chunks = chunkPcm16(source, 2);
  assert.equal(chunks.length, 2);
  chunks[0].fill(1);
  assert.deepEqual([...source], [7, 7, 7, 7, 7, 7, 7, 7], "a chunk aliases the source buffer");
  assert.throws(() => chunkPcm16(null), TypeError);
  assert.throws(() => chunkPcm16("bytes"), TypeError);
});

test("pcm duration is derived from byte length and sample rate", () => {
  assert.equal(pcm16DurationSeconds(new Uint8Array(32000)), 1);
  assert.equal(pcm16DurationSeconds(new Uint8Array(16000)), 0.5);
  assert.equal(pcm16DurationSeconds(new Uint8Array(32000), 8000), 2);
  assert.equal(pcm16DurationSeconds(new Uint8Array(0)), 0);
  assert.equal(pcm16DurationSeconds(null), 0);
  assert.equal(pcm16DurationSeconds(new Int16Array(8)), 16 / 2 / 16000);
});

test("base64 encoding round-trips every byte value", () => {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) bytes[index] = index;
  const encoded = bytesToBase64(bytes);
  assert.equal(typeof encoded, "string");
  assert.deepEqual([...Buffer.from(encoded, "base64")], [...bytes]);
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
  assert.equal(bytesToBase64(new Uint8Array([0, 255, 128]).buffer), bytesToBase64(new Uint8Array([0, 255, 128])));
});

test("the clip hash is stable and changes when a single sample changes", async () => {
  const bytes = floatToPcm16(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  const first = await sha256Hex(bytes);
  const second = await sha256Hex(bytes.slice());

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second, "the same bytes must hash the same way");
  assert.equal(await sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  const nudged = floatToPcm16(new Float32Array([0.1, 0.2, 0.3, 0.4001]));
  assert.notEqual(await sha256Hex(nudged), first, "a one-sample change must change the clip identity");
});

test("a clip hash is taken over the offered bytes only, not the whole backing buffer", async () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
  const window = backing.subarray(2, 6);
  assert.equal(await sha256Hex(window), await sha256Hex(new Uint8Array([1, 2, 3, 4])));
});

test("a file that is empty, oversize or not audio is refused before decoding", () => {
  const empty = validateClipFile({ name: "clip.wav", size: 0, type: "audio/wav" });
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.some((problem) => /empty/i.test(problem)));

  const oversize = validateClipFile({ name: "clip.wav", size: CLIP_LIMITS.maxBytes + 1, type: "audio/wav" });
  assert.equal(oversize.ok, false);
  assert.ok(oversize.problems.some((problem) => /larger than the 8 MB limit/.test(problem)));

  const notAudio = validateClipFile({ name: "notes.txt", size: 1024, type: "text/plain" });
  assert.equal(notAudio.ok, false);
  assert.ok(notAudio.problems.some((problem) => /does not look like an audio file/.test(problem)));

  assert.equal(validateClipFile().ok, false);
  assert.equal(validateClipFile({ name: "clip.wav", size: NaN, type: "audio/wav" }).ok, false);
});

test("an ordinary audio file passes the pre-decode gate and reports what it saw", () => {
  const ok = validateClipFile({ name: "Caller Clip.WAV", size: 240000, type: "audio/wav" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.extension, ".wav", "the extension check must be case-insensitive");
  assert.equal(ok.declaredType, "audio/wav");
  assert.equal(ok.sizeBytes, 240000);

  assert.equal(validateClipFile({ name: "clip", size: 1000, type: "audio/mpeg" }).ok, true, "a declared audio type is enough");
  // Either signal is enough on its own; the browser decoder is the real gate,
  // and validateDecodedClip is the second one.
  assert.equal(validateClipFile({ name: "clip.mp3", size: 1000, type: "" }).ok, true);
  assert.equal(validateClipFile({ name: "clip.exe", size: 1000, type: "application/x-msdownload" }).ok, false);
});

test("a decoded clip that is too long, too short or unreadable is refused", () => {
  const long = validateDecodedClip({ durationSeconds: 30.5, sampleRate: 48000, channels: 2 });
  assert.equal(long.ok, false);
  assert.ok(long.problems.some((problem) => /over the 30 s cap/.test(problem)));

  const silentFile = validateDecodedClip({ durationSeconds: 0, sampleRate: 48000, channels: 1 });
  assert.equal(silentFile.ok, false);
  assert.ok(silentFile.problems.some((problem) => /decoded to no audio/.test(problem)));

  assert.equal(validateDecodedClip({ durationSeconds: 0.1, sampleRate: 48000, channels: 1 }).ok, false);
  assert.equal(validateDecodedClip({ durationSeconds: 5, sampleRate: 0, channels: 1 }).ok, false);
  assert.equal(validateDecodedClip({ durationSeconds: 5, sampleRate: 48000, channels: 0 }).ok, false);
  assert.equal(validateDecodedClip({ durationSeconds: -3, sampleRate: 48000, channels: 1 }).ok, false);
  assert.equal(validateDecodedClip().ok, false);

  assert.equal(validateDecodedClip({ durationSeconds: 30, sampleRate: 48000, channels: 2 }).ok, true);
  assert.equal(validateDecodedClip({ durationSeconds: CLIP_LIMITS.minSeconds, sampleRate: 16000, channels: 1 }).ok, true);
});

test("channels are averaged, not summed, so a stereo mixdown cannot clip", () => {
  const left = new Float32Array([1, 0.5, -1]);
  const right = new Float32Array([1, -0.5, -1]);
  assert.deepEqual([...mixToMono([left, right])], [1, 0, -1]);
  assert.equal(mixToMono([left]), left, "a mono clip is passed through");
  assert.deepEqual([...mixToMono([])], []);
  assert.deepEqual([...mixToMono(null)], []);
  assert.equal(mixToMono([new Float32Array([1, 2, 3]), new Float32Array([1])]).length, 1, "the shorter channel bounds the mix");
});

test("normalizeClip produces the documented format, a byte length of frames times two, and its own hash", async () => {
  const left = new Float32Array(3200);
  const right = new Float32Array(3200);
  for (let index = 0; index < 3200; index += 1) {
    left[index] = Math.sin(index / 20);
    right[index] = Math.sin(index / 20) * 0.5;
  }

  const clip = await normalizeClip([left, right], 32000);

  assert.equal(clip.sampleRate, 16000);
  assert.equal(clip.mimeType, "audio/pcm;rate=16000");
  assert.equal(clip.mimeType, TARGET_MIME_TYPE);
  assert.equal(clip.channels, 1);
  assert.equal(clip.sourceSampleRate, 32000);
  assert.equal(clip.sourceChannels, 2);
  assert.equal(clip.frames, 1600, "32 kHz halved must give half the frames");
  assert.equal(clip.byteLength, clip.frames * 2);
  assert.equal(clip.bytes.byteLength, clip.frames * 2);
  assert.equal(clip.durationSeconds, clip.frames / 16000);
  assert.equal(clip.durationSeconds, 0.1);
  assert.equal(clip.hash, await sha256Hex(clip.bytes), "the hash must be of the bytes actually handed out");
  assert.match(clip.hash, /^[0-9a-f]{64}$/);
  assert.equal(pcm16DurationSeconds(clip.bytes), clip.durationSeconds);
  assert.equal(chunkPcm16(clip.bytes).length, 1, "a 100 ms clip is exactly one chunk");
});

test("the same decoded audio normalizes to the same hash every time, so lanes share one input", async () => {
  const build = () => {
    const channel = new Float32Array(800);
    for (let index = 0; index < 800; index += 1) channel[index] = Math.sin(index / 7);
    return channel;
  };
  const first = await normalizeClip([build()], 48000);
  const second = await normalizeClip([build()], 48000);

  assert.equal(first.hash, second.hash);
  assert.deepEqual([...first.bytes], [...second.bytes]);

  const different = await normalizeClip([build()], 44100);
  assert.notEqual(different.hash, first.hash, "a different source rate is a different normalised clip");
});
