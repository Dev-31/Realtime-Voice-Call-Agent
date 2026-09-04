/**
 * Ordered, no-authority storage for transcript lanes.
 *
 * PLAIN-ENGLISH VERSION
 * ---------------------
 * Two different machines can listen to the same person and write down slightly
 * different words, and they can also cut the speech into different pieces. This
 * file keeps each machine's notes in its own column, in the order that machine
 * produced them, and refuses to guess that "the newest line in column A" is
 * "the newest line in column B". If a result turns up late -- say the caller
 * interrupted, and the recogniser only finishes that sentence afterwards -- it
 * is filed under the sentence it actually belongs to, not stapled onto whatever
 * the caller said most recently.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ------------------------------
 * This module imports nothing. It has no session, no tool executor, no network
 * and no reference to the heard-state ledger or the agent prompt. It is a data
 * structure. That is the isolation guarantee: the only way a transcript could
 * reach a business action is if some other file wired it there, and
 * tests/transcription-isolation.test.js exists to catch that.
 *
 * There is also no function anywhere that derives one lane from another. The
 * readable lane is what the provider's SMART mode returned; it is never
 * reconstructed backwards out of the verbatim lane, or vice versa.
 *
 * SEGMENT STATES
 * --------------
 *   pending            opened, nothing received yet
 *   provisional        an interim hypothesis is showing; it may still change
 *   finalized          the recogniser called this segment done
 *   unavailable        the lane could not produce text (error, quota, refused)
 *   timed_out          the grace period expired before a final arrived
 *   cancelled          the run was stopped on purpose
 *   manually_reviewed  a human scored or corrected it in the lab
 *
 * Missing output is one of the last four. It is never silently treated as
 * success, and never as "the person said nothing".
 */

export const SEGMENT_STATES = Object.freeze([
  "pending",
  "provisional",
  "finalized",
  "unavailable",
  "timed_out",
  "cancelled",
  "manually_reviewed",
]);

const TERMINAL_STATES = Object.freeze(["finalized", "unavailable", "timed_out", "cancelled", "manually_reviewed"]);

/**
 * The three lanes the build plan defines, with the labels that must appear on
 * screen. "Readable transcript -- machine edited" is deliberately not
 * "what the agent understood": the agent hears audio, not this text.
 */
export const LANE_DEFINITIONS = Object.freeze({
  "voice-core-raw": Object.freeze({
    id: "voice-core-raw",
    label: "Original machine transcript",
    sublabel: "From the voice model's own recognition of your speech",
    provenance: "voice-core-input-transcription",
    editorial: "none",
    authority: "display-only",
  }),
  "dedicated-verbatim": Object.freeze({
    id: "dedicated-verbatim",
    label: "Original machine transcript",
    sublabel: "Dedicated speech recogniser, VERBATIM mode",
    provenance: "dedicated-transcription-verbatim",
    editorial: "none",
    authority: "display-only",
  }),
  "dedicated-smart": Object.freeze({
    id: "dedicated-smart",
    label: "Readable transcript — machine edited",
    sublabel: "Dedicated speech recogniser, SMART mode. Filler removed and formatting added by the provider.",
    provenance: "dedicated-transcription-smart",
    editorial: "provider-smart-mode",
    authority: "display-only",
  }),
});

export const LANE_IDS = Object.freeze(Object.keys(LANE_DEFINITIONS));

/**
 * How confident we are that two lanes are describing the same speech.
 *
 * `same-input-by-clip-hash` is the only one that is a real guarantee: the lab
 * feeds byte-identical normalised audio to every lane and keys the comparison
 * on its hash. Live mode gets `independent-streams`, and the UI must show two
 * separately scrolling columns rather than a per-turn diff.
 */
export const ALIGNMENT_QUALITY = Object.freeze({
  exact: "same-input-by-clip-hash",
  approximate: "independent-streams-approximate-by-receipt-time",
  none: "not-established",
});

