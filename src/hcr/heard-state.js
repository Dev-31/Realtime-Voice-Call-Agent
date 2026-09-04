/**
 * HCR heard-state tracker (Gate 2).
 *
 * Plain-English problem this solves:
 *
 *   The Twin says "I can send the eighteen rupee charge to Billing for review,
 *   and they usually reply within two working days, and meanwhile your..." and
 *   the caller cuts in. The provider stops generating and we stop playback.
 *   But the provider's own conversation memory now contains the WHOLE sentence,
 *   including the part that never reached the caller's ear. If we do nothing,
 *   the Twin will happily act as though the caller was told about the two-day
 *   reply window. That is the failure this module exists to prevent.
 *
 * What it does:
 *   - Gives every Twin response an epoch id and a lifecycle state:
 *     planned -> speaking -> played -> completed, or -> interrupted -> resumed.
 *   - Measures how much of the produced audio actually reached the speaker.
 *   - Splits the drafted words into a heard part and an unheard part.
 *   - Produces a compact heard-state note that can be pushed back into the
 *     provider session so the model's next turn is grounded in what the caller
 *     really heard.
 *
 * Honesty boundary: the heard/unheard word split is an ESTIMATE derived from
 * audio progress against drafted audio. The chunk counts and millisecond
 * timings are exact. Nothing in this file authorises a business action; the
 * server only ever uses it to withhold one.
 */

export const HEARD_STATES = Object.freeze([
  "planned",
  "speaking",
  "played",
  "interrupted",
  "resumed",
  "completed",
]);

const TERMINAL_STATES = new Set(["completed", "interrupted"]);

/**
 * Split drafted words into the part the caller heard and the part they did not.
 * Splits on a word boundary so neither side ends mid-word.
 */
export function splitHeardText(draftText, heardFraction) {
  const text = String(draftText || "");
  if (!text) return { heardText: "", unheardText: "" };
  const fraction = Math.max(0, Math.min(1, Number(heardFraction) || 0));
  if (fraction >= 1) return { heardText: text, unheardText: "" };
  if (fraction <= 0) return { heardText: "", unheardText: text };

  const target = Math.round(text.length * fraction);
  let cut = text.lastIndexOf(" ", target);
  if (cut <= 0) cut = text.indexOf(" ", target);
  if (cut < 0) cut = text.length;
  return {
    heardText: text.slice(0, cut).trim(),
    unheardText: text.slice(cut).trim(),
  };
}

class ResponseEpoch {
  constructor(id, { resumeOf = null, startedAt = 0 } = {}) {
    this.id = id;
    this.resumeOf = resumeOf;
    this.startedAt = startedAt;
    this.state = "planned";
    this.draftText = "";
    this.draftFinished = false;
    this.turnComplete = false;
    /** Audio the provider produced for this response, in milliseconds. */
    this.scheduledMs = 0;
    /** Audio that actually reached the speaker, in milliseconds. */
    this.audibleMs = 0;
    this.scheduledChunks = 0;
    this.audibleChunks = 0;
    this.firstAudibleAt = null;
    this.endedAt = null;
    this.heardText = "";
    this.unheardText = "";
  }

  heardFraction() {
    if (this.scheduledMs <= 0) return this.state === "completed" ? 1 : 0;
    return Math.max(0, Math.min(1, this.audibleMs / this.scheduledMs));
  }

  snapshot() {
    return {
      epochId: this.id,
      state: this.state,
      resumeOf: this.resumeOf,
      draftedText: this.draftText,
      heardText: this.heardText,
      unheardText: this.unheardText,
      heardFraction: Number(this.heardFraction().toFixed(3)),
      scheduledChunks: this.scheduledChunks,
      audibleChunks: this.audibleChunks,
      scheduledMs: Math.round(this.scheduledMs),
      audibleMs: Math.round(this.audibleMs),
      turnComplete: this.turnComplete,
      precision: {
        chunkCounts: "exact",
        milliseconds: "exact",
        wordSplit: "estimated-from-audio-progress",
      },
    };
  }
}

export class HeardStateTracker {
  /**
   * @param {object} options
   * @param {() => string} options.idFactory   epoch id source
   * @param {() => number} options.now         monotonic clock in milliseconds
   * @param {(transition) => void} options.onTransition
   */
  constructor({ idFactory = () => crypto.randomUUID(), now = () => 0, onTransition = () => {} } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.onTransition = onTransition;
    this.active = null;
    this.history = [];
    /** The unheard remainder that is still waiting to be resumed or dropped. */
    this.pendingRemainder = null;
  }

  /** Ensure an epoch exists for the response the provider is currently producing. */
  ensureEpoch() {
    if (this.active && !TERMINAL_STATES.has(this.active.state)) return this.active;
    const resumeOf = this.pendingRemainder?.epochId || null;
    const epoch = new ResponseEpoch(this.idFactory(), { resumeOf, startedAt: this.now() });
    if (this.active) this.history.push(this.active);
    this.active = epoch;
    this.#transition(epoch, "planned", { resumeOf });
    return epoch;
  }

