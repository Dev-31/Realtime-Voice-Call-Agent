/** A provider-native A/B control, not a denoiser or speaker identifier. */
export const DEFAULT_NOISE_MODE = "baseline";
export function resolveNoiseMode(value) {
  return value === "conservative" ? "conservative" : DEFAULT_NOISE_MODE;
}

export function noiseActivityOverride(value) {
  return resolveNoiseMode(value) === "conservative"
    ? { startOfSpeechSensitivity: "START_SENSITIVITY_LOW" }
    : {};
}

export function noiseModeReport(value) {
  const mode = resolveNoiseMode(value);
  return { mode, experimental: mode !== "baseline", customDenoiser: false,
    primarySpeakerRecognition: false, validation: "not_physically_compared",
    startOfSpeechSensitivity: noiseActivityOverride(mode).startOfSpeechSensitivity || "provider-default" };
}

/** Whitelist processing settings; never log deviceId/groupId or microphone labels. */
export function captureSettingsReport(settings = {}) {
  const result = {};
  for (const field of ["echoCancellation", "noiseSuppression", "autoGainControl"])
    result[field] = typeof settings[field] === "boolean" ? settings[field] : null;
  for (const field of ["sampleRate", "channelCount", "latency"])
    result[field] = Number.isFinite(settings[field]) ? settings[field] : null;
  return { settings: result, precision: "browser-reported-settings-not-performance-proof" };
}
