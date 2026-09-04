/**
 * Adversarial suite 3: the V5 HTTP surface and the transcription credential path.
 *
 * The premise of every test here is that the browser is hostile. It may ask for
 * a model it was not offered, post a body shaped to poison a prototype, or
 * hammer the token endpoint. None of that may widen what the server issues, and
 * nothing may ever carry GEMINI_API_KEY back out.
 *
 * `server/config/features.js` reads `process.env` at CALL time, not at import
 * time, so every test that depends on a switch sets the variables it needs and
 * restores them afterwards. `test()` bodies in one file run one at a time, so
 * the save/restore is safe.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { effectiveFeatures } from "../server/config/features.js";
import {
  ALLOWED_LANGUAGE_CODES,
  ALLOWED_TRANSCRIPTION_MODELS,
  ALLOWED_TRANSCRIPTION_MODES,
  PRODUCT_VOCABULARY,
  TRANSCRIPTION_LIMITS,
  resolveTranscriptionRequest,
} from "../server/transcription/config.js";
import {
  authorizeTranscriptionToken,
  createTranscriptionToken,
  describeTokenRequest,
  resetIssuanceCounters,
} from "../server/transcription/token.js";
import { V5_PROJECT_ROOT, assertV5DatabasePath, isInsideV5 } from "../server/db-path-guard.js";

process.env.NODE_ENV = "test";

/** Obviously fake. If this string ever appears in a response, the test fails. */
const DUMMY_KEY = "test-key-not-real";

const PROVIDER_HOST = "generativelanguage.googleapis.com";

const V5_ENV_NAMES = [
  "SMART_TRANSCRIPT_ENABLED",
  "TRANSCRIPT_LAB_ENABLED",
  "TRANSCRIPT_LAB_LIVE_CALLS",
  "TRANSCRIPT_LAB_STORE_AUDIO",
  "VOICE_STYLE",
  "TRANSCRIPT_MODEL",
  "GEMINI_API_KEY",
];

/** Set the V5 switches for one test and put the whole set back afterwards. */
function withEnv(t, overrides) {
  const saved = V5_ENV_NAMES.map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of V5_ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  }
}

/**
 * Make the real provider unreachable for the duration of a test.
 *
 * Any attempt to contact it is recorded and then refused, so a test can prove
 * "no provider call was attempted" without ever risking real egress.
 */
function guardProviderFetch(t) {
  const real = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes(PROVIDER_HOST)) {
      attempts.push(url);
      throw new Error("blocked by the test suite: no real provider call is allowed");
    }
    return real(input, init);
  };
  t.after(() => { globalThis.fetch = real; });
  return attempts;
}

async function server() {
  const db = openDatabase(":memory:");
  const app = createApp({ database: db, flightRecorderEnabled: true });
  const listener = await new Promise((done) => {
    const instance = app.listen(0, "127.0.0.1", () => done(instance));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  // Captured before any test installs a provider guard, so the client itself
  // is never routed through the guard it is asserting on.
  const clientFetch = globalThis.fetch;

  async function call(path, { token, method = "GET", body, rawBody } = {}) {
    const response = await clientFetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
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
    close: () => new Promise((done) => {
      listener.closeAllConnections?.();
      listener.close(done);
    }),
  };
}

/** Visit every value in a JSON tree, keys included, so nothing hides in a nest. */
function walkJson(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visit, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      visit(key, `${path}.<key>`);
      walkJson(value[key], visit, `${path}.${key}`);
    }
  }
}

function assertNoSecret(payload, secret, label) {
  walkJson(payload, (value, path) => {
    if (typeof value !== "string") return;
    assert.ok(value !== secret, `${label}: ${path} is the credential itself`);
    assert.ok(!value.includes(secret), `${label}: ${path} contains the credential`);
    // A real Google API key shape, in case a future edit forwards a live key.
    assert.ok(!/\bAIza[0-9A-Za-z_-]{35}\b/.test(value), `${label}: ${path} looks like a Google API key`);
  });
}