  noteDraftText(text, { finished = false } = {}) {
    if (!text && !finished) return this.active;
    const epoch = this.ensureEpoch();
    if (text) epoch.draftText += text;
    if (finished) epoch.draftFinished = true;
    return epoch;
  }

  /** A decoded audio chunk was queued for playback. */
  noteAudioScheduled(durationMs) {
    const epoch = this.ensureEpoch();
    epoch.scheduledChunks += 1;
    epoch.scheduledMs += Math.max(0, Number(durationMs) || 0);
    return epoch;
  }

  /** A queued chunk actually started playing out of the speaker. */
  noteAudioAudible(durationMs) {
    const epoch = this.ensureEpoch();
    epoch.audibleChunks += 1;
    epoch.audibleMs += Math.max(0, Number(durationMs) || 0);
    if (epoch.firstAudibleAt == null) epoch.firstAudibleAt = this.now();
    if (epoch.state === "planned") this.#transition(epoch, "speaking");
    return epoch;
  }

  noteTurnComplete() {
    if (!this.active) return null;
    this.active.turnComplete = true;
    return this.active;
  }

  /**
   * All queued audio for the active response has drained and the provider has
   * finished generating: the caller heard the whole thing.
   */
  noteAudioDrained() {
    const epoch = this.active;
    if (!epoch || TERMINAL_STATES.has(epoch.state)) return null;
    if (!epoch.turnComplete) return null;
    epoch.endedAt = this.now();
    epoch.heardText = epoch.draftText;
    epoch.unheardText = "";
    if (epoch.state === "speaking" || epoch.state === "planned") this.#transition(epoch, "played");
    this.#transition(epoch, "completed");
    if (this.pendingRemainder?.consumedBy === epoch.id) this.pendingRemainder = null;
    return epoch;
  }

  /**
   * The caller started speaking over the Twin. Everything already scheduled is
   * about to be thrown away, so freeze what was and was not heard.
   */
  interrupt({ audibleMsOverride = null } = {}) {
    const epoch = this.active;
    if (!epoch || TERMINAL_STATES.has(epoch.state)) return null;
    if (audibleMsOverride != null) epoch.audibleMs = Math.max(0, Number(audibleMsOverride) || 0);
    epoch.endedAt = this.now();
    const split = splitHeardText(epoch.draftText, epoch.heardFraction());
    epoch.heardText = split.heardText;
    epoch.unheardText = split.unheardText;
    this.#transition(epoch, "interrupted", {
      audibleChunks: epoch.audibleChunks,
      discardedChunks: Math.max(0, epoch.scheduledChunks - epoch.audibleChunks),
    });
    this.pendingRemainder = epoch.unheardText
      ? { epochId: epoch.id, heardText: epoch.heardText, unheardText: epoch.unheardText, consumedBy: null }
      : null;
    return epoch;
  }

  /** Mark that the next response is continuing the interrupted explanation. */
  markResumed(epochId = this.active?.id) {
    if (!this.pendingRemainder) return null;
    const epoch = this.#find(epochId);
    if (!epoch) return null;
    this.pendingRemainder.consumedBy = epoch.id;
    this.#transition(epoch, "resumed", { resumeOf: this.pendingRemainder.epochId });
    return epoch;
  }

  /**
   * The compact statement of what the caller actually heard, ready to be pushed
   * back into the provider session. Returns null when there is nothing unheard.
   */
  resumeNote() {
    const remainder = this.pendingRemainder;
    if (!remainder || !remainder.unheardText) return null;
    const heard = remainder.heardText
      ? `The caller heard you say: "${remainder.heardText}".`
      : "The caller heard none of your last reply.";
    return [
      "[call state]",
      heard,
      `The caller did NOT hear this unfinished part: "${remainder.unheardText}".`,
      "Treat the unheard part as never delivered. Do not claim you already told them.",
      "If their contribution only signalled that they are listening, carry on from the unheard part.",
      "If they took the floor, answer what they actually said and leave the unheard part for later.",
    ].join(" ");
  }

  /** Drop the pending remainder without resuming it (the caller changed topic). */
  discardRemainder() {
    const remainder = this.pendingRemainder;
    this.pendingRemainder = null;
    return remainder;
  }

  /** Playback evidence for one epoch, used by the server's confirmation guard. */
  evidenceFor(epochId) {
    const epoch = this.#find(epochId);
    if (!epoch) return null;
    return epoch.snapshot();
  }

  snapshot() {
    return {
      active: this.active ? this.active.snapshot() : null,
      pendingRemainder: this.pendingRemainder,
      completed: this.history.filter((epoch) => epoch.state === "completed").length,
      interrupted: this.history.filter((epoch) => epoch.state === "interrupted").length,
      epochs: [...this.history, ...(this.active ? [this.active] : [])].map((epoch) => epoch.snapshot()),
    };
  }

  reset() {
    this.active = null;
    this.history = [];
    this.pendingRemainder = null;
  }

  #find(epochId) {
    if (this.active?.id === epochId) return this.active;
    return this.history.find((epoch) => epoch.id === epochId) || null;
  }

  #transition(epoch, state, detail = {}) {
    epoch.state = state;
    this.onTransition({ ...epoch.snapshot(), ...detail, at: this.now() });
  }
}
