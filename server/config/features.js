/**
 * V5 feature configuration — the single authoritative source.
 *
 * Everything the UI, the call report and the token endpoint say about which V5
 * features are on comes from here. Two rules make that meaningful:
 *
 *   1. The SERVER decides. A browser cannot turn on a feature this file reports
 *      as disabled. `smartTranscript.serverEnabled === false` makes the token
 *      endpoint refuse, which is the only thing that actually matters -- hiding
 *      a panel is not a control.
 *   2. We report the EFFECTIVE value, not the requested one. If an environment
 *      variable is malformed we fall back to the safe value and say we did,
 *      rather than pretending the request succeeded.
 *
 * Rollback position: VOICE_STYLE=baseline and SMART_TRANSCRIPT_ENABLED=false
 * reproduce V4 behaviour without deleting a file.
 */

import { DEFAULT_VOICE_STYLE, VOICE_STYLES, resolveVoiceStyle } from "../../src/voice/delivery-style.js";
import { DEFAULT_PLAYBACK_MODE, PLAYBACK_LEAD_MS, PLAYBACK_MODES, resolvePlaybackMode } from "../../src/voice/playback-mode.js";
import { AUDITION_SET, DEFAULT_VOICE, VOICE_CATALOGUE, resolveVoice } from "../../src/voice/voices.js";
import { DEFAULT_VOICE_MODE, expressiveModeEnabled, resolveVoiceMode, voiceModeCatalogue } from "../agent/voice-modes.js";
import { TRANSCRIPTION_LIMITS, transcriptionConfigStatus } from "../transcription/config.js";

const BUILD_VERSION = "0.5.0";

function readBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { value: fallback, requested: null, fellBack: false };
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return { value: true, requested: raw, fellBack: false };
  if (["false", "0", "no", "off"].includes(normalized)) return { value: false, requested: raw, fellBack: false };
  return { value: fallback, requested: raw, fellBack: true };
}

/**
 * The effective V5 feature set.
 *
 * Safe defaults: the live transcription helper is OFF, real provider calls from
 * the lab are OFF, disk recording is OFF, delivery style is BASELINE. Only the
 * local, no-network lab is on by default.
 */
