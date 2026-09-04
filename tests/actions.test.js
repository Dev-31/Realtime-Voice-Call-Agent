import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { getAccountContext, prepareAction, commitAction, submitBillingRequest } from "../server/tools.js";

const CUSTOMER = "CUS-002"; // Akash, Premium, with an 18 rupee disputed charge.
const CALL = "call-under-test";

function fresh() {
  return openDatabase(":memory:");
}

function heard(audibleChunks = 3) {
  return { known: true, audibleChunks, state: audibleChunks ? "completed" : "interrupted" };
}

function prepareReview(db, { turn = "turn-1", key = "call-a", amount = 18 } = {}) {
  return prepareAction(db, {
    customerId: CUSTOMER,
    requestType: "refund_review",
    amount,
    preparationKey: key,
    conversationId: CALL,
    customerTurnId: turn,
    customerTranscript: "send only the charge to billing for review",
  });
}

function commit(db, intentId, { turn = "turn-2", evidence = heard() } = {}) {
  return commitAction(db, {
    customerId: CUSTOMER,
    intentId,
    requestType: "refund_review",
    conversationId: CALL,
    customerTurnId: turn,
    customerTranscript: "yes please do that",
    confirmationPromptEpochId: "epoch-confirm",
  }, { heardEvidence: evidence });
}

function counts(db) {
  return {
    reviews: db.prepare("SELECT COUNT(*) AS n FROM service_requests").get().n,
    planChanges: db.prepare("SELECT COUNT(*) AS n FROM plan_changes").get().n,
    completedIntents: db.prepare("SELECT COUNT(*) AS n FROM action_intents WHERE status = 'completed'").get().n,
  };
}

test("prepare creates a pending intent and mutates nothing", () => {
  const db = fresh();
  const prepared = prepareReview(db);

  assert.equal(prepared.status, "awaiting_confirmation");
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.confirmationRequired, true);
  assert.ok(prepared.intentId.startsWith("ACT-"));
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 0, completedIntents: 0 });
});

test("one confirmed request creates exactly one pending review and issues zero money", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  const committed = commit(db, prepared.intentId);

  assert.equal(committed.status, "completed");
  assert.equal(committed.exactlyOnce, true);
  assert.equal(committed.result.request.status, "pending_human_review");
  assert.equal(committed.result.request.amount, 18);
  assert.deepEqual(counts(db), { reviews: 1, planChanges: 0, completedIntents: 1 });

  const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'review_request_created'").get();
  assert.equal(JSON.parse(audit.metadata_json).moneyIssued, 0);
});

test("no confirmation means no action at all", () => {
  const db = fresh();
  prepareReview(db);
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 0, completedIntents: 0 });
});

test("the request turn cannot confirm itself", () => {
  const db = fresh();
  const prepared = prepareReview(db, { turn: "turn-1" });
  assert.throws(
    () => commit(db, prepared.intentId, { turn: "turn-1" }),
    (error) => error.code === "SAME_TURN_CONFIRMATION",
  );
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 0, completedIntents: 0 });
});

test("a confirmation question the caller never heard cannot be confirmed", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  assert.throws(
    () => commit(db, prepared.intentId, { evidence: { known: true, audibleChunks: 0, state: "interrupted" } }),
    (error) => error.code === "confirmation_prompt_not_heard",
  );
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 0, completedIntents: 0 });

  const blocked = db.prepare("SELECT * FROM hcr_ledger WHERE stage = 'confirmation_rejected'").get();
  assert.equal(blocked.state, "blocked");
});

test("missing playback evidence fails open but is recorded as unknown", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  const committed = commit(db, prepared.intentId, { evidence: { known: false, audibleChunks: 0, state: null } });

  assert.equal(committed.confirmationAudibility.code, "prompt_playback_unknown");
  assert.equal(counts(db).reviews, 1);
});

test("a spoken correction supersedes the stale request so it can never commit", () => {
  const db = fresh();
  const stale = prepareReview(db, { turn: "turn-1", key: "call-a", amount: 18 });

  // The caller corrects themselves: a plan change instead, prepared on a later turn.
  const corrected = prepareAction(db, {
    customerId: CUSTOMER,
    requestType: "plan_change",
    targetPlanId: "PLAN-BUSINESS",
    preparationKey: "call-b",
    conversationId: CALL,
    customerTurnId: "turn-2",
    customerTranscript: "actually move me to business",
  });

  assert.equal(corrected.supersededPendingRequests, 1);
  assert.throws(
    () => commit(db, stale.intentId, { turn: "turn-3" }),
    (error) => error.code === "SUPERSEDED_BY_CORRECTION",
  );
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 0, completedIntents: 0 });
});

