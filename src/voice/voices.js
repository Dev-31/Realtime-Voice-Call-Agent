/**
 * The prebuilt voice catalogue, and which ones are worth auditioning.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The owner said the agent "sounds like AI" and asked to try a different voice.
 * Voice choice is the cheapest possible lever here: it is a single documented
 * string in `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. No new
 * provider, no pipeline change, no rebuild of anything.
 *
 * WHAT IS DOCUMENTED, AND WHAT IS NOT
 * -----------------------------------
 * Google publishes the 30 names below with a one-word descriptor each
 * (https://ai.google.dev/gemini-api/docs/speech-generation, checked 2026-09-03).
 * The Live capabilities page states that native-audio-output models "support any
 * of the voices available for our Text-to-Speech (TTS) models", which is why
 * this list applies to the live conversation model too.
 *
 * Google does **not** publish a gender, an accent, or a language affinity for
 * any voice. So this file cannot tell you which voice sounds like an
 * Indian-English woman. Anyone claiming otherwise from this data is guessing.
 * The `AUDITION_SET` below is a shortlist derived from the DESCRIPTORS ONLY -
 * a set of candidates to listen to, never a recommendation. Descriptors are not
 * audio.
 *
 * Also documented, and relevant: "Native audio output models automatically
 * choose the appropriate language and don't support explicitly setting the
 * language code." So accent cannot be requested. It follows from the
 * conversation, not from a setting.
 */

/** All 30 documented prebuilt voices, with Google's own descriptor. */
export const VOICE_CATALOGUE = Object.freeze([
  Object.freeze({ name: "Zephyr", descriptor: "Bright" }),
  Object.freeze({ name: "Puck", descriptor: "Upbeat" }),
  Object.freeze({ name: "Charon", descriptor: "Informative" }),
  Object.freeze({ name: "Kore", descriptor: "Firm" }),
  Object.freeze({ name: "Fenrir", descriptor: "Excitable" }),
  Object.freeze({ name: "Leda", descriptor: "Youthful" }),
  Object.freeze({ name: "Orus", descriptor: "Firm" }),
  Object.freeze({ name: "Aoede", descriptor: "Breezy" }),
  Object.freeze({ name: "Callirrhoe", descriptor: "Easy-going" }),
  Object.freeze({ name: "Autonoe", descriptor: "Bright" }),
  Object.freeze({ name: "Enceladus", descriptor: "Breathy" }),
  Object.freeze({ name: "Iapetus", descriptor: "Clear" }),
  Object.freeze({ name: "Umbriel", descriptor: "Easy-going" }),
  Object.freeze({ name: "Algieba", descriptor: "Smooth" }),
  Object.freeze({ name: "Despina", descriptor: "Smooth" }),
  Object.freeze({ name: "Erinome", descriptor: "Clear" }),
  Object.freeze({ name: "Algenib", descriptor: "Gravelly" }),
  Object.freeze({ name: "Rasalgethi", descriptor: "Informative" }),
  Object.freeze({ name: "Laomedeia", descriptor: "Upbeat" }),
  Object.freeze({ name: "Achernar", descriptor: "Soft" }),
  Object.freeze({ name: "Alnilam", descriptor: "Firm" }),
  Object.freeze({ name: "Schedar", descriptor: "Even" }),
  Object.freeze({ name: "Gacrux", descriptor: "Mature" }),
  Object.freeze({ name: "Pulcherrima", descriptor: "Forward" }),
  Object.freeze({ name: "Achird", descriptor: "Friendly" }),
  Object.freeze({ name: "Zubenelgenubi", descriptor: "Casual" }),
  Object.freeze({ name: "Vindemiatrix", descriptor: "Gentle" }),
  Object.freeze({ name: "Sadachbia", descriptor: "Lively" }),
  Object.freeze({ name: "Sadaltager", descriptor: "Knowledgeable" }),
  Object.freeze({ name: "Sulafat", descriptor: "Warm" }),
]);

export const VOICE_NAMES = Object.freeze(VOICE_CATALOGUE.map((voice) => voice.name));

/** V4's voice. The comparison baseline, and the fallback for anything invalid. */
export const DEFAULT_VOICE = "Kore";

/**
 * The shortlist to audition for this role.
 *
 * The role is a calm, professional billing-support specialist covering for a
 * colleague, talking to someone who may be annoyed about a charge. Reasoning is
 * from Google's descriptor only, and `why` says what we are testing FOR - not
 * what we expect to happen.
 *
 * `Kore` is included because a comparison needs its baseline in the same list.
 */
export const AUDITION_SET = Object.freeze([
  Object.freeze({
    name: "Kore",
    descriptor: "Firm",
    why: "The current voice. Included as the baseline, not as a candidate.",
    baseline: true,
  }),
  Object.freeze({
    name: "Sulafat",
    descriptor: "Warm",
    why: "The only descriptor that directly names warmth, which is the quality reported missing.",
  }),
  Object.freeze({
    name: "Vindemiatrix",
    descriptor: "Gentle",
    why: "Test whether a gentler delivery reads as more human or as less competent.",
  }),
  Object.freeze({
    name: "Achird",
    descriptor: "Friendly",
    why: "Approachability, without the brightness that would be wrong for a billing complaint.",
  }),
  Object.freeze({
    name: "Achernar",
    descriptor: "Soft",
    why: "The restraint an annoyed caller should get. Risk: too quiet to carry a price readback.",
  }),
  Object.freeze({
    name: "Schedar",
    descriptor: "Even",
    why: "Steady and unperformed. A control against voices that may sound theatrical.",
  }),
  Object.freeze({
    name: "Algieba",
    descriptor: "Smooth",
    why: "Tests whether smoothness is heard as natural or as more synthetic.",
  }),
]);

/**
 * Resolve a requested voice.
 *
 * An unknown name falls back to the default and says so. It does NOT throw: a
 * bad setting must not be able to end a call, and it must not silently look
 * like it worked either.
 */
export function resolveVoice(requested) {
  const value = typeof requested === "string" ? requested.trim() : "";
  const match = VOICE_NAMES.find((name) => name.toLowerCase() === value.toLowerCase());
  if (match) {
    return { voice: match, requested: requested ?? null, fellBack: false, reason: null };
  }
  return {
    voice: DEFAULT_VOICE,
    requested: requested ?? null,
    fellBack: true,
    reason: value ? "unknown_voice" : "no_voice_supplied",
  };
}

export function voiceDescriptor(name) {
  return VOICE_CATALOGUE.find((voice) => voice.name === name)?.descriptor ?? null;
}