/** A session row shaped like the one `requireRole` puts on the request. */
function customerSession(tokenHash = "session-hash-1") {
  return { role: "customer", token_hash: tokenHash, principal_id: "CUS-002", expires_at: null };
}

/** A provider stand-in that records what it was asked and never touches a socket. */
function fakeProvider({ status = 200, payload = { name: "auth_tokens/FAKE-TOKEN-VALUE" } } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => payload };
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/v5/features
// ---------------------------------------------------------------------------

test("the feature report requires a session", async (t) => {
  const api = await server();
  t.after(() => api.close());
  const anonymous = await api.call("/api/v5/features");
  assert.equal(anonymous.status, 401);
  const forged = await api.call("/api/v5/features", { token: "not-a-real-session-token" });
  assert.equal(forged.status, 401);
});

test("the feature report is readable by both signed-in roles", async (t) => {
  const api = await server();
  t.after(() => api.close());
  for (const token of [api.customerToken, api.employeeToken]) {
    const response = await api.call("/api/v5/features", { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.build.project, "Prodapt IPL project V5");
    assert.ok(Array.isArray(response.body.configurationErrors));
  }
});

test("the feature report never carries a credential value", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, SMART_TRANSCRIPT_ENABLED: "true", TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  const api = await server();
  t.after(() => api.close());

  const response = await api.call("/api/v5/features", { token: api.customerToken });
  assert.equal(response.status, 200);

  // The whole tree, not just the obvious field.
  assertNoSecret(response.body, DUMMY_KEY, "features payload");
  // And the raw bytes, in case a value is nested somewhere the walk misses.
  assert.ok(!response.text.includes(DUMMY_KEY), "the response body text contains the credential");

  // Presence only, and nothing else on that object.
  assert.deepEqual(Object.keys(response.body.credentials).sort(), ["geminiApiKeyPresent", "note"]);
  assert.equal(response.body.credentials.geminiApiKeyPresent, true);

  // With the key removed, presence flips and still no value appears.
  delete process.env.GEMINI_API_KEY;
  const without = await api.call("/api/v5/features", { token: api.customerToken });
  assert.equal(without.body.credentials.geminiApiKeyPresent, false);
  assertNoSecret(without.body, DUMMY_KEY, "features payload without a key");
});

test("a requested feature with no credential reports effective false and names the blocker", async (t) => {
  withEnv(t, { SMART_TRANSCRIPT_ENABLED: "true", GEMINI_API_KEY: undefined });
  const api = await server();
  t.after(() => api.close());

  const response = await api.call("/api/v5/features", { token: api.customerToken });
  assert.equal(response.status, 200);
  // Requested and effective are reported separately: the request is not pretended to have succeeded.
  assert.equal(response.body.smartTranscript.requested, true);
  assert.equal(response.body.smartTranscript.serverEnabled, false);
  assert.ok(
    response.body.smartTranscript.blockers.includes("no_gemini_api_key"),
    `blockers were ${JSON.stringify(response.body.smartTranscript.blockers)}`,
  );
  assert.equal(response.body.transcriptLab.realProviderCallsEnabled, false);
});

test("a malformed boolean falls back to the safe value and names the variable", async (t) => {
  withEnv(t, { SMART_TRANSCRIPT_ENABLED: "maybe", TRANSCRIPT_LAB_LIVE_CALLS: "sometimes", GEMINI_API_KEY: DUMMY_KEY });
  const api = await server();
  t.after(() => api.close());

  const response = await api.call("/api/v5/features", { token: api.customerToken });
  assert.equal(response.status, 200);
  assert.equal(response.body.smartTranscript.requested, false);
  assert.equal(response.body.smartTranscript.serverEnabled, false);
  assert.equal(response.body.transcriptLab.realProviderCallsRequested, false);
  assert.equal(response.body.transcriptLab.realProviderCallsEnabled, false);

  const errors = response.body.configurationErrors.join("\n");
  assert.match(errors, /SMART_TRANSCRIPT_ENABLED/);
  assert.match(errors, /TRANSCRIPT_LAB_LIVE_CALLS/);

  // A model outside the allowlist is also an effective-vs-requested case.
  process.env.TRANSCRIPT_MODEL = "gemini-does-not-exist";
  const badModel = await api.call("/api/v5/features", { token: api.customerToken });
  assert.equal(badModel.body.transcription.modelAllowed, false);
  assert.match(badModel.body.configurationErrors.join("\n"), /TRANSCRIPT_MODEL/);
  assert.equal(badModel.body.smartTranscript.serverEnabled, false);
});

