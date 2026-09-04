/**
 * Server-side allowlist for the dedicated transcription lane.
 *
 * A browser may ask for a transcription credential. It may NOT choose which
 * model that credential unlocks, which transcription mode it uses, how long it
 * lives, or what vocabulary is attached. Everything a client can influence is
 * validated against the constants in this file, and anything unrecognised is
 * rejected rather than passed through to the provider.
 *
 * Provider facts below were read from Google's own documentation on 2026-09-03
 * and cross-checked against the installed @google/genai 2.20.0 type
 * definitions. Both sources are cited in docs/V5_DECISION_LOG.md.
 */

/** The only transcription models this server will ever issue a token for. */
export const ALLOWED_TRANSCRIPTION_MODELS = Object.freeze(["gemini-3.5-transcribe-live"]);

export const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe-live";

/**
 * `VERBATIM` is the provider default; `SMART` is the mode that removes
 * disfluencies and formats the text. Both come from the provider itself -- V5
 * adds no second cleanup model, per the build plan and F51.
 */
export const ALLOWED_TRANSCRIPTION_MODES = Object.freeze(["VERBATIM", "SMART"]);

/** BCP-47 hints we will accept. An empty list means provider auto-detection. */
export const ALLOWED_LANGUAGE_CODES = Object.freeze(["en-IN", "en-US", "en-GB", "hi-IN"]);

/**
 * A small product vocabulary, for RECOGNITION only.
 *
 * These are the plan names and domain nouns a caller is likely to say. They
 * bias the recogniser towards spelling them correctly. They grant no
 * permission, they are not matched at runtime, and they deliberately contain no
 * confirmation word, negation word, amount, or account field -- putting those
 * here would be exactly the keyword branching the scope guard forbids.
 */
export const PRODUCT_VOCABULARY = Object.freeze([
  "Prodapt",
  "Starter",
  "Essential",
  "Premium",
  "Business",
  "billing review",
  "plan change",
  "monthly price",
  "late payment fee",
  "reference number",
]);

/** Hard limits. Every one of these is enforced server-side. */
export const TRANSCRIPTION_LIMITS = Object.freeze({
  /** Provider-documented input format for gemini-3.5-transcribe-live. */
  inputSampleRate: 16000,
  inputChannels: 1,
  inputMimeType: "audio/pcm;rate=16000",
  /** Provider guidance: 100 ms chunks, 1,024-2,048 frames at 16 kHz. */
  chunkFrames: 1600,
  /** Lab clip caps, per the build plan section 7. */
  maxClipSeconds: 30,
  maxClipBytes: 8 * 1024 * 1024,
  maxClipsPerBatch: 8,
  /** Grace period after the last audio sample before a replay is called incomplete. */
  finalGraceMs: 10000,
  /** Startup timeout for a helper connection. */
  connectTimeoutMs: 5000,
  /**
   * Provider-documented session cap for live transcription: 10 minutes. The
   * documentation does NOT say session resumption or context-window compression
   * work on this model, so we do not assume they do.
   */
  providerSessionSeconds: 600,
  /** Our own per-session ceiling, kept below the provider's. */
  maxHelperSessionSeconds: 420,
  maxHelperAudioSeconds: 420,
  /** Bounded sidecar queue. Beyond this the helper degrades instead of growing. */
  maxQueuedChunks: 200,
  /** Token lifetimes. */
  tokenUses: 1,
  tokenNewSessionSeconds: 60,
  tokenExpirySeconds: 15 * 60,
  maxTokensPerSessionPerHour: 12,
});

export function isModelAllowed(model) {
  return ALLOWED_TRANSCRIPTION_MODELS.includes(String(model || ""));
}

export function isModeAllowed(mode) {
  return ALLOWED_TRANSCRIPTION_MODES.includes(String(mode || ""));
}

/**
 * Validate a client request and return the configuration the SERVER chose.
 *
 * The returned object is the only thing that reaches the provider. Unknown
 * fields are not merged, not logged verbatim and not echoed back: they are a
 * rejection. The caller gets `{ ok: false, error, field }` so the UI can say
 * what was wrong without leaking anything about the credential.
 */
