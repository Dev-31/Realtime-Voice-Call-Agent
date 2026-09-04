/**
 * Deterministic business authority for HCR ActionGuard.
 *
 * Nothing in this file may branch on customer wording. It reads only
 * authenticated account state and explicit workflow flags. Conversational
 * meaning is decided by the model; permission is decided here.
 */

const RULES = Object.freeze({
  refund_review: {
    authorized: true,
    outcome: "create_review_request",
    moneyMovement: "never",
    reason: "Only a human billing specialist may issue money. The Twin may create a review request.",
  },
  refund_payout: {
    authorized: false,
    outcome: "reject",
    moneyMovement: "never",
    reason: "The Twin has no money-movement authority at all.",
  },
  plan_change: {
    authorized: true,
    outcome: "execute_after_confirmation",
    moneyMovement: "recurring_charge_change",
    reason: "Active customers may change to an active plan after a distinct later confirmation.",
  },
});

export function evaluatePolicy(action, context = {}) {
  const rule = RULES[action];
  if (!rule) {
    return { authorized: false, outcome: "reject", moneyMovement: "never", reason: "Unknown action." };
  }
  if (context.customerStatus && context.customerStatus !== "active") {
    return {
      authorized: false,
      outcome: "human_review",
      moneyMovement: "never",
      reason: "The account is not active.",
    };
  }
  if (rule.outcome === "execute_after_confirmation" && context.confirmed !== true) {
    return {
      authorized: false,
      outcome: "request_confirmation",
      moneyMovement: rule.moneyMovement,
      reason: "The customer has not confirmed this exact prepared request in a later turn.",
    };
  }
  return { ...rule };
}

/**
 * Gate 3 heard-state guard.
 *
 * A confirmation only counts when the caller could actually hear the question
 * they are answering. This reads recorded playback evidence, never wording.
 *
 * `promptEvidence` is the Call Flight Recorder's record for the Twin response
 * epoch that asked for confirmation:
 *   { known, audibleChunks, state }
 */
export function evaluateConfirmationAudibility(promptEvidence) {
  if (!promptEvidence || promptEvidence.known !== true) {
    return {
      allowed: true,
      code: "prompt_playback_unknown",
      reason: "No playback record was found for the confirmation question, so audibility could not be checked.",
    };
  }
  if (Number(promptEvidence.audibleChunks) > 0) {
    return {
      allowed: true,
      code: "prompt_heard",
      reason: "The confirmation question reached the caller's speaker before the confirmation turn.",
    };
  }
  return {
    allowed: false,
    code: "confirmation_prompt_not_heard",
    reason: "The confirmation question was cut off before any audio reached the caller, so the later turn cannot confirm it.",
  };
}

export function policyMatrix() {
  return structuredClone(RULES);
}
