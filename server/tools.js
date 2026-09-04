import { createHash, randomUUID } from "node:crypto";
import { evaluateConfirmationAudibility, evaluatePolicy } from "./policy.js";
import { recordAudit, recordLedger } from "./ledger.js";

const INTENT_TTL_MS = 15 * 60 * 1000;
const REQUEST_TYPES = new Set(["plan_change", "refund_review"]);
const REVIEW_REASON = "Customer asked Billing to review a disputed charge. No money was issued.";

function conflict(message, details = {}) {
  const error = new Error(message);
  error.statusCode = 409;
  Object.assign(error, details);
  return error;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reference(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

// These are read-back facts, not a new action or confirmation gate.
function planChangeSummary(db, customerId, changeId = null) {
  const change = db.prepare(`
    SELECT pc.id, pc.verified_at, f.id AS from_id, f.name AS from_name,
           t.id AS to_id, t.name AS to_name, t.monthly_price AS to_price
    FROM plan_changes pc JOIN plans f ON f.id = pc.from_plan_id
    JOIN plans t ON t.id = pc.to_plan_id
    WHERE pc.customer_id = ? AND pc.status = 'verified' AND (? IS NULL OR pc.id = ?)
    ORDER BY pc.id DESC LIMIT 1
  `).get(customerId, changeId, changeId);
  return change ? {
    changeId: change.id,
    completedAt: change.verified_at,
    fromPlan: { id: change.from_id, name: change.from_name },
    toPlan: { id: change.to_id, name: change.to_name, monthlyPrice: Number(change.to_price) },
  } : null;
}

function completedActionReadback(db, customerId, result, repeated, request) {
  const context = getAccountContext(db, customerId);
  const summary = result.change ? planChangeSummary(db, customerId, result.change.id) : null;
  // The prepared price is the historical agreed price; today's catalogue can differ.
  if (summary) summary.toPlan.monthlyPrice = request.targetMonthlyPrice;
  return {
    // A replay's historical outcome and today's account state may differ.
    planChangeSummary: summary,
    accountState: {
      currentPlan: context.account.currentPlan,
      planChangeSequence: context.account.planChangeSequence,
      readAt: new Date().toISOString(),
    },
    reportingGuidance: repeated
      ? "This is a previously completed request, not a new change. Its historical result must not override accountState, which is a fresh read. Explain the current account when clarification is needed; never perform an automatic reversal."
      : "For a verified plan change, clearly state both the previous and new plan from planChangeSummary and the new price. The change has already completed. If the caller subsequently withdraws or questions it, read get_account_context, explain the actual current plan and ask what outcome they want. Do not imply the completed change was cancelled or automatically reverse it. Any new change uses the existing preparation and later confirmation flow.",
  };
}

export function listPlans(db) {
  return db.prepare(
    "SELECT id, name, monthly_price, description FROM plans WHERE active = 1 ORDER BY monthly_price",
  ).all();
}

/** Fresh authenticated account read. The only authority for account facts. */
export function getAccountContext(db, customerId) {
  const account = db.prepare(`
    SELECT c.id, c.account_number, c.name, c.status,
           p.id AS plan_id, p.name AS plan_name, p.monthly_price, p.description AS plan_description
    FROM customers c JOIN plans p ON p.id = c.current_plan_id
    WHERE c.id = ?
  `).get(customerId);
  if (!account) throw new Error("Customer not found.");
  const latestBill = db.prepare(`
    SELECT id, period, amount, status, due_date, disputed_amount, disputed_line_item
    FROM bills WHERE customer_id = ? ORDER BY due_date DESC LIMIT 1
  `).get(customerId);
  const recentRequests = db.prepare(`
    SELECT reference, type, status, reason, amount, created_at
    FROM service_requests WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5
  `).all(customerId);
  const latestPlanChange = planChangeSummary(db, customerId);
  return {
    account: {
      customerId: account.id,
      accountNumber: account.account_number,
      name: account.name,
      status: account.status,
      planChangeSequence: latestPlanChange?.changeId || 0,
      currentPlan: {
        id: account.plan_id,
        name: account.plan_name,
        monthlyPrice: account.monthly_price,
        description: account.plan_description,
      },
    },
    latestBill,
    latestPlanChange,
    accountStateGuidance: "This is a fresh account read. Use account.currentPlan for the current plan, not an older conversation snapshot. A completed change is history, not a pending request. If the caller is reconsidering it, explain the current plan and ask what outcome they want; do not imply an automatic cancellation or reversal.",
    recentRequests,
    availablePlans: listPlans(db).map((plan) => ({
      id: plan.id,
      name: plan.name,
      monthlyPrice: plan.monthly_price,
      description: plan.description,
    })),
    currency: "INR",
    businessPolicy: {
      planChange: "A server-prepared exact plan and a distinct later confirmation are required before execution.",
      refund: "Only a Billing human-review request can be created. The Twin never issues money.",
    },
  };
}

/** Disputed amounts that actually exist on this account. */
function groundedDisputedAmounts(db, customerId) {
  return db.prepare(`
    SELECT DISTINCT disputed_amount FROM bills
    WHERE customer_id = ? AND disputed_amount > 0
    ORDER BY due_date DESC LIMIT 8
  `).all(customerId).map((row) => Number(row.disputed_amount)).filter(Number.isFinite);
}

function requireEvidence(input) {
  const conversationId = String(input.conversationId || "").trim().slice(0, 120);
  const customerTurnId = String(input.customerTurnId || "").trim().slice(0, 120);
  if (!conversationId) throw new Error("A conversation ID is required.");
  if (!customerTurnId) throw new Error("A customer turn ID is required.");
  return {
    conversationId,
    customerTurnId,
    customerTranscript: String(input.customerTranscript || "").trim().slice(0, 2000),
    confirmationPromptEpochId: String(input.confirmationPromptEpochId || "").trim().slice(0, 120) || null,
  };
}

/**
 * Turn a model-proposed request into exact server facts.
 * Anything the model asserts that the account does not support is dropped here.
 */
function normalizeRequest(db, input) {
  const requestType = String(input.requestType || "");
  if (!REQUEST_TYPES.has(requestType)) throw new Error("Unsupported request type.");

  if (requestType === "plan_change") {
    const targetPlanId = String(input.targetPlanId || "").trim();
    const plan = db.prepare("SELECT id, name, monthly_price FROM plans WHERE id = ? AND active = 1").get(targetPlanId);
    if (!plan) throw conflict("That plan is not an active plan on this account's catalogue.");
    return Object.freeze({
      requestType,
      targetPlanId: plan.id,
      targetPlanName: plan.name,
      targetMonthlyPrice: Number(plan.monthly_price),
      reason: null,
      amount: null,
      amountEvidence: "not_applicable",
    });
  }

  const proposed = input.amount == null ? null : Number(input.amount);
  const grounded = groundedDisputedAmounts(db, input.customerId);
  const amountSupported = proposed != null && Number.isFinite(proposed) && grounded.includes(proposed);
  return Object.freeze({
    requestType,
    targetPlanId: null,
    targetPlanName: null,
    targetMonthlyPrice: null,
    reason: REVIEW_REASON,
    amount: amountSupported ? proposed : null,
    amountEvidence: proposed == null ? "not_supplied" : amountSupported ? "supported_by_account" : "dropped_unsupported",
  });
}

function intentRequest(db, intent) {
  return Object.freeze({
    requestType: intent.request_type,
    targetPlanId: intent.target_plan_id,
    targetPlanName: intent.target_plan_name,
    targetMonthlyPrice: intent.target_monthly_price == null ? null : Number(intent.target_monthly_price),
    reason: intent.reason,
    amount: intent.amount == null ? null : Number(intent.amount),
    amountEvidence: intent.amount == null ? "not_supplied" : "supported_by_account",
  });
}

// ---------------------------------------------------------------------------
// Terminal executors. Both are idempotent on their idempotency key.
// ---------------------------------------------------------------------------

export function createReviewRequest(db, {
  customerId,
  reason,
  amount = null,
  idempotencyKey,
  conversationId = "web-demo",
}) {
  if (!idempotencyKey) throw new Error("An idempotency key is required.");
  const existing = db.prepare("SELECT * FROM service_requests WHERE idempotency_key = ?").get(idempotencyKey);
  if (existing) {
    const sameAmount = (existing.amount == null && amount == null) || Number(existing.amount) === Number(amount);
    if (existing.customer_id !== customerId || existing.type !== "refund_review" || !sameAmount) {
      throw conflict("That idempotency key belongs to a different review request.");
    }
    return { request: existing, repeated: true, policy: evaluatePolicy("refund_review") };
  }

  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
  if (!customer) throw new Error("Customer not found.");
  const policy = evaluatePolicy("refund_review", { customerStatus: customer.status });
  if (!policy.authorized) throw conflict(policy.reason);
  const requestRef = reference("HR");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO service_requests
        (reference, idempotency_key, customer_id, conversation_id, type, status, reason, amount,
         assigned_to, created_by, created_at)
      VALUES (?, ?, ?, ?, 'refund_review', 'pending_human_review', ?, ?, 'Billing Team', 'HCR ActionGuard', ?)
    `).run(requestRef, idempotencyKey, customerId, conversationId, reason, amount, new Date().toISOString());
    recordLedger(db, {
      conversationId, customerId, stage: "executed", objectType: "refund_review",
      objectId: requestRef, state: "pending_human_review", detail: policy.reason,
    });
    recordAudit(db, {
      customerId, conversationId, eventType: "review_request_created", status: "pending_human_review",
      summary: `Created ${requestRef} for Billing. Zero money issued.`,
      metadata: { amount, reason, moneyIssued: 0 },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    request: db.prepare("SELECT * FROM service_requests WHERE reference = ?").get(requestRef),
    repeated: false,
    policy,
  };
}

export function changePlan(db, {
  customerId,
  targetPlanId,
  confirmed,
  idempotencyKey,
  conversationId = "web-demo",
}) {
  if (!idempotencyKey) throw new Error("An idempotency key is required.");
  const existing = db.prepare("SELECT * FROM plan_changes WHERE idempotency_key = ?").get(idempotencyKey);
  if (existing) return { change: existing, repeated: true, verified: existing.status === "verified" };

  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
  const target = db.prepare("SELECT * FROM plans WHERE id = ? AND active = 1").get(targetPlanId);
  if (!customer) throw new Error("Customer not found.");
  if (!target) throw new Error("Target plan not found.");
  if (customer.current_plan_id === targetPlanId) throw conflict("Customer is already on that plan.");

  const policy = evaluatePolicy("plan_change", { customerStatus: customer.status, confirmed });
  if (!policy.authorized) return { blocked: true, policy };

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO plan_changes
        (idempotency_key, customer_id, conversation_id, from_plan_id, to_plan_id,
         confirmed_by_customer, status, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 'executing', ?)
    `).run(idempotencyKey, customerId, conversationId, customer.current_plan_id, targetPlanId, now);
    db.prepare("UPDATE customers SET current_plan_id = ? WHERE id = ?").run(targetPlanId, customerId);
    const verified = db.prepare("SELECT current_plan_id FROM customers WHERE id = ?")
      .get(customerId).current_plan_id === targetPlanId;
    db.prepare("UPDATE plan_changes SET status = ?, verified_at = ? WHERE idempotency_key = ?")
      .run(verified ? "verified" : "verification_failed", verified ? new Date().toISOString() : null, idempotencyKey);
    recordLedger(db, {
      conversationId, customerId, stage: "executed", objectType: "plan_change",
      objectId: idempotencyKey, state: verified ? "verified" : "failed",
      detail: verified ? `Account now reads ${target.name}.` : "Read-back did not match.",
    });
    recordAudit(db, {
      customerId, conversationId, eventType: "plan_changed", status: verified ? "resolved" : "failed",
      summary: `${customer.account_number} changed to ${target.name}; verification ${verified ? "passed" : "failed"}.`,
      metadata: { fromPlanId: customer.current_plan_id, toPlanId: targetPlanId, idempotencyKey },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const change = db.prepare("SELECT * FROM plan_changes WHERE idempotency_key = ?").get(idempotencyKey);
  return { change, repeated: false, verified: change.status === "verified", policy };
}

// ---------------------------------------------------------------------------
// Prepare -> distinct later confirmation -> idempotent commit
// ---------------------------------------------------------------------------

export function prepareAction(db, input) {
  const evidence = requireEvidence(input);
  const preparationKey = String(input.preparationKey || "").trim().slice(0, 160);
  if (!preparationKey) throw new Error("A provider tool-call ID is required.");

  const request = normalizeRequest(db, input);
  const requestFingerprint = fingerprint(request);

  // The provider replayed the same tool call: return the same pending intent.
  const replay = db.prepare("SELECT * FROM action_intents WHERE preparation_key = ?").get(preparationKey);
  if (replay) {
    if (replay.customer_id !== input.customerId
      || replay.conversation_id !== evidence.conversationId
      || replay.request_fingerprint !== requestFingerprint) {
      throw conflict("That provider tool-call ID belongs to a different prepared request.");
    }
    return {
      phase: "prepare",
      status: replay.status,
      intentId: replay.id,
      request: intentRequest(db, replay),
      repeated: true,
      confirmationRequired: replay.status === "awaiting_confirmation",
      mutated: false,
    };
  }

  const customer = db.prepare("SELECT status, current_plan_id FROM customers WHERE id = ?").get(input.customerId);
  if (!customer) throw new Error("Customer not found.");

  if (request.requestType === "plan_change") {
    if (customer.current_plan_id === request.targetPlanId) throw conflict("Customer is already on that plan.");
    const policy = evaluatePolicy("plan_change", { customerStatus: customer.status, confirmed: false });
    if (policy.outcome !== "request_confirmation") throw conflict(policy.reason);
  } else {
    const policy = evaluatePolicy("refund_review", { customerStatus: customer.status });
    if (!policy.authorized) throw conflict(policy.reason);
  }

  // An unconfirmed earlier request in this call is replaced, not kept alive.
  // This is how a spoken correction cancels the stale pending action.
  const superseded = db.prepare(`
    UPDATE action_intents SET status = 'superseded'
    WHERE customer_id = ? AND conversation_id = ? AND status = 'awaiting_confirmation'
  `).run(input.customerId, evidence.conversationId);

  const id = `ACT-${randomUUID()}`;
  const now = new Date();
  db.prepare(`
    INSERT INTO action_intents
      (id, preparation_key, request_fingerprint, customer_id, conversation_id, request_type,
       target_plan_id, target_plan_name, target_monthly_price, reason, amount,
       prepared_turn_id, prepared_transcript, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?)
  `).run(
    id, preparationKey, requestFingerprint, input.customerId, evidence.conversationId,
    request.requestType, request.targetPlanId, request.targetPlanName, request.targetMonthlyPrice,
    request.reason, request.amount, evidence.customerTurnId, evidence.customerTranscript,
    now.toISOString(), new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
  );

  recordLedger(db, {
    conversationId: evidence.conversationId,
    customerId: input.customerId,
    stage: "prepared",
    objectType: request.requestType,
    objectId: id,
    state: "awaiting_confirmation",
    detail: request.requestType === "plan_change"
      ? `Prepared ${request.targetPlanName} at ${request.targetMonthlyPrice} per month. Nothing changed yet.`
      : "Prepared a Billing human review. No request row and no money created yet.",
  });

  return {
    phase: "prepare",
    status: "awaiting_confirmation",
    intentId: id,
    request,
    repeated: false,
    confirmationRequired: true,
    mutated: false,
    supersededPendingRequests: Number(superseded.changes) || 0,
    nextConversationAction: "read_back_and_ask_for_confirmation",
  };
}

export function commitAction(db, input, { heardEvidence = null } = {}) {
  const evidence = requireEvidence(input);
  const intentId = String(input.intentId || "").trim().slice(0, 160);
  const intent = db.prepare("SELECT * FROM action_intents WHERE id = ?").get(intentId);
  if (!intent || intent.customer_id !== input.customerId || intent.conversation_id !== evidence.conversationId) {
    throw conflict("That pending request does not belong to this customer conversation.", {
      code: "UNKNOWN_INTENT",
      publicMessage: "There is no matching pending request in this call. Nothing was changed.",
    });
  }
  const request = intentRequest(db, intent);

  if (intent.status === "completed") {
    const result = JSON.parse(intent.result_json);
    return {
      phase: "commit",
      status: "completed",
      intentId,
      request,
      result,
      ...completedActionReadback(db, input.customerId, result, true, request),
      repeated: true,
      exactlyOnce: true,
    };
  }
  if (intent.status === "superseded") {
    throw conflict("A later correction replaced that request.", {
      code: "SUPERSEDED_BY_CORRECTION",
      publicMessage: "The customer corrected this request, so the earlier version was cancelled. Prepare the corrected request instead.",
      recovery: "prepare_corrected_request",
    });
  }
  if (intent.status !== "awaiting_confirmation") {
    throw conflict("That pending request is no longer active.", { code: "INTENT_INACTIVE" });
  }
  if (Date.parse(intent.expires_at) <= Date.now()) {
    db.prepare("UPDATE action_intents SET status = 'expired' WHERE id = ?").run(intentId);
    throw conflict("That pending request expired without execution.", { code: "INTENT_EXPIRED" });
  }
  if (input.requestType && input.requestType !== request.requestType) {
    throw conflict("The pending request type does not match.", { code: "REQUEST_TYPE_MISMATCH" });
  }

  // Guard 1: confirmation must come from a distinct later customer turn.
  if (intent.prepared_turn_id === evidence.customerTurnId) {
    throw conflict("Confirmation must come from a later customer turn.", {
      code: "SAME_TURN_CONFIRMATION",
      publicMessage: "The request turn cannot also be its own confirmation. Ask the customer to confirm.",
      recovery: "ask_for_confirmation",
    });
  }

  // Guard 2: the caller must have been able to hear the question they answered.
  const audibility = evaluateConfirmationAudibility(heardEvidence);
  if (!audibility.allowed) {
    recordLedger(db, {
      conversationId: evidence.conversationId,
      customerId: input.customerId,
      stage: "confirmation_rejected",
      objectType: request.requestType,
      objectId: intentId,
      state: "blocked",
      detail: audibility.reason,
    });
    throw conflict(audibility.reason, {
      code: audibility.code,
      publicMessage: "The confirmation question never reached the caller, so that answer cannot confirm it. Ask again.",
      recovery: "ask_for_confirmation",
    });
  }

  // Guard 3: account facts must still match what the caller was told.
  if (request.requestType === "plan_change") {
    const current = db.prepare("SELECT name, monthly_price FROM plans WHERE id = ? AND active = 1")
      .get(request.targetPlanId);
    if (!current
      || current.name !== request.targetPlanName
      || Number(current.monthly_price) !== Number(request.targetMonthlyPrice)) {
      throw conflict("The target plan facts changed after preparation.", {
        code: "STALE_PLAN_FACTS",
        publicMessage: "The plan details changed since we read them out. Let us prepare a fresh request.",
        recovery: "prepare_corrected_request",
      });
    }
  }

  const idempotencyKey = `intent:${intent.id}`;
  const result = request.requestType === "plan_change"
    ? changePlan(db, {
      customerId: input.customerId,
      targetPlanId: request.targetPlanId,
      confirmed: true,
      idempotencyKey,
      conversationId: evidence.conversationId,
    })
    : createReviewRequest(db, {
      customerId: input.customerId,
      reason: request.reason,
      amount: request.amount,
      idempotencyKey,
      conversationId: evidence.conversationId,
    });
  if (result.blocked) throw conflict(result.policy?.reason || "Server policy blocked this request.");

  db.prepare(`
    UPDATE action_intents
    SET status = 'completed', result_json = ?, confirmed_turn_id = ?, confirmed_transcript = ?,
        confirmation_prompt_epoch_id = ?, heard_evidence_json = ?, completed_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(result),
    evidence.customerTurnId,
    evidence.customerTranscript,
    evidence.confirmationPromptEpochId,
    JSON.stringify({ ...audibility, evidence: heardEvidence }),
    new Date().toISOString(),
    intentId,
  );

  recordLedger(db, {
    conversationId: evidence.conversationId,
    customerId: input.customerId,
    stage: "confirmation_bound",
    objectType: request.requestType,
    objectId: intentId,
    state: "completed",
    detail: `A distinct later turn confirmed a question the caller had heard (${audibility.code}). Executed exactly once.`,
  });

  return {
    phase: "commit",
    status: "completed",
    intentId,
    request,
    result,
    repeated: false,
    exactlyOnce: true,
    confirmationAudibility: audibility,
    reference: result.request?.reference || result.change?.idempotency_key || null,
    ...completedActionReadback(db, input.customerId, result, false, request),
  };
}

export function submitBillingRequest(db, input, options = {}) {
  const phase = String(input.phase || "");
  if (phase === "prepare") return prepareAction(db, input);
  if (phase === "commit") return commitAction(db, input, options);
  throw new Error("Billing request phase must be prepare or commit.");
}