test("a replayed provider tool call reuses the same intent instead of preparing twice", () => {
  const db = fresh();
  const first = prepareReview(db, { key: "same-call-id" });
  const replay = prepareReview(db, { key: "same-call-id" });

  assert.equal(replay.repeated, true);
  assert.equal(replay.intentId, first.intentId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM action_intents").get().n, 1);
});

test("a replayed commit returns the first result and executes nothing twice", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  const first = commit(db, prepared.intentId, { turn: "turn-2" });
  const replay = commit(db, prepared.intentId, { turn: "turn-3" });

  assert.equal(replay.repeated, true);
  assert.equal(replay.result.request.reference, first.result.request.reference);
  assert.deepEqual(counts(db), { reviews: 1, planChanges: 0, completedIntents: 1 });
});

test("an amount the account does not support is dropped, not passed through", () => {
  const db = fresh();
  const prepared = prepareReview(db, { amount: 9999 });

  assert.equal(prepared.request.amount, null);
  assert.equal(prepared.request.amountEvidence, "dropped_unsupported");

  const committed = commit(db, prepared.intentId);
  assert.equal(committed.result.request.amount, null);
});

test("a refund review never touches money or the plan", () => {
  const db = fresh();
  const before = getAccountContext(db, CUSTOMER);
  const prepared = prepareReview(db);
  commit(db, prepared.intentId);
  const after = getAccountContext(db, CUSTOMER);

  assert.equal(after.account.currentPlan.id, before.account.currentPlan.id);
  assert.equal(after.latestBill.amount, before.latestBill.amount);
  assert.equal(counts(db).planChanges, 0);
});

test("a confirmed plan change executes once and verifies against the account", () => {
  const db = fresh();
  const prepared = prepareAction(db, {
    customerId: CUSTOMER,
    requestType: "plan_change",
    targetPlanId: "PLAN-BUSINESS",
    preparationKey: "plan-call",
    conversationId: CALL,
    customerTurnId: "turn-1",
    customerTranscript: "move me up to business",
  });
  assert.equal(prepared.request.targetMonthlyPrice, 1299);

  const committed = commitAction(db, {
    customerId: CUSTOMER,
    intentId: prepared.intentId,
    conversationId: CALL,
    customerTurnId: "turn-2",
    customerTranscript: "yes that is right",
    confirmationPromptEpochId: "epoch-confirm",
  }, { heardEvidence: heard() });

  assert.equal(committed.result.verified, true);
  assert.equal(getAccountContext(db, CUSTOMER).account.currentPlan.id, "PLAN-BUSINESS");
  assert.deepEqual(counts(db), { reviews: 0, planChanges: 1, completedIntents: 1 });
});

test("an unknown plan is rejected before any intent exists", () => {
  const db = fresh();
  assert.throws(() => prepareAction(db, {
    customerId: CUSTOMER,
    requestType: "plan_change",
    targetPlanId: "PLAN-INVENTED",
    preparationKey: "bad-plan",
    conversationId: CALL,
    customerTurnId: "turn-1",
  }), /not an active plan/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM action_intents").get().n, 0);
});

test("an intent from another conversation cannot be committed", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  assert.throws(() => commitAction(db, {
    customerId: CUSTOMER,
    intentId: prepared.intentId,
    conversationId: "some-other-call",
    customerTurnId: "turn-2",
  }, { heardEvidence: heard() }), (error) => error.code === "UNKNOWN_INTENT");
});

test("an intent from another customer cannot be committed", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  assert.throws(() => commitAction(db, {
    customerId: "CUS-003",
    intentId: prepared.intentId,
    conversationId: CALL,
    customerTurnId: "turn-2",
  }, { heardEvidence: heard() }), (error) => error.code === "UNKNOWN_INTENT");
});

test("an expired intent cannot be committed", () => {
  const db = fresh();
  const prepared = prepareReview(db);
  db.prepare("UPDATE action_intents SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), prepared.intentId);

  assert.throws(() => commit(db, prepared.intentId), (error) => error.code === "INTENT_EXPIRED");
  assert.equal(counts(db).reviews, 0);
});

test("submitBillingRequest rejects an unknown phase", () => {
  const db = fresh();
  assert.throws(() => submitBillingRequest(db, { phase: "execute" }), /prepare or commit/);
});
