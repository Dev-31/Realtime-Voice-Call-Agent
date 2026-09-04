/**
 * Short-lived credential issuance for the dedicated transcription lane.
 *
 * WHY THIS IS NOT V4's TOKEN HELPER
 * ---------------------------------
 * V4's `server/agent/gemini-live.js` asks for a token with `{uses, expireTime,
 * newSessionExpireTime}` and nothing else. That token is unconstrained: whoever
 * holds it can open a Live session against ANY model with ANY configuration,
 * including a full conversational model with tools. That was acceptable there
 * because the same authenticated caller was going to open the voice session
 * anyway -- but it is not acceptable as the pattern for a second, wider surface.
 *
 * So this endpoint pins the token to one model AND one configuration using the
 * provider's `liveConnectConstraints` field, which the installed
 * @google/genai 2.20.0 declares on `CreateAuthTokenConfig` and which Google's
 * live-transcription documentation demonstrates with this exact model.
 *
 * Two independent guards, because a provider-side constraint we have not yet
 * observed being enforced is not something to rely on alone:
 *
 *   1. The server chooses the model and config from its own allowlist. Nothing
 *      a client sends is forwarded to the provider.
 *   2. `liveConnectConstraints` locks the issued token to that same choice.
 *
 * Guard 1 is fully covered by the local test suite. Guard 2 depends on the
 * provider honouring the field, which is recorded as UNVERIFIED in
 * docs/V5_TEST_RESULTS.md until a real smoke test observes it.
 *
 * Nothing here ever logs, returns or embeds GEMINI_API_KEY.
 */

import { effectiveFeatures } from "../config/features.js";
import { TRANSCRIPTION_LIMITS, resolveTranscriptionRequest } from "./config.js";

const AUTH_TOKEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

/**
 * Per-session issuance counter, in memory only.
 *
 * A bounded map keyed by the caller's session token hash. This is a brake on
 * accidental reconnect storms, not a billing control.
 */
const issuance = new Map();

function pruneIssuance(now) {
  for (const [key, stamps] of issuance) {
    const recent = stamps.filter((at) => now - at < 60 * 60 * 1000);
    if (recent.length) issuance.set(key, recent);
    else issuance.delete(key);
  }
}

export function resetIssuanceCounters() {
  issuance.clear();
}