export function effectiveFeatures() {
  const style = resolveVoiceStyle(process.env.VOICE_STYLE || DEFAULT_VOICE_STYLE);
  const playback = resolvePlaybackMode(process.env.AUDIO_PLAYBACK_MODE || DEFAULT_PLAYBACK_MODE);
  const voice = resolveVoice(process.env.VOICE_NAME || DEFAULT_VOICE);
  const engine = resolveVoiceMode(process.env.VOICE_MODE || DEFAULT_VOICE_MODE);
  const smart = readBoolean("SMART_TRANSCRIPT_ENABLED", false);
  const lab = readBoolean("TRANSCRIPT_LAB_ENABLED", true);
  const labLive = readBoolean("TRANSCRIPT_LAB_LIVE_CALLS", false);
  const storeAudio = readBoolean("TRANSCRIPT_LAB_STORE_AUDIO", false);
  const transcription = transcriptionConfigStatus();

  const configurationErrors = [];
  if (style.fellBack && style.requested) {
    configurationErrors.push(`VOICE_STYLE=${style.requested} is not one of ${VOICE_STYLES.join("|")}; using baseline.`);
  }
  if (playback.fellBack && playback.requested) {
    configurationErrors.push(
      `AUDIO_PLAYBACK_MODE=${playback.requested} is not one of ${PLAYBACK_MODES.join("|")}; using ${DEFAULT_PLAYBACK_MODE}.`,
    );
  }
  for (const [name, result] of [
    ["SMART_TRANSCRIPT_ENABLED", smart],
    ["TRANSCRIPT_LAB_ENABLED", lab],
    ["TRANSCRIPT_LAB_LIVE_CALLS", labLive],
    ["TRANSCRIPT_LAB_STORE_AUDIO", storeAudio],
  ]) {
    if (result.fellBack) configurationErrors.push(`${name}=${result.requested} is not a boolean; using ${result.value}.`);
  }
  configurationErrors.push(...transcription.errors);

  // A dedicated transcription lane needs a credential and an allowlisted model.
  const credentialPresent = Boolean(process.env.GEMINI_API_KEY);
  const smartBlockers = [];
  if (!smart.value) smartBlockers.push("disabled_by_server_configuration");
  if (!credentialPresent) smartBlockers.push("no_gemini_api_key");
  if (!transcription.modelAllowed) smartBlockers.push("model_not_in_allowlist");

  return {
    build: {
      version: BUILD_VERSION,
      project: "Prodapt IPL project V5",
      note: "V5 is an isolated successor to V4. V1-V4 are frozen and unchanged.",
    },
    voice: {
      defaultStyle: style.style,
      availableStyles: VOICE_STYLES,
      styleSelectableBeforeCall: true,
      styleChangeDuringCall: false,
      requestedStyle: style.requested,
      styleFellBack: style.fellBack,
      /**
       * How the output audio context is created. `continuous` runs it at the
       * provider's own 24 kHz so the browser never resamples a chunk on its own;
       * `v4-compatible` reproduces V4 exactly, including the audible tick at
       * every chunk boundary that this setting exists to remove.
       */
      playbackMode: playback.mode,
      availablePlaybackModes: PLAYBACK_MODES,
      playbackModeRequested: playback.requested,
      playbackModeFellBack: playback.fellBack,
      providerOutputSampleRate: 24000,
      /** Voice identity. One documented string; no new provider involved. */
      voice: voice.voice,
      voiceFellBack: voice.fellBack,
      voiceRequested: voice.requested,
      auditionVoices: AUDITION_SET,
      allVoices: VOICE_CATALOGUE,
      voiceNote:
        "Google publishes a one-word descriptor per voice but no gender, accent or language affinity, and native-audio models choose the language automatically rather than accepting a language code. So a descriptor is a reason to audition a voice, never evidence of how it sounds.",
      /** Conversation engine. The server owns the model choice. */
      engineMode: engine.mode.id,
      engineModel: engine.mode.model,
      engineAffectiveDialog: engine.mode.affectiveDialog,
      engineExperimental: engine.mode.experimental,
      availableEngines: voiceModeCatalogue(),
      expressiveAvailable: expressiveModeEnabled(),
      playbackLeadMs: PLAYBACK_LEAD_MS,
      playbackModeNote:
        "Gemini output is documented as 24 kHz. If the browser's output context runs at a different rate it resamples every chunk independently, which leaves a discontinuity at each chunk boundary - a periodic tick under the speech.",
    },
    smartTranscript: {
      // Stage 3. Implemented, deliberately unpromoted.
      serverEnabled: smart.value && credentialPresent && transcription.modelAllowed,
      requested: smart.value,
      blockers: smartBlockers,
      stage: "implemented-not-validated",
      promotionGate:
        "Requires the recorded-audio screen in research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md section 12C to pass first.",
    },
    transcriptLab: {
      enabled: lab.value,
      realProviderCallsEnabled: labLive.value && credentialPresent && transcription.modelAllowed,
      realProviderCallsRequested: labLive.value,
      dryRunByDefault: true,
      storeAudioOnDisk: storeAudio.value,
      limits: TRANSCRIPTION_LIMITS,
    },
    transcription,
    credentials: {
      geminiApiKeyPresent: credentialPresent,
      note: "Presence only. No key value is ever returned by this API or written to a log.",
    },
    dataHandling: {
      freeTierWarning:
        "Google's pricing page marks the free tier for these live models as 'Used to improve our products: Yes', and the paid tier as 'No'. Use synthetic or explicitly consented demo speech only.",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
      checked: "2026-09-03",
    },
    configurationErrors,
  };
}

/** The compact block that rides along in /api/health. */
export function featureSummary() {
  const features = effectiveFeatures();
  return {
    version: features.build.version,
    voiceStyle: features.voice.defaultStyle,
    playbackMode: features.voice.playbackMode,
    voice: features.voice.voice,
    engineMode: features.voice.engineMode,
    expressiveAvailable: features.voice.expressiveAvailable,
    smartTranscriptEnabled: features.smartTranscript.serverEnabled,
    transcriptLabEnabled: features.transcriptLab.enabled,
    transcriptLabRealCalls: features.transcriptLab.realProviderCallsEnabled,
    configurationErrors: features.configurationErrors,
  };
}
