import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loginCustomer, loginEmployee, logout, requireRole } from "./auth.js";
import { customerSnapshot, openDatabase } from "./db.js";
import { policyMatrix } from "./policy.js";
import { getAccountContext, listPlans, submitBillingRequest } from "./tools.js";
import { createVoiceClientToken, voiceStatus } from "./agent/gemini-live.js";
import { createFlightRecorder } from "./flight-recorder/index.js";
import { effectiveFeatures, featureSummary } from "./config/features.js";
import { createTranscriptionToken } from "./transcription/token.js";
import { V5_API_PORT, checkApiPort, proxyMismatchWarning } from "./port-guard.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(join(projectRoot, ".env")); } catch {}

export function createApp({ database = null, flightRecorderEnabled = undefined } = {}) {
  const db = database || openDatabase();
  const recorder = createFlightRecorder(db, {
    enabled: flightRecorderEnabled ?? process.env.CALL_FLIGHT_RECORDER !== "false",
  });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, voice: voiceStatus(), flightRecorder: recorder.status(), v5: featureSummary() });
  });

  app.post("/api/auth/login", (req, res) => {
    const { role } = req.body || {};
    const session = role === "customer"
      ? loginCustomer(db, req.body.accountNumber, req.body.pin)
      : role === "employee"
        ? loginEmployee(db, req.body.email, req.body.password)
        : null;
    if (!session) return res.status(401).json({ error: "The login details did not match." });
    res.json(session);
  });

  app.post("/api/auth/logout", (req, res) => {
    logout(db, req.headers.authorization);
    res.json({ ok: true });
  });

  app.get("/api/me", requireRole(db), (req, res) => {
    if (req.session.role === "customer") {
      const snapshot = customerSnapshot(db, req.session.principal_id);
      return res.json({ role: "customer", principalId: req.session.principal_id, profile: snapshot.customer });
    }
    res.json({
      role: "employee",
      principalId: "EMP-001",
      profile: { name: "Maya", title: "Billing Support Specialist" },
    });
  });

  app.get("/api/plans", requireRole(db), (_req, res) => res.json(listPlans(db)));
  app.get("/api/policy", requireRole(db, "employee"), (_req, res) => res.json(policyMatrix()));

  app.get("/api/customer/dashboard", requireRole(db, "customer"), (req, res) => {
    res.json(customerSnapshot(db, req.session.principal_id));
  });

  // -------------------------------------------------------------------------
  // V5 additions. Both are authenticated. Neither can perform a business
  // action, and the transcription token endpoint refuses outright while the
  // server-side switch is off -- hiding the panel is not a control.
  // -------------------------------------------------------------------------

  app.get("/api/v5/features", requireRole(db), (_req, res) => {
    res.json(effectiveFeatures());
  });

  app.post("/api/v5/transcription/token", requireRole(db, "customer"), async (req, res, next) => {
    try {
      res.json(await createTranscriptionToken({ session: req.session, body: req.body || {} }));
    } catch (error) { next(error); }
  });

  app.post("/api/voice/client-token", requireRole(db, "customer"), async (req, res, next) => {
    try {
      // The browser may request a MODE. The server picks the model.
      res.json(await createVoiceClientToken({ requestedMode: req.body?.voiceMode }));
    } catch (error) { next(error); }
  });

  app.get("/api/voice/account-context", requireRole(db, "customer"), (req, res) => {
    res.json(getAccountContext(db, req.session.principal_id));
  });

  app.post("/api/voice/billing-request", requireRole(db, "customer"), (req, res, next) => {
    try {
      const input = {
        customerId: req.session.principal_id,
        phase: req.body.phase,
        requestType: req.body.requestType,
        targetPlanId: req.body.targetPlanId,
        amount: req.body.amount,
        intentId: req.body.intentId,
        preparationKey: req.body.preparationKey,
        conversationId: req.body.conversationId,
        customerTurnId: req.body.customerTurnId,
        customerTranscript: req.body.customerTranscript,
        confirmationPromptEpochId: req.body.confirmationPromptEpochId,
      };
      const heardEvidence = input.phase === "commit"
        ? recorder.heardEvidence(input.conversationId, input.confirmationPromptEpochId)
        : null;
      const result = submitBillingRequest(db, input, { heardEvidence });
      res.status(result.phase === "prepare" && !result.repeated ? 201 : 200).json(result);
    } catch (error) { next(error); }
  });

  if (recorder.enabled) {
    app.post("/api/flight-recorder/events", requireRole(db, "customer"), (req, res, next) => {
      try { res.status(202).json(recorder.ingest(req.session.principal_id, req.body || {})); }
      catch (error) { next(error); }
    });
    app.get("/api/employee/calls", requireRole(db, "employee"), (_req, res) => {
      res.json(recorder.listCalls());
    });
    app.get("/api/employee/calls/:conversationId", requireRole(db, "employee"), (req, res) => {
      const report = recorder.report(String(req.params.conversationId || ""));
      if (!report) return res.status(404).json({ error: "That call was not recorded." });
      res.json(report);
    });
  }

  app.get("/api/employee/dashboard", requireRole(db, "employee"), (_req, res) => {
    const stats = {
      customers: db.prepare("SELECT COUNT(*) AS count FROM customers").get().count,
      pendingReviews: db.prepare(
        "SELECT COUNT(*) AS count FROM service_requests WHERE status = 'pending_human_review'",
      ).get().count,
      verifiedPlanChanges: db.prepare(
        "SELECT COUNT(*) AS count FROM plan_changes WHERE status = 'verified'",
      ).get().count,
      preparedIntents: db.prepare("SELECT COUNT(*) AS count FROM action_intents").get().count,
      completedIntents: db.prepare(
        "SELECT COUNT(*) AS count FROM action_intents WHERE status = 'completed'",
      ).get().count,
      supersededIntents: db.prepare(
        "SELECT COUNT(*) AS count FROM action_intents WHERE status = 'superseded'",
      ).get().count,
      moneyIssued: 0,
    };
    const pending = db.prepare(`
      SELECT sr.*, c.name AS customer_name, c.account_number
      FROM service_requests sr JOIN customers c ON c.id = sr.customer_id
      WHERE sr.status = 'pending_human_review' ORDER BY sr.created_at DESC LIMIT 20
    `).all();
    const audit = db.prepare(`
      SELECT ae.*, c.name AS customer_name FROM audit_events ae
      LEFT JOIN customers c ON c.id = ae.customer_id ORDER BY ae.created_at DESC LIMIT 30
    `).all().map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json) }));
    const ledger = db.prepare(`
      SELECT hl.*, c.name AS customer_name FROM hcr_ledger hl
      LEFT JOIN customers c ON c.id = hl.customer_id ORDER BY hl.created_at DESC LIMIT 40
    `).all();
    res.json({
      stats,
      pending,
      audit,
      ledger,
      voice: voiceStatus(),
      flightRecorder: recorder.status(),
      calls: recorder.enabled ? recorder.listCalls() : [],
      reports: recorder.enabled ? recorder.latestReports(6) : [],
    });
  });

  // A feature that is switched off answering 503 is correct operation, not a
  // fault, so it does not get a stack trace in the log every time someone tries.
  const EXPECTED_CODES = new Set(["feature_disabled"]);

  app.use((error, _req, res, _next) => {
    const expected = EXPECTED_CODES.has(error.code);
    if (!expected && (!error.statusCode || error.statusCode >= 500)) console.error(error);
    const body = { error: error.publicMessage || error.message || "Request failed." };
    for (const field of ["code", "recovery", "field", "blockers", "constraintRejected"]) {
      if (error[field] != null) body[field] = error[field];
    }
    res.status(error.statusCode || 400).json(body);
  });

  const dist = join(projectRoot, "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(join(dist, "index.html")) : next()));
  }

  app.locals.db = db;
  app.locals.recorder = recorder;
  return app;
}

const startedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (startedDirectly) {
  const check = checkApiPort(process.env.PORT || V5_API_PORT);
  if (!check.ok) {
    // Refuse loudly. Squatting on a frozen project's port, or binding a port the
    // dev server does not proxy to, both produce an app that looks broken for no
    // visible reason at all.
    console.error("");
    console.error(check.message);
    console.error("");
    process.exit(1);
  }

  const warning = proxyMismatchWarning(check.port);
  if (warning) {
    console.warn("");
    console.warn(warning);
    console.warn("");
  }

  const server = createApp().listen(check.port, "127.0.0.1", () => {
    console.log(`HCR ActionGuard V5 API ready at http://127.0.0.1:${check.port}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error("");
      console.error(`Port ${check.port} is already in use.`);
      console.error("  Another V5 API is probably still running. Stop it, or find what holds the port:");
      console.error(`    netstat -ano | findstr :${check.port}`);
      console.error("");
      process.exit(1);
    }
    throw error;
  });
}