function failure(message, statusCode, code, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Decide whether this request may have a transcription credential at all.
 *
 * Split out from the network call so the whole decision is unit-testable with
 * no provider involved.
 */
export function authorizeTranscriptionToken({ session, body = {}, features = effectiveFeatures(), now = Date.now() }) {
  if (!session) {
    throw failure("Please sign in.", 401, "not_authenticated");
  }
  if (session.role !== "customer") {
    throw failure("The transcription helper is only available to the caller workspace.", 403, "wrong_role");
  }

  const resolved = resolveTranscriptionRequest(body);
  if (!resolved.ok) {
    throw failure(resolved.error, 400, "invalid_transcription_request", { field: resolved.field });
  }

  // The server switch is the real control. A disabled feature refuses here, so
  // no credential exists for a client to use even if it hides the UI check.
  const laneEnabled = resolved.lane === "live-helper"
    ? features.smartTranscript.serverEnabled
    : features.transcriptLab.realProviderCallsEnabled;

  if (!laneEnabled) {
    const blockers = resolved.lane === "live-helper"
      ? features.smartTranscript.blockers
      : [
        ...(features.transcriptLab.realProviderCallsRequested ? [] : ["real_provider_calls_disabled"]),
        ...(features.credentials.geminiApiKeyPresent ? [] : ["no_gemini_api_key"]),
        ...(features.transcription.modelAllowed ? [] : ["model_not_in_allowlist"]),
      ];
    throw failure(
      resolved.lane === "live-helper"
        ? "The live transcription helper is switched off on this server."
        : "Real transcription calls from the lab are switched off on this server.",
      503,
      "feature_disabled",
      { blockers, recovery: "state_that_the_helper_is_unavailable_and_continue" },
    );
  }

  pruneIssuance(now);
  const key = String(session.token_hash || session.principal_id || "unknown");
  const stamps = issuance.get(key) || [];
  if (stamps.length >= TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour) {
    throw failure(
      "This session has requested too many transcription credentials in the last hour.",
      429,
      "token_rate_limited",
      { limit: TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour },
    );
  }

  return { resolved, issuanceKey: key, priorIssuedThisHour: stamps.length };
}

function recordIssuance(key, now) {
  const stamps = issuance.get(key) || [];
  stamps.push(now);
  issuance.set(key, stamps);
}

/**
 * Issue a constrained, short-lived transcription credential.
 *
 * `fetchImpl` is injectable so the test suite can assert the exact request body
 * without touching the network.
 */
export async function createTranscriptionToken({
  session,
  body = {},
  features = effectiveFeatures(),
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const { resolved, issuanceKey } = authorizeTranscriptionToken({ session, body, features, now });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw failure("Transcription is not configured on this server.", 503, "no_credential");
  }

  const expireTime = new Date(now + TRANSCRIPTION_LIMITS.tokenExpirySeconds * 1000).toISOString();
  const newSessionExpireTime = new Date(now + TRANSCRIPTION_LIMITS.tokenNewSessionSeconds * 1000).toISOString();

  /**
   * The constrained request. `liveConnectConstraints.model` uses the REST
   * `models/` prefix, as the provider's REST documentation requires; the SDKs
   * take the bare ID.
   */
  const requestBody = {
    uses: TRANSCRIPTION_LIMITS.tokenUses,
    expireTime,
    newSessionExpireTime,
    liveConnectConstraints: {
      model: `models/${resolved.model}`,
      config: resolved.liveConfig,
    },
  };

  let response;
  let payload;
  try {
    response = await fetchImpl(AUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    payload = await response.json();
  } catch (error) {
    // Never echo the error verbatim: a transport error can carry the request URL.
    throw failure("The transcription credential service could not be reached.", 502, "token_transport_error", {
      detail: error?.name || "network_error",
    });
  }

  if (!response.ok || !payload?.name) {
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "";
    // A rejected `liveConnectConstraints` is the interesting failure: it means
    // the field name is wrong for this route and the token would be
    // UNCONSTRAINED. Refuse rather than retrying without the constraint.
    const constraintRejected = /liveConnectConstraints|live_connect_constraints|Unknown name/i.test(providerMessage);
    throw failure(
      constraintRejected
        ? "The provider rejected the constrained transcription credential request. Refusing to fall back to an unconstrained credential."
        : "The transcription credential request was refused.",
      constraintRejected ? 501 : (response.status >= 400 && response.status < 600 ? response.status : 502),
      constraintRejected ? "constraint_unsupported" : "token_refused",
      { providerStatus: response.status, constraintRejected },
    );
  }

  recordIssuance(issuanceKey, now);

  return {
    value: payload.name,
    expiresAt: expireTime,
    newSessionExpiresAt: newSessionExpireTime,
    uses: TRANSCRIPTION_LIMITS.tokenUses,
    lane: resolved.lane,
    model: resolved.model,
    mode: resolved.mode,
    languageCodes: resolved.languageCodes,
    vocabularyTermCount: resolved.vocabularyTermCount,
    constrained: true,
    constraintFieldSent: "liveConnectConstraints",
    constraintEnforcementVerified: false,
    constraintNote:
      "The server sent a model-and-config-locked credential request. Provider-side enforcement of that lock has not been independently observed by this build; see docs/V5_TEST_RESULTS.md.",
    audioContract: {
      sampleRate: TRANSCRIPTION_LIMITS.inputSampleRate,
      channels: TRANSCRIPTION_LIMITS.inputChannels,
      mimeType: TRANSCRIPTION_LIMITS.inputMimeType,
      maxSessionSeconds: TRANSCRIPTION_LIMITS.maxHelperSessionSeconds,
      providerSessionCapSeconds: TRANSCRIPTION_LIMITS.providerSessionSeconds,
    },
  };
}

/** Exposed for tests: the exact body this module would send. */
export function describeTokenRequest({ model, liveConfig, now = 0 }) {
  return {
    uses: TRANSCRIPTION_LIMITS.tokenUses,
    expireTime: new Date(now + TRANSCRIPTION_LIMITS.tokenExpirySeconds * 1000).toISOString(),
    newSessionExpireTime: new Date(now + TRANSCRIPTION_LIMITS.tokenNewSessionSeconds * 1000).toISOString(),
    liveConnectConstraints: { model: `models/${model}`, config: liveConfig },
  };
}
