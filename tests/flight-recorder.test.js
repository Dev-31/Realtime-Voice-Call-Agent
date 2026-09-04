import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { coverageRatio, createFlightRecorder } from "../server/flight-recorder/index.js";
import { commitAction, prepareAction } from "../server/tools.js";

const CUSTOMER = "CUS-002";
const CALL = "call-flight-1";

function setup() {
  const db = openDatabase(":memory:");
  const recorder = createFlightRecorder(db, { enabled: true });
  return { db, recorder };
}

function heardStateEvent(epochId, state, audibleChunks, atMs, extra = {}) {
  return {
    type: "heard_state_transition",
    epochId,
    atMs,
    value: audibleChunks,
    detail: { epochId, state, audibleChunks, ...extra },
  };
}

test("coverageRatio measures how much of the unheard tail came back", () => {
  assert.equal(coverageRatio("", "anything"), null);
  assert.equal(coverageRatio("alpha bravo charlie", "alpha bravo charlie delta"), 1);
  assert.ok(coverageRatio("alpha bravo charlie delta", "alpha bravo") < 0.6);
});

test("ingest stores only known event types", () => {
  const { recorder } = setup();
  const result = recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      { type: "session_started", atMs: 0 },
      { type: "made_up_event", atMs: 1 },
      { type: "response_interrupted", atMs: 2, epochId: "e1", detail: {} },
    ],
  });
  assert.equal(result.accepted, 2);
  assert.equal(result.rejected, 1);
});

test("another customer cannot write into an existing call", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, { conversationId: CALL, events: [{ type: "session_started", atMs: 0 }] });
  assert.throws(
    () => recorder.ingest("CUS-003", { conversationId: CALL, events: [{ type: "error", atMs: 1 }] }),
    (error) => error.statusCode === 403,
  );
});

test("heardEvidence reports what actually played for one response", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      heardStateEvent("epoch-a", "speaking", 2, 100),
      heardStateEvent("epoch-a", "completed", 5, 200),
      heardStateEvent("epoch-b", "interrupted", 0, 300),
    ],
  });

  assert.deepEqual(
    { ...recorder.heardEvidence(CALL, "epoch-a") },
    { known: true, audibleChunks: 5, state: "completed", events: 2 },
  );
  const cutOff = recorder.heardEvidence(CALL, "epoch-b");
  assert.equal(cutOff.known, true);
  assert.equal(cutOff.audibleChunks, 0);
  assert.equal(recorder.heardEvidence(CALL, "epoch-missing").known, false);
  assert.equal(recorder.heardEvidence(CALL, "").reason, "no_epoch_supplied");
});

test("the report derives audible-stop and response latency from the timeline", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      { type: "session_started", atMs: 0 },
      { type: "response_audio_started", atMs: 500, epochId: "e1", durationMs: 900, detail: {} },
      {
        type: "response_interrupted",
        atMs: 2000,
        epochId: "e1",
        detail: { providerSignalMs: 230, playbackClearMs: 0.4, audibleStopMs: 231, audibleChunksBeforeStop: 4 },
      },
      { type: "response_audio_started", atMs: 3000, epochId: "e2", durationMs: 1400, detail: {} },
      { type: "session_ended", atMs: 9000, durationMs: 9000 },
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.metrics.responses, 2);
  assert.equal(report.metrics.response_latency_p50_ms, 900);
  assert.equal(report.metrics.response_latency_p95_ms, 1400);
  assert.equal(report.metrics.interruptions, 1);
  assert.equal(report.metrics.audible_stop_p95_ms, 231);
  assert.equal(report.metrics.playback_clear_p95_ms, 0.4);
  assert.equal(report.metrics.interruptions_before_any_audio, 0);
});

test("the report estimates whether an interrupted explanation was resumed", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      heardStateEvent("e1", "interrupted", 2, 1000, {
        draftedText: "Billing usually replies within two working days and the charge stays paused meanwhile",
        heardText: "Billing usually replies",
        unheardText: "within two working days and the charge stays paused meanwhile",
      }),
      heardStateEvent("e2", "completed", 6, 4000, {
        draftedText: "within two working days and the charge stays paused meanwhile, so nothing else is needed",
        heardText: "within two working days and the charge stays paused meanwhile, so nothing else is needed",
        unheardText: "",
      }),
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.metrics.interruption_outcomes_measured, 1);
  assert.equal(report.metrics.preserved_or_resumed, 1);
  assert.equal(report.interruption_outcomes[0].estimate, "preserved_or_resumed");
  assert.equal(report.interruption_outcomes[0].precision, "estimated-from-text-overlap");
});