// ---------------------------------------------------------------------------
// POST /api/v5/transcription/token
// ---------------------------------------------------------------------------

test("the transcription token endpoint requires a customer session", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  const attempts = guardProviderFetch(t);
  const api = await server();
  t.after(() => api.close());

  const anonymous = await api.call("/api/v5/transcription/token", { method: "POST", body: {} });
  assert.equal(anonymous.status, 401);

  const employee = await api.call("/api/v5/transcription/token", {
    method: "POST",
    token: api.employeeToken,
    body: {},
  });
  assert.equal(employee.status, 403);

  // The employee session is refused by the route guard, so the lane switch was
  // never even consulted, let alone the provider.
  assert.deepEqual(attempts, []);
});

test("a switched-off lane refuses with feature_disabled and reaches no provider", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, SMART_TRANSCRIPT_ENABLED: "false", TRANSCRIPT_LAB_LIVE_CALLS: "false" });
  const attempts = guardProviderFetch(t);
  resetIssuanceCounters();
  const api = await server();
  t.after(() => api.close());

  const lab = await api.call("/api/v5/transcription/token", {
    method: "POST",
    token: api.customerToken,
    body: {},
  });
  assert.equal(lab.status, 503);
  assert.equal(lab.body.code, "feature_disabled");
  assert.ok(lab.body.blockers.includes("real_provider_calls_disabled"));
  assert.equal(lab.body.recovery, "state_that_the_helper_is_unavailable_and_continue");
  assertNoSecret(lab.body, DUMMY_KEY, "refusal body");

  const helper = await api.call("/api/v5/transcription/token", {
    method: "POST",
    token: api.customerToken,
    body: { lane: "live-helper" },
  });
  assert.equal(helper.status, 503);
  assert.equal(helper.body.code, "feature_disabled");
  assert.ok(helper.body.blockers.includes("disabled_by_server_configuration"));

  // Nothing left the process.
  assert.deepEqual(attempts, []);

  // Proved a second way, at the seam, with an injected spy that would record
  // even a call the network guard could not see.
  const provider = fakeProvider();
  await assert.rejects(
    () => createTranscriptionToken({
      session: customerSession(),
      body: {},
      features: effectiveFeatures(),
      fetchImpl: provider.impl,
    }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "feature_disabled");
      return true;
    },
  );
  assert.equal(provider.calls.length, 0, "a disabled lane still called the provider");
});

// ---------------------------------------------------------------------------
// The server-side allowlist
// ---------------------------------------------------------------------------

test("resolveTranscriptionRequest returns the server's own default configuration", () => {
  const resolved = resolveTranscriptionRequest();
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.liveConfig, {
    responseModalities: ["TEXT"],
    inputAudioTranscription: { languageCodes: [], mode: "SMART" },
  });
  assert.equal(resolved.model, ALLOWED_TRANSCRIPTION_MODELS[0]);
  assert.equal(resolved.lane, "lab");
  assert.equal(resolved.vocabularyTermCount, 0);
  // An empty object must resolve identically to no argument at all.
  assert.deepEqual(resolveTranscriptionRequest({}).liveConfig, resolved.liveConfig);
});

