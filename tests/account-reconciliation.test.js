import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { getAccountContext, prepareAction, commitAction } from "../server/tools.js";

const customerId = "CUS-002";
const conversationId = "account-reconciliation-test";

function change(db, targetPlanId, suffix) {
  const prepared = prepareAction(db, { customerId, conversationId, requestType: "plan_change",
    targetPlanId, preparationKey: `prepare-${suffix}`, customerTurnId: `request-${suffix}` });
  const input = { customerId, conversationId, intentId: prepared.intentId,
    customerTurnId: `confirm-${suffix}`, customerTranscript: "Please proceed with that change." };
  return { result: commitAction(db, input, { heardEvidence: { known: true, audibleChunks: 1 } }), input };
}

test("completed change supplies exact previous/new plan and fresh account state", () => {
  const db = openDatabase(":memory:");
  try {
    const { result } = change(db, "PLAN-ESSENTIAL", "first");
    assert.equal(result.planChangeSummary.fromPlan.name, "Premium");
    assert.equal(result.planChangeSummary.toPlan.name, "Essential");
    assert.equal(result.planChangeSummary.toPlan.monthlyPrice, 499);
    assert.equal(result.accountState.currentPlan.name, "Essential");
    assert.ok(result.accountState.planChangeSequence > 0);
    assert.match(result.reportingGuidance, /already completed/i);
    assert.equal(result.confirmationAudibility.code, "prompt_heard");
  } finally { db.close(); }
});

test("account clarification reads the completed change and never performs an undo", () => {
  const db = openDatabase(":memory:");
  try {
    change(db, "PLAN-ESSENTIAL", "first");
    const current = getAccountContext(db, customerId);
    assert.equal(current.account.currentPlan.name, "Essential");
    assert.equal(current.latestPlanChange.fromPlan.name, "Premium");
    assert.equal(current.latestPlanChange.toPlan.name, "Essential");
    assert.match(current.accountStateGuidance, /ask what outcome/i);
    assert.equal(db.prepare("SELECT count(*) n FROM plan_changes").get().n, 1);
  } finally { db.close(); }
});

test("replaying an older completed action reports history separately from current plan", () => {
  const db = openDatabase(":memory:");
  try {
    const first = change(db, "PLAN-ESSENTIAL", "first");
    const second = change(db, "PLAN-PREMIUM", "second");
    const replay = commitAction(db, first.input);
    assert.equal(replay.repeated, true);
    assert.equal(replay.planChangeSummary.toPlan.name, "Essential");
    assert.equal(replay.accountState.currentPlan.name, "Premium");
    assert.equal(replay.accountState.planChangeSequence, second.result.accountState.planChangeSequence);
    assert.match(replay.reportingGuidance, /not a new change/i);
    assert.equal(db.prepare("SELECT count(*) n FROM plan_changes").get().n, 2);
  } finally { db.close(); }
});

test("unchanged accounts have no invented completed plan change", () => {
  const db = openDatabase(":memory:");
  try {
    const current = getAccountContext(db, customerId);
    assert.equal(current.latestPlanChange, null);
    assert.equal(current.account.planChangeSequence, 0);
  } finally { db.close(); }
});

test("replayed change preserves agreed price while fresh account reflects catalogue update", () => {
  const db = openDatabase(":memory:");
  try {
    const first = change(db, "PLAN-ESSENTIAL", "first");
    db.prepare("UPDATE plans SET monthly_price = 549 WHERE id = 'PLAN-ESSENTIAL'").run();
    const replay = commitAction(db, first.input);
    assert.equal(replay.planChangeSummary.toPlan.monthlyPrice, 499);
    assert.equal(replay.accountState.currentPlan.monthlyPrice, 549);
  } finally { db.close(); }
});
