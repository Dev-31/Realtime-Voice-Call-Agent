import assert from "node:assert/strict";
import test from "node:test";
import { StartSensitivity } from "@google/genai";
import { liveConfig } from "../src/voice/gemini-live.js";
import { captureSettingsReport, noiseModeReport, resolveNoiseMode } from "../src/voice/noise-mode.js";

test("noise trial changes only provider start sensitivity", () => {
  const baseline = liveConfig();
  const trial = liveConfig({}, { noiseMode: "conservative" });
  assert.equal(trial.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity,
    StartSensitivity.START_SENSITIVITY_LOW);
  delete trial.realtimeInputConfig.automaticActivityDetection.startOfSpeechSensitivity;
  assert.deepEqual(trial, baseline);
});

test("unknown noise modes preserve the current default", () => {
  assert.equal(resolveNoiseMode("speaker-lock"), "baseline");
  assert.deepEqual(liveConfig({}, { noiseMode: "speaker-lock" }), liveConfig());
});

test("noise trial makes no primary-speaker or denoiser claim", () => {
  const report = noiseModeReport("conservative");
  assert.equal(report.experimental, true);
  assert.equal(report.customDenoiser, false);
  assert.equal(report.primarySpeakerRecognition, false);
  assert.equal(report.validation, "not_physically_compared");
});

test("microphone telemetry reports unknowns and omits device identifiers", () => {
  const report = captureSettingsReport({ deviceId: "private", groupId: "private", label: "private", sampleRate: 48000,
    echoCancellation: true, noiseSuppression: false, autoGainControl: "true" });
  assert.equal(report.settings.noiseSuppression, false);
  assert.equal(report.settings.autoGainControl, null);
  assert.equal(report.settings.sampleRate, 48000);
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.equal(captureSettingsReport().settings.echoCancellation, null);
});
