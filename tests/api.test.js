import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

process.env.NODE_ENV = "test";

async function server() {
  const db = openDatabase(":memory:");
  const app = createApp({ database: db, flightRecorderEnabled: true });
  const listener = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;

  async function call(path, { token, method = "GET", body } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  const customer = await call("/api/auth/login", {
    method: "POST",
    body: { role: "customer", accountNumber: "CUST-1002", pin: "1002" },
  });
  const employee = await call("/api/auth/login", {
    method: "POST",
    body: { role: "employee", email: "employee@prodapt.demo", password: "TwinForge#2026" },
  });

  return {
    db,
    call,
    customerToken: customer.body.token,
    employeeToken: employee.body.token,
    close: () => new Promise((resolve) => {
      // Node's fetch keeps sockets alive, so close() alone would never settle.
      listener.closeAllConnections?.();
      listener.close(resolve);
    }),
  };
}

test("a bad login is refused", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const response = await api.call("/api/auth/login", {
    method: "POST",
    body: { role: "customer", accountNumber: "CUST-1002", pin: "0000" },
  });
  assert.equal(response.status, 401);
});

test("a customer cannot read the employee call reports", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const response = await api.call("/api/employee/dashboard", { token: api.customerToken });
  assert.equal(response.status, 403);
});

test("the account context returns exact grounded facts", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const response = await api.call("/api/voice/account-context", { token: api.customerToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.account.currentPlan.id, "PLAN-PREMIUM");
  assert.equal(response.body.account.currentPlan.monthlyPrice, 799);
  assert.equal(response.body.latestBill.disputed_amount, 18);
  assert.equal(response.body.currency, "INR");
});

test("the judged flow: interrupted question, correction, one confirmed review request", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const conversationId = "judged-call";

  // The Twin's first explanation was cut off before it finished. The caller
  // heard part of it; the tail never played.
  await api.call("/api/flight-recorder/events", {
    token: api.customerToken,
    method: "POST",
    body: {
      conversationId,
      events: [
        { type: "session_started", atMs: 0 },
        {
          type: "response_interrupted",
          atMs: 4000,
          epochId: "epoch-explain",
          detail: { audibleStopMs: 240, playbackClearMs: 0.2, audibleChunksBeforeStop: 6 },
        },
        {
          type: "heard_state_transition",
          atMs: 4001,
          epochId: "epoch-explain",
          value: 6,
          detail: {
            epochId: "epoch-explain",
            state: "interrupted",
            audibleChunks: 6,
            heardText: "I can raise this with Billing",
            unheardText: "and issue the refund straight away",
          },
        },
        { type: "unheard_content_quarantined", atMs: 4002, epochId: "epoch-explain", detail: {} },
        { type: "resume_context_injected", atMs: 4010, epochId: "epoch-explain", detail: {} },
      ],
    },
  });

  // The caller corrects the request. Prepare mutates nothing.
  const prepared = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "prepare",
      requestType: "refund_review",
      amount: 18,
      preparationKey: "tool-call-1",
      conversationId,
      customerTurnId: "turn-correction",
      customerTranscript: "do not issue money, send the eighteen rupee charge to billing",
    },
  });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.body.mutated, false);
  assert.equal(prepared.body.request.amount, 18);

  // The Twin asks for confirmation and the caller hears the whole question.
  await api.call("/api/flight-recorder/events", {
    token: api.customerToken,
    method: "POST",
    body: {
      conversationId,
      events: [
        {
          type: "heard_state_transition",
          atMs: 6000,
          epochId: "epoch-confirm",
          value: 9,
          detail: { epochId: "epoch-confirm", state: "completed", audibleChunks: 9 },
        },
      ],
    },
  });

  const committed = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "commit",
      requestType: "refund_review",
      intentId: prepared.body.intentId,
      conversationId,
      customerTurnId: "turn-confirmation",
      customerTranscript: "yes, that is right",
      confirmationPromptEpochId: "epoch-confirm",
    },
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.exactlyOnce, true);
  assert.equal(committed.body.result.request.status, "pending_human_review");
  assert.equal(committed.body.confirmationAudibility.code, "prompt_heard");

  // A duplicated commit must not create a second request.
  const replay = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "commit",
      requestType: "refund_review",
      intentId: prepared.body.intentId,
      conversationId,
      customerTurnId: "turn-later",
      confirmationPromptEpochId: "epoch-confirm",
    },
  });
  assert.equal(replay.body.repeated, true);

  // The voice core mirrors both action phases into the timeline.
  await api.call("/api/flight-recorder/events", {
    token: api.customerToken,
    method: "POST",
    body: {
      conversationId,
      events: [
        {
          type: "action_prepared",
          atMs: 5000,
          detail: { intentId: prepared.body.intentId, requestType: "refund_review" },
        },
        {
          type: "action_committed",
          atMs: 7000,
          detail: {
            intentId: committed.body.intentId,
            requestType: "refund_review",
            reference: committed.body.reference,
          },
        },
      ],
    },
  });

  const report = await api.call(`/api/employee/calls/${conversationId}`, { token: api.employeeToken });
  assert.equal(report.status, 200);
  assert.equal(report.body.database_match.matches, true);
  assert.equal(report.body.database_match.duplicate_executions, 0);
  assert.equal(report.body.database_match.money_issued, 0);
  assert.equal(report.body.metrics.unheard_segments_quarantined, 1);
  assert.equal(report.body.metrics.resume_context_injections, 1);
  assert.equal(report.body.metrics.audible_stop_p95_ms, 240);

  const dashboard = await api.call("/api/employee/dashboard", { token: api.employeeToken });
  assert.equal(dashboard.body.stats.pendingReviews, 1);
  assert.equal(dashboard.body.stats.completedIntents, 1);
  assert.equal(dashboard.body.stats.moneyIssued, 0);

});

test("a confirmation for a question that was cut off is refused over HTTP", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const conversationId = "unheard-call";

  const prepared = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "prepare",
      requestType: "refund_review",
      amount: 18,
      preparationKey: "tool-call-a",
      conversationId,
      customerTurnId: "turn-1",
    },
  });

  await api.call("/api/flight-recorder/events", {
    token: api.customerToken,
    method: "POST",
    body: {
      conversationId,
      events: [{
        type: "heard_state_transition",
        atMs: 100,
        epochId: "epoch-cut",
        value: 0,
        detail: { epochId: "epoch-cut", state: "interrupted", audibleChunks: 0 },
      }],
    },
  });

  const blocked = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "commit",
      requestType: "refund_review",
      intentId: prepared.body.intentId,
      conversationId,
      customerTurnId: "turn-2",
      confirmationPromptEpochId: "epoch-cut",
    },
  });

  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "confirmation_prompt_not_heard");
  assert.equal(blocked.body.recovery, "ask_for_confirmation");
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM service_requests").get().n, 0);

});

test("unrelated audio that never produced a prepared intent creates nothing", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const response = await api.call("/api/voice/billing-request", {
    token: api.customerToken,
    method: "POST",
    body: {
      phase: "commit",
      requestType: "refund_review",
      intentId: "ACT-does-not-exist",
      conversationId: "noise-call",
      customerTurnId: "turn-1",
    },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "UNKNOWN_INTENT");
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM service_requests").get().n, 0);
});
