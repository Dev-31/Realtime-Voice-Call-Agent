/**
 * Server-owned allowlist of conversation engines.
 *
 * WHY THE SERVER CHOOSES THE MODEL
 * --------------------------------
 * The owner asked whether the agent can convey emotion. Google documents an
 * affective-dialogue option, but only on the 2.5 live model - the capabilities
 * matrix lists it as "Not supported" on `gemini-3.1-flash-live-preview`, which
 * is what V5 runs today. So "add emotions" is really "try a different model",
 * and a model choice must never come from the browser: V5's whole security
 * posture is that the server decides what a credential unlocks.
 *
 * The client therefore asks for a MODE. This file maps a mode to a model and to
 * the extra config that mode implies. Anything unrecognised is refused.
 *
 * WHAT IS DOCUMENTED (checked 2026-09-03, capabilities + pricing pages)
 * --------------------------------------------------------------------
 * Gemini 3.1 Flash Live Preview:
 *   affective dialogue     Not supported
 *   proactive audio        Not supported
 *   async function calling Not supported (sequential only)
 * Gemini 2.5 Flash Live Preview:
 *   affective dialogue     Supported. "The model adapts its response style to
 *                          match the expression and tone of the input."
 *                          Set `enable_affective_dialog` to true. Requires v1beta.
 *   proactive audio        Supported (deliberately NOT enabled here - see below)
 *   async function calling Supported
 *
 * WHAT IS NOT VERIFIED
 * --------------------
 * That the 2.5 model works with THIS agent's exact configuration - two business
 * tools, input and output transcription, START_OF_ACTIVITY_INTERRUPTS, and the
 * mid-conversation heard-state note. Each is documented as supported, but
 * documented is not observed. `expressive` is therefore experimental, defaults
 * to off, and is labelled as unproven everywhere it appears.
 *
 * Nor is it verified that affective dialogue actually sounds better. Google's
 * claim is that the model adapts to the input's tone. Whether a listener
 * prefers that is exactly what the owner's A/B is for. Changing model alone
 * proves nothing.
 *
 * PROACTIVE AUDIO IS DELIBERATELY LEFT OFF
 * ----------------------------------------
 * It lets the model decide not to respond. In a billing call, silence that the
 * caller cannot distinguish from a fault is worse than an unnecessary reply, and
 * it would confound every interruption measurement. Not enabled.
 */

/** V4's engine. The baseline for every comparison. */
export const DEFAULT_VOICE_MODE = "standard";

const MODES = Object.freeze({
  standard: Object.freeze({
    id: "standard",
    label: "Standard",
    model: "gemini-3.1-flash-live-preview",
    apiVersion: "v1beta",
    affectiveDialog: false,
    experimental: false,
    description: "The V4 engine. Gemini 3.1 native audio. This is the comparison baseline.",
    tradeoffs: "No provider-side tone adaptation: 3.1 does not support affective dialogue.",
  }),
  expressive: Object.freeze({
    id: "expressive",
    label: "Expressive",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    apiVersion: "v1beta",
    affectiveDialog: true,
    experimental: true,
    description:
      "Gemini 2.5 native audio with affective dialogue on. Google documents this as the model adapting its response style to the expression and tone of the input.",
    tradeoffs:
      "A different model, so voice character, latency and turn-taking all change together. Nothing here is verified against this agent's tools, transcription or interruption path. Treat any difference as unattributed until the owner has listened to both.",
  }),
});

export const VOICE_MODES = Object.freeze(Object.keys(MODES));

export function voiceModeCatalogue() {
  return VOICE_MODES.map((id) => {
    const { model, apiVersion, ...safe } = MODES[id];
    // The model id is fine to publish; it is not a secret and the report needs it.
    return { ...safe, model };
  });
}

/**
 * Resolve a requested mode into the server's own choice.
 *
 * Unknown values fall back to `standard` rather than throwing, and say so, so a
 * stale browser cannot break a call - but also cannot quietly get a different
 * engine than the report claims.
 */
export function resolveVoiceMode(requested) {
  const value = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (Object.hasOwn(MODES, value)) {
    return { mode: MODES[value], requested: requested ?? null, fellBack: false, reason: null };
  }
  return {
    mode: MODES[DEFAULT_VOICE_MODE],
    requested: requested ?? null,
    fellBack: true,
    reason: value ? "unknown_voice_mode" : "no_voice_mode_supplied",
  };
}

/**
 * Whether the expressive experiment may be offered at all.
 *
 * Gated separately from the mode list so it can be shipped disabled. The UI
 * cannot turn on what the server reports as unavailable.
 */
export function expressiveModeEnabled() {
  return String(process.env.VOICE_EXPRESSIVE_ENABLED || "false").trim().toLowerCase() === "true";
}