function nowMs(clock) {
  return typeof clock === "function" ? clock() : 0;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] monotonic clock, injected for tests
 * @param {(id: string) => string} [options.idFactory]
 * @param {number} [options.maxSegmentsPerLane] bounded so a long session cannot grow without limit
 * @param {number} [options.maxCharactersPerSegment]
 */
export function createTranscriptStore({
  now = null,
  idFactory = null,
  maxSegmentsPerLane = 400,
  maxCharactersPerSegment = 4000,
} = {}) {
  let counter = 0;
  const makeId = idFactory || ((prefix) => {
    counter += 1;
    return `${prefix}-${counter}`;
  });

  /** laneId -> { definition, generations: Map<number, Generation>, currentGeneration, closed } */
  const lanes = new Map();
  /** Events that arrived for a generation or lane that is no longer current. */
  const lateEvents = [];
  /** Events we could not file at all, kept so nothing is silently dropped. */
  const rejectedEvents = [];
  let alignment = { quality: ALIGNMENT_QUALITY.none, key: null, note: null };

  function lane(laneId) {
    const existing = lanes.get(laneId);
    if (existing) return existing;
    // `Object.hasOwn`, not a plain lookup: `LANE_DEFINITIONS["__proto__"]`
    // returns Object.prototype and `LANE_DEFINITIONS["constructor"]` returns
    // Object, both truthy. A transcript event naming either would otherwise
    // create a lane whose "definition" is a built-in.
    if (!Object.hasOwn(LANE_DEFINITIONS, laneId)) return null;
    const definition = LANE_DEFINITIONS[laneId];
    const created = {
      definition,
      currentGeneration: -1,
      generations: new Map(),
      closed: false,
      status: { state: "idle", detail: null, at: null },
      stats: { interimReceived: 0, finalsReceived: 0, duplicatesIgnored: 0, lateFiled: 0, gaps: 0 },
    };
    lanes.set(laneId, created);
    return created;
  }

  function generation(target, index) {
    const existing = target.generations.get(index);
    if (existing) return existing;
    const created = {
      index,
      segments: [],
      openedAt: nowMs(now),
      closedAt: null,
      /** Set when a new generation begins after a disconnect, so the UI can
       *  show a break instead of gluing two halves of a sentence together. */
      precededByGap: index > 0,
    };
    target.generations.set(index, created);
    return created;
  }

  function openSegment(target, gen) {
    if (gen.segments.length >= maxSegmentsPerLane) {
      rejectedEvents.push({
        reason: "segment_cap_reached",
        laneId: target.definition.id,
        generation: gen.index,
        at: nowMs(now),
      });
      return null;
    }
    const segment = {
      id: makeId(`${target.definition.id}-seg`),
      laneId: target.definition.id,
      generation: gen.index,
      sequence: gen.segments.length,
      state: "pending",
      text: "",
      interimText: "",
      revisions: 0,
      firstEventAtMs: null,
      firstInterimAtMs: null,
      finalizedAtMs: null,
      lateArrival: false,
      /**
       * True when this segment was created after the lane was closed. Such a
       * segment is kept and auditable, but it is excluded from the current
       * column and from `finalizedText`: a run that has been declared over
       * must not quietly grow a new sentence afterwards.
       */
      afterClose: false,
      note: null,
    };
    gen.segments.push(segment);
    return segment;
  }

  function displayTextOf(segment) {
    return segment.text ? segment.text : segment.interimText;
  }

  /** The segment an incoming event belongs to: the last non-terminal one, else a new one. */
  function targetSegment(target, gen) {
    const last = gen.segments[gen.segments.length - 1];
    if (last && !TERMINAL_STATES.includes(last.state)) return last;
    return openSegment(target, gen);
  }

  function clip(text) {
    const value = String(text ?? "");
    return value.length > maxCharactersPerSegment ? value.slice(0, maxCharactersPerSegment) : value;
  }

  return {
    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /**
     * Begin a new stream generation for a lane.
     *
     * Called on first connect and again after a reconnect. A reconnect always
     * starts a NEW generation: speech either side of a gap is never presented
     * as one continuous sentence.
     */
    startGeneration(laneId, { detail = null } = {}) {
      const target = lane(laneId);
      if (!target) return null;
      target.closed = false;
      target.currentGeneration += 1;
      const gen = generation(target, target.currentGeneration);
      if (gen.precededByGap) target.stats.gaps += 1;
      target.status = { state: "listening", detail, at: nowMs(now) };
      return { laneId, generation: gen.index, precededByGap: gen.precededByGap };
    },

    /** Mark a lane finished. Later events become late events, not current text. */
    closeLane(laneId, { state = "closed", detail = null } = {}) {
      const target = lane(laneId);
      if (!target) return null;
      target.closed = true;
      const gen = target.generations.get(target.currentGeneration);
      if (gen && gen.closedAt == null) gen.closedAt = nowMs(now);
      target.status = { state, detail, at: nowMs(now) };
      return { laneId, state };
    },

    /**
     * Resolve every still-open segment in a lane to a terminal state.
     *
     * This is how a timeout or a quota failure is recorded: as an explicit
     * `timed_out` / `unavailable` segment that stays in the denominator, rather
     * than as an absence that a reader might mistake for silence.
     */
    resolveOpenSegments(laneId, state, { detail = null } = {}) {
      if (!SEGMENT_STATES.includes(state)) throw new Error(`Unknown segment state: ${state}`);
      const target = lane(laneId);
      if (!target) return 0;
      let changed = 0;
      for (const gen of target.generations.values()) {
        for (const segment of gen.segments) {
          if (TERMINAL_STATES.includes(segment.state)) continue;
          segment.state = state;
          segment.note = detail;
          segment.finalizedAtMs = nowMs(now);
          if (state === "finalized" && !segment.text) segment.text = segment.interimText;
          changed += 1;
        }
      }
      // An empty lane still needs a row, so a failed run is visible.
      if (!changed && ["unavailable", "timed_out", "cancelled"].includes(state)) {
        const gen = generation(target, Math.max(0, target.currentGeneration));
        const segment = openSegment(target, gen);
        if (segment) {
          segment.state = state;
          segment.note = detail;
          segment.finalizedAtMs = nowMs(now);
          changed += 1;
        }
      }
      target.status = { state, detail, at: nowMs(now) };
      return changed;
    },

    setLaneStatus(laneId, state, detail = null) {
      const target = lane(laneId);
      if (!target) return null;
      target.status = { state, detail, at: nowMs(now) };
      return target.status;
    },

    // ---------------------------------------------------------------------
    // Incoming provider events
    // ---------------------------------------------------------------------

    /**
     * File one transcription event.
     *
     * @param {object} event
     * @param {string} event.laneId
     * @param {"interim"|"final"} event.kind  which provider field carried it
     * @param {string} event.text
     * @param {number} [event.generation]  the connection generation it came from
     * @param {number} [event.receivedAtMs]
     *
     * `kind` comes from WHICH provider field was populated:
     * `serverContent.interimInputTranscription` -> "interim",
     * `serverContent.inputTranscription` -> "final". Live transcription has no
     * boolean finality flag, so there is nothing else to branch on.
     */
    applyEvent(event = {}) {
      const laneId = String(event.laneId || "");
      const target = lane(laneId);
      if (!target) {
        rejectedEvents.push({ reason: "unknown_lane", laneId, at: nowMs(now) });
        return { filed: false, reason: "unknown_lane" };
      }
      const kind = event.kind === "interim" ? "interim" : event.kind === "final" ? "final" : null;
      if (!kind) {
        rejectedEvents.push({ reason: "unknown_kind", laneId, kind: event.kind ?? null, at: nowMs(now) });
        return { filed: false, reason: "unknown_kind" };
      }
      // A blank or whitespace-only result is NOT a successful empty transcript.
      // Filing it as a finalized segment would create exactly the "empty
      // success" that makes a failed run look like correct silence.
      const text = clip(event.text);
      if (!text.trim()) {
        rejectedEvents.push({ reason: "empty_text", laneId, kind, at: nowMs(now) });
        return { filed: false, reason: "empty_text" };
      }

      const eventGeneration = Number.isInteger(event.generation) ? event.generation : target.currentGeneration;
      if (eventGeneration < 0) {
        rejectedEvents.push({ reason: "no_generation_started", laneId, at: nowMs(now) });
        return { filed: false, reason: "no_generation_started" };
      }
      if (!target.generations.has(eventGeneration) && eventGeneration !== target.currentGeneration) {
        // A generation we never opened: file it, but flag it rather than
        // inventing history.
        generation(target, eventGeneration);
      }

      const isLate = target.closed || eventGeneration !== target.currentGeneration;
      const gen = generation(target, eventGeneration);

      // A replayed final must be caught BEFORE a new segment is opened for it.
      // The previous final has already closed its segment, so by the time we
      // reach that segment it is terminal and a naive same-text check on the
      // freshly opened segment would never fire -- and the sentence would
      // appear twice.
      if (kind === "final") {
        const previous = gen.segments[gen.segments.length - 1];
        if (previous && previous.state === "finalized" && previous.text === text) {
          target.stats.duplicatesIgnored += 1;
          return { filed: false, reason: "duplicate_final", segmentId: previous.id };
        }
      }

      const segment = targetSegment(target, gen);
      if (!segment) return { filed: false, reason: "segment_cap_reached" };
      if (target.closed) segment.afterClose = true;

      const receivedAtMs = Number.isFinite(event.receivedAtMs) ? event.receivedAtMs : nowMs(now);
      if (segment.firstEventAtMs == null) segment.firstEventAtMs = receivedAtMs;

      if (kind === "interim") {
        // An interim hypothesis REPLACES the previous hypothesis for the same
        // segment. Appending would produce a stuttering, duplicated sentence.
        if (segment.interimText === text) {
          target.stats.duplicatesIgnored += 1;
          return { filed: false, reason: "duplicate_interim", segmentId: segment.id };
        }
        if (segment.firstInterimAtMs == null) segment.firstInterimAtMs = receivedAtMs;
        segment.interimText = text;
        segment.revisions += 1;
        segment.state = "provisional";
        target.stats.interimReceived += 1;
      } else {
        // A final closes this segment. Finals ACCUMULATE across segments -- the
        // recogniser emits one per completed piece of speech -- so the next
        // final opens the next segment rather than overwriting this one.
        if (segment.state === "finalized" && segment.text === text) {
          target.stats.duplicatesIgnored += 1;
          return { filed: false, reason: "duplicate_final", segmentId: segment.id };
        }
        segment.text = text;
        segment.state = "finalized";
        segment.finalizedAtMs = receivedAtMs;
        target.stats.finalsReceived += 1;
      }

      if (isLate) {
        segment.lateArrival = true;
        target.stats.lateFiled += 1;
        lateEvents.push({
          laneId,
          kind,
          generation: eventGeneration,
          segmentId: segment.id,
          currentGeneration: target.currentGeneration,
          laneClosed: target.closed,
          at: receivedAtMs,
          note: "Filed under its own generation. Never shown as the newest turn.",
        });
      }

      return {
        filed: true,
        laneId,
        kind,
        segmentId: segment.id,
        generation: eventGeneration,
        sequence: segment.sequence,
        late: isLate,
      };
    },

    /** A human score or correction in the lab. Never changes machine text. */
    reviewSegment(laneId, segmentId, { score = null, comment = null, failureReason = null } = {}) {
      const target = lane(laneId);
      if (!target) return null;
      for (const gen of target.generations.values()) {
        for (const segment of gen.segments) {
          if (segment.id !== segmentId) continue;
          segment.review = {
            score: score == null ? null : Number(score),
            comment: comment == null ? null : String(comment),
            failureReason: failureReason == null ? null : String(failureReason),
            at: nowMs(now),
          };
          return segment.review;
        }
      }
      return null;
    },

    // ---------------------------------------------------------------------
    // Alignment
    // ---------------------------------------------------------------------

    /**
     * Declare how the lanes may be compared.
     *
     * The lab calls this with the normalised-audio hash, which is a real
     * same-input guarantee. Live mode calls it with `approximate`, and must not
     * render a paired per-turn diff.
     */
    declareAlignment(quality, { key = null, note = null } = {}) {
      const allowed = Object.values(ALIGNMENT_QUALITY);
      alignment = {
        quality: allowed.includes(quality) ? quality : ALIGNMENT_QUALITY.none,
        key,
        note,
      };
      return alignment;
    },

    get alignment() {
      return { ...alignment };
    },

    /** True only when a paired, per-segment comparison is actually justified. */
    canPairSegments() {
      return alignment.quality === ALIGNMENT_QUALITY.exact;
    },

    // ---------------------------------------------------------------------
    // Read models
    // ---------------------------------------------------------------------

    /**
     * What the screen should show for a lane.
     *
     * `current` is the newest generation only. `history` holds earlier
     * generations so a late result stays visible where it belongs.
     */
    laneView(laneId) {
      const target = lanes.get(laneId);
      if (!target) return null;
      const generations = [...target.generations.values()].sort((a, b) => a.index - b.index);
      const currentGen = target.generations.get(target.currentGeneration) || null;
      const displayText = displayTextOf;
      return {
        ...target.definition,
        status: { ...target.status },
        stats: { ...target.stats },
        closed: target.closed,
        currentGeneration: target.currentGeneration,
        generations: generations.map((gen) => ({
          index: gen.index,
          precededByGap: gen.precededByGap,
          openedAt: gen.openedAt,
          closedAt: gen.closedAt,
          segments: gen.segments.map((segment) => ({ ...segment, displayText: displayText(segment) })),
        })),
        /**
         * The newest generation only, and only what arrived while the lane was
         * open. A result that turned up after the lane closed stays visible in
         * `generations` but never occupies the current column.
         */
        current: currentGen
          ? currentGen.segments
            .filter((segment) => !segment.afterClose)
            .map((segment) => ({ ...segment, displayText: displayText(segment) }))
          : [],
        /** Finalized text only. Provisional text is never included -- a
         *  hypothesis is not a transcript -- and neither is anything that
         *  arrived after the run was declared finished. */
        finalizedText: generations
          .flatMap((gen) => gen.segments)
          .filter((segment) => segment.state === "finalized" && !segment.afterClose)
          .map((segment) => segment.text)
          .join(" ")
          .trim(),
        unresolved: generations
          .flatMap((gen) => gen.segments)
          .filter((segment) => !TERMINAL_STATES.includes(segment.state)).length,
        failures: generations
          .flatMap((gen) => gen.segments)
          .filter((segment) => ["unavailable", "timed_out", "cancelled"].includes(segment.state))
          .map((segment) => ({ segmentId: segment.id, state: segment.state, note: segment.note })),
      };
    },

    /** Every lane, plus the alignment caveat the UI must render. */
    snapshot() {
      return {
        lanes: [...lanes.keys()].map((laneId) => this.laneView(laneId)),
        alignment: { ...alignment },
        pairingAllowed: alignment.quality === ALIGNMENT_QUALITY.exact,
        lateEvents: lateEvents.map((entry) => ({ ...entry })),
        rejectedEvents: rejectedEvents.map((entry) => ({ ...entry })),
        counts: {
          lanes: lanes.size,
          lateEvents: lateEvents.length,
          rejectedEvents: rejectedEvents.length,
        },
        note:
          "Two recognisers can hear different words and can split speech differently. Differences shown here are differences between machine outputs, not proof that either one is right.",
      };
    },

    reset() {
      lanes.clear();
      lateEvents.length = 0;
      rejectedEvents.length = 0;
      alignment = { quality: ALIGNMENT_QUALITY.none, key: null, note: null };
      counter = 0;
    },
  };
}
