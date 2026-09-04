/**
 * V5 Stage 1 — delivery style.
 *
 * Two configurations, chosen before a call starts:
 *
 *   baseline  the V4 prompt, byte-for-byte. This is the rollback position.
 *   natural   the same prompt plus ONE appended section that describes how to
 *             sound. It adds no facts, no permissions and no canned replies.
 *
 * Why it is built this way: the only honest way to compare two speaking styles
 * is to keep everything else identical. So `prompt.js` is never edited. The
 * baseline string is produced by exactly the same function V4 used, and the
 * natural string is that same string with a suffix. A test can therefore prove
 * byte-equality of the baseline rather than asking a reader to trust it.
 *
 * Scope-guard compliance: the section below describes interaction *principles*
 * ("slow down around anything the caller may need to write down"), never an
 * exact word, phrase, keyword list or regular expression, and never a canned
 * reply. It also cannot move business authority: that lives in the server.
 */

import { systemInstruction } from "./prompt.js";

export const VOICE_STYLES = Object.freeze(["baseline", "natural"]);
export const DEFAULT_VOICE_STYLE = "baseline";

/**
 * The one section that separates `natural` from `baseline`.
 *
 * Kept as a single exported constant so a test can assert that this is the
 * whole difference, and so the report can hash it.
 */
export const NATURAL_DELIVERY_SECTION = `**Delivery**
Everything above stays exactly as it is: which facts you may state, which tools you must call, what needs a separate confirming turn, and what you may never promise. This section changes only how you sound.
- Speak the way a calm, competent colleague speaks: warm, professional, unhurried. Ordinary contractions are fine wherever they read naturally.
- Finish one complete thought, then leave a real gap. The caller should be able to take the floor without having to talk over you.
- Slow down and separate anything the caller may need to write down or check, such as an amount, a plan name or a reference, and put the weight on the value itself rather than on the words around it.
- If the caller sounds annoyed, worried or rushed, become quieter and more attentive rather than brighter. Do not name or diagnose how they feel, and do not perform sympathy you are not acting on.
- Do not reuse the same acknowledgement, and do not add sighs, breaths, invented hesitation, or sound made only to fill a silence.
- Keep the single opening introduction, and keep the continuation and repair behaviour described above, exactly as they are.
Your delivery may never change a fact, make an uncertain thing sound certain, widen what you are allowed to do, or imply an outcome a tool result has not handed you.`;

/**
 * Resolve a requested style into an effective one.
 *
 * An unknown or missing value falls back to `baseline` and says so, rather than
 * throwing during a call setup or silently guessing.
 */
export function resolveVoiceStyle(requested) {
  const value = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  if (VOICE_STYLES.includes(value)) {
    return { style: value, requested: requested ?? null, fellBack: false, reason: null };
  }
  return {
    style: DEFAULT_VOICE_STYLE,
    requested: requested ?? null,
    fellBack: true,
    reason: value ? "unknown_style" : "no_style_supplied",
  };
}

/**
 * Build the system instruction for a style.
 *
 * `baseline` returns `systemInstruction(customer)` untouched.
 */
export function composeSystemInstruction(customer = {}, requestedStyle = DEFAULT_VOICE_STYLE) {
  const base = systemInstruction(customer);
  const { style } = resolveVoiceStyle(requestedStyle);
  if (style === "natural") return `${base}\n\n${NATURAL_DELIVERY_SECTION}`;
  return base;
}

/**
 * A short, stable fingerprint of a prompt, for the call report.
 *
 * Synchronous and dependency-free so it works identically in the browser and in
 * Node's test runner. This is an identity check for "was the same text sent
 * twice", not a security primitive, and it is labelled that way in the report.
 */
export function promptFingerprint(text) {
  const value = String(text ?? "");
  // FNV-1a, 64-bit, via two 32-bit halves to stay inside safe integer maths.
  let hashLow = 0x811c9dc5;
  let hashHigh = 0xcbf29ce4;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashLow = Math.imul(hashLow ^ (code & 0xff), 0x01000193) >>> 0;
    hashHigh = Math.imul(hashHigh ^ ((code >>> 8) & 0xff), 0x01000193) >>> 0;
  }
  const hex = (hashHigh.toString(16).padStart(8, "0") + hashLow.toString(16).padStart(8, "0"));
  return `fnv1a64:${hex}:${value.length}`;
}

/** Everything the call report needs to describe the style actually used. */
export function deliveryStyleReport(customer = {}, requestedStyle = DEFAULT_VOICE_STYLE) {
  const resolution = resolveVoiceStyle(requestedStyle);
  const prompt = composeSystemInstruction(customer, resolution.style);
  return {
    requestedStyle: resolution.requested,
    effectiveStyle: resolution.style,
    fellBackToBaseline: resolution.fellBack,
    fallbackReason: resolution.reason,
    promptFingerprint: promptFingerprint(prompt),
    promptCharacters: prompt.length,
    styleSectionFingerprint: resolution.style === "natural"
      ? promptFingerprint(NATURAL_DELIVERY_SECTION)
      : null,
    fingerprintKind: "fnv1a64-identity-check-not-a-security-hash",
  };
}