test("the report flags a restart instead of a resume", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      heardStateEvent("e1", "interrupted", 2, 1000, {
        draftedText: "Hello, I am the billing assistant covering for Maya today. Your disputed charge is eighteen rupees.",
        heardText: "Hello, I am the billing assistant covering for Maya today.",
        unheardText: "Your disputed charge is eighteen rupees.",
      }),
      heardStateEvent("e2", "completed", 6, 4000, {
        draftedText: "Hello, I am the billing assistant covering for Maya today. How can I help?",
        heardText: "Hello, I am the billing assistant covering for Maya today. How can I help?",
        unheardText: "",
      }),
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.metrics.restarted_after_interruption, 1);
  assert.equal(report.metrics.preserved_or_resumed, 0);
});

test("the report reconciles its own action count against the database", () => {
  const { db, recorder } = setup();
  const prepared = prepareAction(db, {
    customerId: CUSTOMER,
    requestType: "refund_review",
    amount: 18,
    preparationKey: "call-x",
    conversationId: CALL,
    customerTurnId: "turn-1",
  });
  const committed = commitAction(db, {
    customerId: CUSTOMER,
    intentId: prepared.intentId,
    conversationId: CALL,
    customerTurnId: "turn-2",
    confirmationPromptEpochId: "epoch-confirm",
  }, { heardEvidence: { known: true, audibleChunks: 3, state: "completed" } });

  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      { type: "action_prepared", atMs: 1000, detail: { intentId: prepared.intentId, requestType: "refund_review" } },
      {
        type: "action_committed",
        atMs: 2000,
        detail: { intentId: committed.intentId, requestType: "refund_review", reference: committed.reference },
      },
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.metrics.actions_prepared, 1);
  assert.equal(report.metrics.actions_committed, 1);
  assert.deepEqual(report.database_match, {
    completed_intents: 1,
    database_executions: 1,
    unique_committed_intents_in_timeline: 1,
    duplicate_executions: 0,
    money_issued: 0,
    executions_match_intents: true,
    timeline_matches_database: true,
    matches: true,
  });
  assert.equal(report.database_state.review_requests.length, 1);
  assert.equal(report.database_state.plan_changes.length, 0);
});

test("the report stitches a readable transcript", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      { type: "input_transcript_received", atMs: 100, turnId: "t1", detail: { text: "Wait" } },
      { type: "input_transcript_received", atMs: 150, turnId: "t1", detail: { text: " - do not issue money." } },
      { type: "output_transcript_received", atMs: 900, epochId: "e1", detail: { text: "Understood." } },
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.transcript.length, 2);
  assert.equal(report.transcript[0].speaker, "customer");
  assert.equal(report.transcript[0].text, "Wait - do not issue money.");
  assert.equal(report.transcript[1].speaker, "twin");
});

test("an unrecorded call has no report", () => {
  const { recorder } = setup();
  assert.equal(recorder.report("never-happened"), null);
});

test("a resume is not mistaken for a reintroduction when the first reply has no drafted text", () => {
  const { recorder } = setup();
  recorder.ingest(CUSTOMER, {
    conversationId: CALL,
    events: [
      // Only the heard/unheard split reached the recorder for the first reply.
      heardStateEvent("e1", "interrupted", 7, 1000, {
        heardText: "I can send this to Billing",
        unheardText: "and they usually reply within two working days",
      }),
      heardStateEvent("e2", "completed", 12, 4000, {
        draftedText: "and they usually reply within two working days, so nothing else is needed from you",
        heardText: "and they usually reply within two working days, so nothing else is needed from you",
        unheardText: "",
      }),
    ],
  });

  const report = recorder.report(CALL);
  assert.equal(report.metrics.preserved_or_resumed, 1);
  assert.equal(report.metrics.suspected_reintroductions, 0);
  assert.equal(report.interruption_outcomes[0].reintroduction_coverage, null);
});
