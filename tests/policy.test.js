import assert from "node:assert/strict";
import test from "node:test";
import { evaluateConfirmationAudibility, evaluatePolicy, policyMatrix } from "../server/policy.js";

test("the Twin has no money-movement authority anywhere in the matrix", () => {
  for (const rule of Object.values(policyMatrix())) {
    assert.notEqual(rule.moneyMovement, "issue_money");
  }
  assert.equal(evaluatePolicy("refund_payout").authorized, false);
  assert.equal(evaluatePolicy("refund_review").outcome, "create_review_request");
});

test("a plan change needs a confirmation flag before it is authorised", () => {
  assert.equal(evaluatePolicy("plan_change", { customerStatus: "active" }).outcome, "request_confirmation");
  assert.equal(evaluatePolicy("plan_change", { customerStatus: "active", confirmed: true }).authorized, true);
});

test("a non-active account never gets an automated action", () => {
  assert.equal(evaluatePolicy("plan_change", { customerStatus: "suspended", confirmed: true }).authorized, false);
  assert.equal(evaluatePolicy("refund_review", { customerStatus: "suspended" }).authorized, false);
});

test("an unknown action is rejected", () => {
  assert.equal(evaluatePolicy("wire_transfer").outcome, "reject");
});

test("confirmation audibility blocks only a question that was never heard", () => {
  assert.equal(evaluateConfirmationAudibility({ known: true, audibleChunks: 3 }).allowed, true);
  assert.equal(evaluateConfirmationAudibility({ known: true, audibleChunks: 0 }).allowed, false);
  assert.equal(
    evaluateConfirmationAudibility({ known: true, audibleChunks: 0 }).code,
    "confirmation_prompt_not_heard",
  );
});

test("missing playback evidence fails open rather than stranding a real caller", () => {
  const unknown = evaluateConfirmationAudibility({ known: false, audibleChunks: 0 });
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.code, "prompt_playback_unknown");
  assert.equal(evaluateConfirmationAudibility(null).allowed, true);
});