test("resolveTranscriptionRequest refuses anything outside the allowlists", () => {
  const refusals = [
    ["model", { model: "gemini-3.1-flash-live-preview" }],
    ["model", { model: "gemini-3.5-transcribe-live-preview" }],
    ["model", { model: "models/gemini-3.5-transcribe-live" }],
    ["model", { model: "" }],
    ["model", { model: null }],
    ["mode", { mode: "DIARIZED" }],
    ["mode", { mode: "" }],
    ["languageCodes", { languageCodes: ["fr-FR"] }],
    ["languageCodes", { languageCodes: ["en-IN", "ja-JP"] }],
    ["languageCodes", { languageCodes: "en-IN" }],
    ["languageCodes", { languageCodes: ["en-IN", "en-US", "en-GB", "hi-IN", "en-IN"] }],
    ["lane", { lane: "voice-core" }],
  ];
  for (const [field, body] of refusals) {
    const resolved = resolveTranscriptionRequest(body);
    assert.equal(resolved.ok, false, `${JSON.stringify(body)} was accepted`);
    assert.equal(resolved.field, field, `${JSON.stringify(body)} blamed the wrong field`);
    assert.equal(typeof resolved.error, "string");
    assert.equal(resolved.liveConfig, undefined, "a refusal still produced a provider config");
  }

  // Every allowlisted value is accepted, so the refusals above are not a
  // blanket "no" that would pass this test for the wrong reason.
  for (const mode of ALLOWED_TRANSCRIPTION_MODES) {
    assert.equal(resolveTranscriptionRequest({ mode }).ok, true, `${mode} was refused`);
  }
  for (const code of ALLOWED_LANGUAGE_CODES) {
    const resolved = resolveTranscriptionRequest({ languageCodes: [code] });
    assert.equal(resolved.ok, true, `${code} was refused`);
    assert.deepEqual(resolved.liveConfig.inputAudioTranscription.languageCodes, [code]);
  }
  for (const lane of ["lab", "live-helper"]) {
    assert.equal(resolveTranscriptionRequest({ lane }).ok, true);
  }
});

test("resolveTranscriptionRequest refuses every unexpected field", () => {
  const permitted = ["model", "mode", "languageCodes", "useProductVocabulary", "lane"];
  const hostile = [
    "systemInstruction",
    "tools",
    "speechConfig",
    "responseModalities",
    "inputAudioTranscription",
    "customVocabulary",
    "outputAudioTranscription",
    "uses",
    "expireTime",
    "liveConnectConstraints",
    "apiKey",
    "constructor",
    "prototype",
    "toString",
  ];
  for (const field of hostile) {
    const resolved = resolveTranscriptionRequest({ [field]: "anything" });
    assert.equal(resolved.ok, false, `${field} was accepted`);
    assert.equal(resolved.field, field);
  }

  // `__proto__` only becomes an own property through JSON.parse, which is
  // exactly how it arrives from express. Built as a literal it would set the
  // prototype instead and Object.keys would not see it.
  const parsed = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.deepEqual(Object.keys(parsed), ["__proto__"]);
  const protoResolved = resolveTranscriptionRequest(parsed);
  assert.equal(protoResolved.ok, false, "__proto__ was accepted as a request field");
  assert.equal(protoResolved.field, "__proto__");

  // A permitted field alongside a hostile one is still a whole-request refusal:
  // no partial merge.
  const mixed = resolveTranscriptionRequest({ mode: "VERBATIM", tools: [] });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.liveConfig, undefined);

  assert.deepEqual(permitted.filter((field) => !resolveTranscriptionRequest({ [field]: undefined }).ok), []);
});

test("resolveTranscriptionRequest refuses arrays and non-objects", () => {
  for (const body of [[], [{ mode: "SMART" }], "SMART", 42, true, null, NaN, () => {}]) {
    const resolved = resolveTranscriptionRequest(body);
    assert.equal(resolved.ok, false, `${String(body)} was accepted`);
  }
  // A function is typeof "function", so it takes the non-object branch too.
  assert.equal(resolveTranscriptionRequest(() => {}).field, "body");
  assert.equal(resolveTranscriptionRequest([]).field, "body");
  assert.equal(resolveTranscriptionRequest(null).field, "body");
});

