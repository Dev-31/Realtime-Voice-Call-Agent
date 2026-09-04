import { DEFAULT_VOICE_MODE, expressiveModeEnabled, resolveVoiceMode, voiceModeCatalogue } from "./voice-modes.js";

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export function geminiLiveModel() {
  return process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
}

export function voiceStatus() {
  return {
    configured: Boolean(process.env.GEMINI_API_KEY),
    provider: "gemini-live",
    label: "Gemini Live (direct)",
    model: geminiLiveModel(),
    transport: "websocket",
    turnDetection: "provider-native-automatic-vad",
    businessToolsEnabled: true,
    voiceTools: ["get_account_context", "submit_billing_request"],
    actionAuthority: "deterministic-server-policy-plus-heard-state",
    semanticVerifier: "none (removed: the V3 per-step verifier cost about 8.4 s p50)",
    voiceModes: voiceModeCatalogue(),
    expressiveModeAvailable: expressiveModeEnabled(),
  };
}

/**
 * Issue a short-lived credential for the conversation session.
 *
 * `requestedMode` comes from the browser but only ever selects from the
 * server-side allowlist in voice-modes.js; the browser never names a model.
 * An expressive request while the experiment is switched off is downgraded to
 * standard and reported, not silently honoured.
 */
export async function createVoiceClientToken({ requestedMode = DEFAULT_VOICE_MODE } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error("Gemini Live is not configured. Add GEMINI_API_KEY to .env.");
    error.statusCode = 503;
    throw error;
  }

  const resolution = resolveVoiceMode(requestedMode);
  let selected = resolution.mode;
  let downgraded = null;
  if (selected.experimental && !expressiveModeEnabled()) {
    downgraded = `${selected.id}_disabled_on_this_server`;
    selected = resolveVoiceMode(DEFAULT_VOICE_MODE).mode;
  }

  // GEMINI_LIVE_MODEL still overrides, but only for the baseline mode: an
  // override must not be able to redirect the experimental mode somewhere else.
  const model = selected.id === DEFAULT_VOICE_MODE ? geminiLiveModel() : selected.model;
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
  });
  const body = await response.json();
  if (!response.ok || !body.name) {
    const error = new Error(body?.error?.message || `Gemini token request failed (${response.status}).`);
    error.statusCode = response.status || 502;
    throw error;
  }
  return {
    value: body.name,
    expiresAt: expireTime,
    model,
    provider: "gemini-live",
    voiceMode: selected.id,
    requestedVoiceMode: resolution.requested,
    voiceModeFellBack: resolution.fellBack,
    voiceModeDowngraded: downgraded,
    apiVersion: selected.apiVersion,
    affectiveDialog: selected.affectiveDialog,
    experimental: selected.experimental,
  };
}
