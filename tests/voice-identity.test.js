/**
 * Voice selection and the expressive-engine allowlist.
 *
 * The owner asked two things: can we try a different voice, and can the agent
 * convey emotion. Those turn out to be very different sizes of change.
 *
 * A voice is one documented string. An emotion capability is a different MODEL:
 * Google's capability matrix lists affective dialogue as "Not supported" on
 * `gemini-3.1-flash-live-preview` and supported on the 2.5 live model. So
 * "add emotions" means "switch engines", and a model choice must never come
 * from the browser — that is what these tests pin.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDITION_SET,
  DEFAULT_VOICE,
  VOICE_CATALOGUE,
  VOICE_NAMES,
  resolveVoice,
  voiceDescriptor,
} from "../src/voice/voices.js";
import {
  DEFAULT_VOICE_MODE,
  VOICE_MODES,
  resolveVoiceMode,
  voiceModeCatalogue,
} from "../server/agent/voice-modes.js";
import { liveConfig } from "../src/voice/gemini-live.js";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("the catalogue holds the 30 documented voices, each with a descriptor", () => {
  assert.equal(VOICE_CATALOGUE.length, 30);
  for (const voice of VOICE_CATALOGUE) {
    assert.ok(voice.name && typeof voice.name === "string");
    assert.ok(voice.descriptor && typeof voice.descriptor === "string");
  }
  assert.equal(new Set(VOICE_NAMES).size, 30, "no duplicate names");
  // Spot-check names that must be exact, since a typo would be silently wrong.
  for (const name of ["Kore", "Sulafat", "Vindemiatrix", "Achernar", "Schedar", "Achird"]) {
    assert.ok(VOICE_NAMES.includes(name), `${name} must be in the catalogue`);
  }
  assert.equal(voiceDescriptor("Sulafat"), "Warm");
  assert.equal(voiceDescriptor("Kore"), "Firm");
  assert.equal(voiceDescriptor("NotAVoice"), null);
});

test("the audition shortlist is drawn from the catalogue and includes the baseline", () => {
  assert.ok(AUDITION_SET.length >= 5 && AUDITION_SET.length <= 10);
  for (const entry of AUDITION_SET) {
    assert.ok(VOICE_NAMES.includes(entry.name), `${entry.name} must exist in the catalogue`);
    assert.equal(entry.descriptor, voiceDescriptor(entry.name), "descriptors must not drift");
    assert.ok(entry.why && entry.why.length > 10, "each candidate needs a stated reason");
  }
  const baseline = AUDITION_SET.filter((entry) => entry.baseline);
  assert.equal(baseline.length, 1, "exactly one baseline, or the comparison has no anchor");
  assert.equal(baseline[0].name, DEFAULT_VOICE);
});

test("the default voice is V4's, so the baseline is unchanged unless asked", () => {
  assert.equal(DEFAULT_VOICE, "Kore");
});

test("an unknown voice falls back to the baseline and says so", () => {
  for (const bad of ["", "  ", "Maya", "female", null, undefined, 7, {}]) {
    const result = resolveVoice(bad);
    assert.equal(result.voice, DEFAULT_VOICE, `${String(bad)} must fall back`);
    assert.equal(result.fellBack, true);
    assert.ok(result.reason);
  }
  // Case-insensitive, but the canonical spelling is what reaches the provider.
  assert.equal(resolveVoice("sulafat").voice, "Sulafat");
  assert.equal(resolveVoice("  KORE  ").voice, "Kore");
  assert.equal(resolveVoice("Sulafat").fellBack, false);
});

// ---------------------------------------------------------------------------
// The voice reaches the provider config, and nothing else moves
// ---------------------------------------------------------------------------

test("the chosen voice is what lands in speechConfig", () => {
  for (const name of ["Kore", "Sulafat", "Achernar"]) {
    const config = liveConfig({ name: "Akash" }, { voice: name });
    assert.equal(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, name);
  }
});

test("an invalid voice cannot reach the provider", () => {
  const config = liveConfig({ name: "Akash" }, { voice: "<script>alert(1)</script>" });
  assert.equal(
    config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    DEFAULT_VOICE,
    "an unknown voice must be replaced, never forwarded",
  );
});

test("changing voice changes ONLY the voice name", () => {
  const a = liveConfig({ name: "Akash" }, { voice: "Kore" });
  const b = liveConfig({ name: "Akash" }, { voice: "Sulafat" });
  const strip = (config) => {
    const copy = JSON.parse(JSON.stringify(config));
    delete copy.speechConfig;
    return copy;
  };
  assert.deepEqual(strip(a), strip(b), "voice choice must not perturb anything else");
});

// ---------------------------------------------------------------------------
// Affective dialogue is opt-in, model-bound, and never sent to 3.1
// ---------------------------------------------------------------------------

test("affective dialogue is absent unless explicitly granted", () => {
  const plain = liveConfig({ name: "Akash" }, {});
  assert.equal(
    plain.enableAffectiveDialog,
    undefined,
    "3.1 documents affective dialogue as unsupported; sending it would be a silent no-op",
  );
  assert.ok(!("enableAffectiveDialog" in plain));

  const granted = liveConfig({ name: "Akash" }, { affectiveDialog: true });
  assert.equal(granted.enableAffectiveDialog, true);
});

test("proactive audio is never enabled", () => {
  // It lets the model decide not to answer. In a billing call that is
  // indistinguishable from a fault, and it would confound every interruption
  // measurement. Deliberately absent.
  for (const options of [{}, { affectiveDialog: true }, { voice: "Sulafat" }]) {
    const config = liveConfig({ name: "Akash" }, options);
    assert.equal(config.proactivity, undefined);
    assert.equal(config.proactiveAudio, undefined);
  }
});

// ---------------------------------------------------------------------------
// The engine allowlist: the browser asks for a mode, the server picks a model
// ---------------------------------------------------------------------------

test("the default engine is the V4 baseline model", () => {
  assert.equal(DEFAULT_VOICE_MODE, "standard");
  const { mode } = resolveVoiceMode("standard");
  assert.equal(mode.model, "gemini-3.1-flash-live-preview");
  assert.equal(mode.affectiveDialog, false);
  assert.equal(mode.experimental, false);
});

test("the expressive engine is a different model, and is flagged experimental", () => {
  const { mode } = resolveVoiceMode("expressive");
  assert.match(mode.model, /^gemini-2\.5-flash-native-audio/);
  assert.equal(mode.affectiveDialog, true);
  assert.equal(mode.experimental, true);
  assert.ok(mode.tradeoffs.length > 40, "an experimental engine must state its trade-offs");
  assert.match(mode.tradeoffs, /verified|unattributed/i);
});

test("a browser cannot name a model, only a mode", () => {
  // Anything that is not an allowlisted mode id resolves to the baseline.
  for (const attack of [
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview-12-2025",
    "models/anything",
    "__proto__",
    "constructor",
    "toString",
    "",
    null,
    undefined,
    42,
    {},
    [],
  ]) {
    const result = resolveVoiceMode(attack);
    assert.equal(result.mode.id, DEFAULT_VOICE_MODE, `${String(attack)} must not select an engine`);
    assert.equal(result.fellBack, true);
  }
  assert.equal(resolveVoiceMode("EXPRESSIVE").mode.id, "expressive");
  assert.equal(resolveVoiceMode(" standard ").fellBack, false);
});

test("the published engine catalogue never omits the experimental warning", () => {
  const catalogue = voiceModeCatalogue();
  assert.equal(catalogue.length, VOICE_MODES.length);
  for (const engine of catalogue) {
    assert.ok(engine.id && engine.label && engine.model);
    assert.equal(typeof engine.experimental, "boolean");
    assert.ok(engine.description.length > 20);
    assert.ok(engine.tradeoffs.length > 20, `${engine.id} must publish its trade-offs`);
  }
  const expressive = catalogue.find((engine) => engine.id === "expressive");
  assert.equal(expressive.experimental, true);
});

test("resolveVoiceMode returns frozen definitions a caller cannot edit", () => {
  const first = resolveVoiceMode("standard").mode;
  assert.throws(() => { first.model = "something-else"; }, TypeError);
  assert.equal(resolveVoiceMode("standard").mode.model, "gemini-3.1-flash-live-preview");
});