test("useProductVocabulary accepts booleans only", () => {
  for (const value of ["true", "false", 1, 0, [], {}, null]) {
    const resolved = resolveTranscriptionRequest({ useProductVocabulary: value });
    assert.equal(resolved.ok, false, `${JSON.stringify(value)} was accepted`);
    assert.equal(resolved.field, "useProductVocabulary");
  }

  const off = resolveTranscriptionRequest({ useProductVocabulary: false });
  assert.equal(off.ok, true);
  assert.equal(off.vocabularyTermCount, 0);
  assert.equal("customVocabulary" in off.liveConfig.inputAudioTranscription, false);

  const on = resolveTranscriptionRequest({ useProductVocabulary: true });
  assert.equal(on.ok, true);
  assert.equal(on.vocabularyTermCount, PRODUCT_VOCABULARY.length);
  assert.deepEqual(on.liveConfig.inputAudioTranscription.customVocabulary, [...PRODUCT_VOCABULARY]);
  // A copy, so a caller cannot edit the shared allowlist through the result.
  on.liveConfig.inputAudioTranscription.customVocabulary.push("Refund everything");
  assert.equal(PRODUCT_VOCABULARY.includes("Refund everything"), false);
});

test("a prototype-poisoning body is refused and pollutes nothing", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  const attempts = guardProviderFetch(t);
  const api = await server();
  t.after(() => api.close());

  const bodies = [
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"__proto__":{"lane":"live-helper"},"mode":"SMART"}',
  ];
  for (const rawBody of bodies) {
    const response = await api.call("/api/v5/transcription/token", {
      method: "POST",
      token: api.customerToken,
      rawBody,
    });
    assert.equal(response.status, 400, `${rawBody} was not refused`);
    assert.equal(response.body.code, "invalid_transcription_request");
  }

  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal([].polluted, undefined);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
  assert.equal(resolveTranscriptionRequest({}).lane, "lab");
  assert.deepEqual(attempts, []);
});

// ---------------------------------------------------------------------------
// What actually goes on the wire
// ---------------------------------------------------------------------------

test("the token request body is exactly the server's own choice", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true", TRANSCRIPT_LAB_ENABLED: "true" });
  resetIssuanceCounters();
  const features = effectiveFeatures();
  assert.equal(features.transcriptLab.realProviderCallsEnabled, true, "the lane under test was not enabled");

  const provider = fakeProvider();
  const clientBody = { mode: "VERBATIM", languageCodes: ["en-IN"], useProductVocabulary: true };
  const credential = await createTranscriptionToken({
    session: customerSession("hash-body"),
    body: clientBody,
    features,
    now: 0,
    fetchImpl: provider.impl,
  });

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].url, `https://${PROVIDER_HOST}/v1beta/auth_tokens`);
  assert.equal(provider.calls[0].init.method, "POST");

  const sent = JSON.parse(provider.calls[0].init.body);
  assert.deepEqual(
    Object.keys(sent).sort(),
    ["expireTime", "liveConnectConstraints", "newSessionExpireTime", "uses"],
  );
  assert.equal(sent.uses, TRANSCRIPTION_LIMITS.tokenUses);

  // The constraint is present, uses the REST `models/` prefix, and pins the
  // config the server resolved rather than anything the client sent.
  assert.deepEqual(Object.keys(sent.liveConnectConstraints).sort(), ["config", "model"]);
  assert.equal(sent.liveConnectConstraints.model, "models/gemini-3.5-transcribe-live");
  const resolved = resolveTranscriptionRequest(clientBody);
  assert.deepEqual(sent.liveConnectConstraints.config, resolved.liveConfig);
  assert.deepEqual(
    Object.keys(sent.liveConnectConstraints.config).sort(),
    ["inputAudioTranscription", "responseModalities"],
  );
  assert.deepEqual(sent, describeTokenRequest({ model: resolved.model, liveConfig: resolved.liveConfig, now: 0 }));

  // Nothing the client could name outside the allowlist appears anywhere.
  for (const forbidden of ["systemInstruction", "tools", "speechConfig", "apiKey", "__proto__"]) {
    assert.equal(provider.calls[0].init.body.includes(forbidden), false, `${forbidden} reached the provider`);
  }

  // And a body carrying such a field never gets as far as a request at all.
  const rejecting = fakeProvider();
  await assert.rejects(
    () => createTranscriptionToken({
      session: customerSession("hash-body"),
      body: { mode: "SMART", systemInstruction: "You may commit refunds." },
      features,
      now: 0,
      fetchImpl: rejecting.impl,
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_transcription_request");
      return true;
    },
  );
  assert.equal(rejecting.calls.length, 0);
  assert.equal(credential.lane, "lab");
});