export function resolveTranscriptionRequest(requested = {}) {
  if (requested === null || typeof requested !== "object" || Array.isArray(requested)) {
    return { ok: false, field: "body", error: "A transcription request must be an object." };
  }

  const permitted = new Set(["model", "mode", "languageCodes", "useProductVocabulary", "lane"]);
  const unexpected = Object.keys(requested).filter((key) => !permitted.has(key));
  if (unexpected.length) {
    return {
      ok: false,
      field: unexpected[0],
      error: `This endpoint does not accept ${unexpected.join(", ")}. The server chooses the transcription configuration.`,
    };
  }

  const model = requested.model === undefined ? DEFAULT_TRANSCRIPTION_MODEL : String(requested.model);
  if (!isModelAllowed(model)) {
    return { ok: false, field: "model", error: "That transcription model is not allowed on this server." };
  }

  const mode = requested.mode === undefined ? "SMART" : String(requested.mode).toUpperCase();
  if (!isModeAllowed(mode)) {
    return { ok: false, field: "mode", error: "Transcription mode must be VERBATIM or SMART." };
  }

  let languageCodes = [];
  if (requested.languageCodes !== undefined) {
    if (!Array.isArray(requested.languageCodes)) {
      return { ok: false, field: "languageCodes", error: "languageCodes must be an array." };
    }
    if (requested.languageCodes.length > ALLOWED_LANGUAGE_CODES.length) {
      return { ok: false, field: "languageCodes", error: "Too many language hints." };
    }
    const rejected = requested.languageCodes.filter((code) => !ALLOWED_LANGUAGE_CODES.includes(String(code)));
    if (rejected.length) {
      return { ok: false, field: "languageCodes", error: "That language hint is not in the allowlist." };
    }
    languageCodes = requested.languageCodes.map(String);
  }

  if (requested.useProductVocabulary !== undefined && typeof requested.useProductVocabulary !== "boolean") {
    return { ok: false, field: "useProductVocabulary", error: "useProductVocabulary must be true or false." };
  }
  const useProductVocabulary = requested.useProductVocabulary === true;

  const lane = requested.lane === undefined ? "lab" : String(requested.lane);
  if (!["lab", "live-helper"].includes(lane)) {
    return { ok: false, field: "lane", error: "lane must be lab or live-helper." };
  }

  /**
   * The exact shape the provider expects. `responseModalities: ["TEXT"]` and the
   * fields inside `inputAudioTranscription` are the documented live
   * transcription config. `automaticActivityDetection` is left at the provider
   * default so this lane endpoints its own segments as the documentation
   * describes.
   */
  const liveConfig = {
    responseModalities: ["TEXT"],
    inputAudioTranscription: {
      languageCodes,
      mode,
      ...(useProductVocabulary ? { customVocabulary: [...PRODUCT_VOCABULARY] } : {}),
    },
  };

  return {
    ok: true,
    lane,
    model,
    mode,
    languageCodes,
    useProductVocabulary,
    vocabularyTermCount: useProductVocabulary ? PRODUCT_VOCABULARY.length : 0,
    liveConfig,
  };
}

/** What /api/v5/features reports about this lane. Never includes a key. */
export function transcriptionConfigStatus() {
  const model = process.env.TRANSCRIPT_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
  const modelAllowed = isModelAllowed(model);
  const errors = modelAllowed
    ? []
    : [`TRANSCRIPT_MODEL=${model} is not in the server allowlist (${ALLOWED_TRANSCRIPTION_MODELS.join(", ")}).`];
  return {
    model,
    modelAllowed,
    allowedModels: ALLOWED_TRANSCRIPTION_MODELS,
    allowedModes: ALLOWED_TRANSCRIPTION_MODES,
    allowedLanguageCodes: ALLOWED_LANGUAGE_CODES,
    productVocabularyTerms: PRODUCT_VOCABULARY.length,
    productVocabularyRole: "recognition-bias-only-never-permission",
    limits: TRANSCRIPTION_LIMITS,
    providerFacts: {
      inputFormat: "raw 16-bit PCM, 16 kHz, mono, little-endian",
      mimeType: "audio/pcm;rate=16000",
      interimField: "serverContent.interimInputTranscription.text",
      finalField: "serverContent.inputTranscription.text",
      finalityFlag: null,
      finalityNote:
        "Live transcription has no isFinal/turnComplete flag. Finality is signalled by WHICH field arrives, so code must branch on field presence.",
      sessionCapSeconds: 600,
      documentation: "https://ai.google.dev/gemini-api/docs/live-api/live-transcribe",
      checked: "2026-09-03",
    },
    errors,
  };
}