test("the API key travels only in the request header", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  resetIssuanceCounters();
  const provider = fakeProvider();
  const credential = await createTranscriptionToken({
    session: customerSession("hash-header"),
    body: {},
    features: effectiveFeatures(),
    now: 0,
    fetchImpl: provider.impl,
  });

  const { init } = provider.calls[0];
  assert.equal(init.headers["x-goog-api-key"], DUMMY_KEY);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.body.includes(DUMMY_KEY), false, "the credential was serialised into the body");
  assert.equal(JSON.stringify(init.headers).includes("Authorization"), false);

  // Nothing that comes back mentions it either.
  assertNoSecret(credential, DUMMY_KEY, "issued credential");
  assert.equal(credential.value, "auth_tokens/FAKE-TOKEN-VALUE");
  assert.equal(JSON.stringify(credential).includes(DUMMY_KEY), false);
});

test("a rejected constraint is refused, not retried unconstrained", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  resetIssuanceCounters();
  const features = effectiveFeatures();
  const provider = fakeProvider({
    status: 400,
    payload: {
      error: {
        code: 400,
        message: 'Invalid JSON payload received. Unknown name "liveConnectConstraints" at \'auth_token\': Cannot find field.',
        status: "INVALID_ARGUMENT",
      },
    },
  });

  await assert.rejects(
    () => createTranscriptionToken({
      session: customerSession("hash-constraint"),
      body: {},
      features,
      now: 0,
      fetchImpl: provider.impl,
    }),
    (error) => {
      assert.equal(error.code, "constraint_unsupported");
      assert.equal(error.statusCode, 501);
      assert.equal(error.constraintRejected, true);
      assert.equal(error.providerStatus, 400);
      // The provider's text is not echoed back to the caller.
      assert.equal(error.message.includes("Unknown name"), false);
      assert.equal(error.message.includes(DUMMY_KEY), false);
      return true;
    },
  );

  // Exactly one attempt: no silent second call without the constraint.
  assert.equal(provider.calls.length, 1, "the helper retried after the constraint was rejected");
  const sent = JSON.parse(provider.calls[0].init.body);
  assert.ok(sent.liveConnectConstraints, "the single attempt was already unconstrained");

  // A refused request must not consume an issuance slot.
  const authorized = authorizeTranscriptionToken({ session: customerSession("hash-constraint"), body: {}, features });
  assert.equal(authorized.priorIssuedThisHour, 0);

  // A generic refusal is reported differently and does not claim the constraint failed.
  const generic = fakeProvider({ status: 429, payload: { error: { message: "Quota exceeded." } } });
  await assert.rejects(
    () => createTranscriptionToken({
      session: customerSession("hash-generic"),
      body: {},
      features,
      now: 0,
      fetchImpl: generic.impl,
    }),
    (error) => {
      assert.equal(error.code, "token_refused");
      assert.equal(error.constraintRejected, false);
      assert.equal(error.statusCode, 429);
      return true;
    },
  );
  assert.equal(generic.calls.length, 1);
});

test("per-session issuance is capped", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  resetIssuanceCounters();
  const features = effectiveFeatures();
  const limit = TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour;
  const provider = fakeProvider();
  const session = customerSession("hash-rate-limited");

  for (let index = 0; index < limit; index += 1) {
    const credential = await createTranscriptionToken({
      session,
      body: {},
      features,
      now: index,
      fetchImpl: provider.impl,
    });
    assert.equal(credential.constrained, true);
  }
  assert.equal(provider.calls.length, limit);

  await assert.rejects(
    () => createTranscriptionToken({ session, body: {}, features, now: limit, fetchImpl: provider.impl }),
    (error) => {
      assert.equal(error.code, "token_rate_limited");
      assert.equal(error.statusCode, 429);
      assert.equal(error.limit, limit);
      return true;
    },
  );
  // The refused request never reached the provider.
  assert.equal(provider.calls.length, limit);

  // The cap is per session, so one noisy tab cannot lock out another.
  const other = await createTranscriptionToken({
    session: customerSession("hash-a-different-session"),
    body: {},
    features,
    now: limit,
    fetchImpl: provider.impl,
  });
  assert.equal(other.constrained, true);
  assert.equal(provider.calls.length, limit + 1);

  // And the counter is genuinely cleared rather than merely reported clear.
  resetIssuanceCounters();
  assert.equal(authorizeTranscriptionToken({ session, body: {}, features }).priorIssuedThisHour, 0);
});

test("the issued credential does not claim provider-side enforcement", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, TRANSCRIPT_LAB_LIVE_CALLS: "true" });
  resetIssuanceCounters();
  const provider = fakeProvider();
  const credential = await createTranscriptionToken({
    session: customerSession("hash-claims"),
    body: {},
    features: effectiveFeatures(),
    now: 0,
    fetchImpl: provider.impl,
  });

  assert.equal(credential.constrained, true);
  assert.equal(credential.constraintFieldSent, "liveConnectConstraints");
  assert.equal(credential.constraintEnforcementVerified, false);
  assert.match(credential.constraintNote, /not been independently observed/i);
  assert.equal(credential.uses, TRANSCRIPTION_LIMITS.tokenUses);
  assert.equal(credential.audioContract.sampleRate, 16000);
  assert.equal(credential.audioContract.channels, 1);
  assert.equal(credential.audioContract.mimeType, "audio/pcm;rate=16000");
  assert.ok(credential.audioContract.maxSessionSeconds < credential.audioContract.providerSessionCapSeconds);
  // No fabricated confidence anywhere on the credential.
  assert.equal("confidence" in credential, false);
  assert.equal("accuracy" in credential, false);
});

// ---------------------------------------------------------------------------
// The V1-V4 isolation guard
// ---------------------------------------------------------------------------

test("the database guard allows only :memory: and paths inside V5", () => {
  // Every case below is a pure string decision. Nothing here creates, opens or
  // writes a file: attempting a real mutation against a frozen project is the
  // exact thing this guard exists to prevent.
  assert.equal(assertV5DatabasePath(":memory:"), ":memory:");
  assert.equal(isInsideV5(":memory:"), true);

  const inside = join(V5_PROJECT_ROOT, "data", "actionguard-v5.db");
  assert.equal(assertV5DatabasePath(inside), resolve(inside));
  assert.equal(isInsideV5(join(V5_PROJECT_ROOT, "data", "nested", "deep.db")), true);

  // A relative path is resolved against process.cwd(), exactly as node:sqlite
  // would resolve it, so the bare ".." case only means anything from the root.
  assert.equal(resolve("."), V5_PROJECT_ROOT, "run this suite from the project root");

  const refused = [
    ["a frozen sibling project", join(V5_PROJECT_ROOT, "..", "Prodapt IPL project V4", "data", "actionguard.db")],
    ["traversal back out and in", join(V5_PROJECT_ROOT, "data", "..", "..", "Prodapt IPL project V4", "data", "actionguard.db")],
    ["a sibling with the root as a name prefix", join(`${V5_PROJECT_ROOT}-evil`, "actionguard.db")],
    ["the project root itself", V5_PROJECT_ROOT],
    ["the parent directory", resolve(V5_PROJECT_ROOT, "..")],
    ["a bare parent reference", ".."],
    ["a parent reference with a filename", join("..", "actionguard.db")],
  ];
  for (const [label, candidate] of refused) {
    assert.equal(isInsideV5(candidate), false, `${label} was treated as inside V5: ${candidate}`);
    assert.throws(
      () => assertV5DatabasePath(candidate),
      (error) => {
        assert.equal(error.code, "database_outside_v5", label);
        assert.equal(error.statusCode, 400, label);
        assert.match(error.message, /Refusing to open a database outside this V5 project/);
        return true;
      },
      label,
    );
  }

  if (process.platform === "win32") {
    for (const candidate of ["D:\\evil.db", "\\\\fileserver\\share\\evil.db"]) {
      assert.equal(isInsideV5(candidate), false, `${candidate} was treated as inside V5`);
      assert.throws(() => assertV5DatabasePath(candidate), /Refusing to open a database/);
    }
  }

  // The root is injectable, so the rule is a containment rule and not a
  // hard-coded string match on this one machine.
  assert.equal(isInsideV5("/srv/app/data/x.db", "/srv/app"), true);
  assert.equal(isInsideV5("/srv/other/data/x.db", "/srv/app"), false);
});

// ---------------------------------------------------------------------------
// The inherited V4 surface
// ---------------------------------------------------------------------------

test("health still answers and now carries the v5 block", async (t) => {
  withEnv(t, { GEMINI_API_KEY: DUMMY_KEY, VOICE_STYLE: "natural", SMART_TRANSCRIPT_ENABLED: "nonsense" });
  const api = await server();
  t.after(() => api.close());

  const health = await api.call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.voice.configured, true);
  assert.equal(health.body.flightRecorder.enabled, true);

  assert.ok(health.body.v5, "the health payload has no v5 block");
  assert.equal(health.body.v5.version, "0.5.0");
  assert.equal(health.body.v5.voiceStyle, "natural");
  assert.equal(health.body.v5.smartTranscriptEnabled, false);
  assert.ok(Array.isArray(health.body.v5.configurationErrors), "v5.configurationErrors is not an array");
  assert.match(health.body.v5.configurationErrors.join("\n"), /SMART_TRANSCRIPT_ENABLED/);

  // Health is unauthenticated, so it must be especially free of secrets.
  assertNoSecret(health.body, DUMMY_KEY, "health payload");
  assert.equal(health.text.includes(DUMMY_KEY), false);
});

test("the inherited V4 endpoints still behave", async (t) => {
  const api = await server();
  t.after(() => api.close());

  const me = await api.call("/api/me", { token: api.customerToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, "customer");

  const context = await api.call("/api/voice/account-context", { token: api.customerToken });
  assert.equal(context.status, 200);
  assert.equal(context.body.account.currentPlan.id, "PLAN-PREMIUM");
  assert.equal(context.body.currency, "INR");

  const plans = await api.call("/api/plans", { token: api.customerToken });
  assert.equal(plans.status, 200);
  assert.ok(plans.body.length >= 2);

  const dashboard = await api.call("/api/employee/dashboard", { token: api.employeeToken });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.stats.moneyIssued, 0);

  // The role boundaries are unchanged in both directions.
  assert.equal((await api.call("/api/employee/dashboard", { token: api.customerToken })).status, 403);
  assert.equal((await api.call("/api/customer/dashboard", { token: api.employeeToken })).status, 403);
  assert.equal((await api.call("/api/policy", { token: api.customerToken })).status, 403);
  assert.equal((await api.call("/api/me")).status, 401);

  // Adding the V5 lanes did not open a write path: no business row exists yet.
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM service_requests").get().n, 0);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM action_intents").get().n, 0);
});
