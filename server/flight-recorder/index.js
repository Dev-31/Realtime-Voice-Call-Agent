/**
 * Call Flight Recorder (Gate 4).
 *
 * Stores one timeline per call and derives the numbers the gates are judged on.
 * It is also the evidence store the Gate 3 commit guard reads when it asks
 * "did the caller actually hear the confirmation question?".
 *
 * Trust note: every event originates in the caller's browser over an
 * authenticated, session-bound endpoint. Browser-derived timings are labelled
 * as estimates in the report and never authorise a business action on their
 * own -- they can only *withhold* one.
 */

const EVENT_TYPES = new Set([
  // session lifecycle
  "session_started", "socket_opened", "microphone_ready", "audio_frontend_ready", "session_ended",
  // caller side
  "user_speech_started", "user_speech_ended", "input_transcript_received",
  // twin side
  "response_planned", "response_audio_started", "output_transcript_received", "agent_speech_ended",
  // interruption + heard state (the USP surface)
  "response_interrupted", "heard_state_transition", "unheard_content_quarantined",
  "resume_context_injected", "resume_context_failed",
  // business side
  "tool_requested", "tool_completed", "tool_failed", "tool_policy_blocked",
  "action_prepared", "action_committed", "action_blocked",
  // misc
  "usage_updated", "error",
  // --- V5 experiment lanes -------------------------------------------------
  // Observability only. None of these may authorise, withhold or alter a
  // business action; the commit guard reads heard_state_transition and
  // response_audio_started, and nothing below is in that set.
  "v5_experiment_configured",
  "v5_transcript_lane_opened", "v5_transcript_lane_closed",
  "v5_transcript_segment", "v5_transcript_lane_degraded",
  "v5_transcript_lane_error", "v5_transcript_usage",
  "v5_lab_replay_started", "v5_lab_replay_finished",
  "v5_playback_context", "v5_playback_gap", "v5_playback_summary",
]);

/**
 * V5 lanes that exist for reporting only.
 *
 * Kept as an explicit set so a reader can see that the confirmation-audibility
 * guard cannot be influenced by them, and so a test can assert it.
 */
export const V5_OBSERVATION_ONLY_EVENTS = Object.freeze([
  "v5_experiment_configured",
  "v5_transcript_lane_opened",
  "v5_transcript_lane_closed",
  "v5_transcript_segment",
  "v5_transcript_lane_degraded",
  "v5_transcript_lane_error",
  "v5_transcript_usage",
  "v5_lab_replay_started",
  "v5_lab_replay_finished",
  "v5_playback_context",
  "v5_playback_gap",
  "v5_playback_summary",
]);

const HEARD_STATES = ["planned", "speaking", "played", "interrupted", "resumed", "completed"];

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return value == null ? null : Math.round(Number(value));
}

/** Content words of a phrase, used only for report-time similarity estimates. */
function contentTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

/**
 * How much of `expected` reappears in `actual`.
 *
 * This is a *reporting* estimate only. No runtime conversational or business
 * behaviour branches on it -- it exists so a reviewer can see whether an
 * interrupted explanation was resumed or restarted without hand-scoring
 * twenty calls.
 */
export function coverageRatio(expected, actual) {
  const expectedTokens = new Set(contentTokens(expected));
  if (!expectedTokens.size) return null;
  const actualTokens = new Set(contentTokens(actual));
  let hits = 0;
  for (const token of expectedTokens) if (actualTokens.has(token)) hits += 1;
  return hits / expectedTokens.size;
}

export function createFlightRecorder(db, { enabled = process.env.CALL_FLIGHT_RECORDER !== "false" } = {}) {
  if (!enabled) {
    return {
      enabled: false,
      status: () => ({ enabled: false }),
      ingest: () => ({ accepted: 0 }),
      heardEvidence: () => ({ known: false, audibleChunks: 0, state: null }),
      report: () => null,
      latestReports: () => [],
      listCalls: () => [],
    };
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_recordings (
      conversation_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      provider TEXT NOT NULL,
      model TEXT,
      scenario TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms REAL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      response_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      turn_id TEXT,
      epoch_id TEXT,
      at_ms REAL NOT NULL,
      duration_ms REAL,
      value_num REAL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS call_events_conversation ON call_events(conversation_id, at_ms);
    CREATE INDEX IF NOT EXISTS call_events_epoch ON call_events(conversation_id, epoch_id, event_type);
    CREATE UNIQUE INDEX IF NOT EXISTS call_events_deduplicate
      ON call_events(conversation_id, event_type, at_ms, COALESCE(epoch_id, ''));
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO call_events
      (conversation_id, event_type, turn_id, epoch_id, at_ms, duration_ms, value_num, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function ingest(customerId, body) {
    const conversationId = String(body.conversationId || "").slice(0, 120);
    if (!conversationId) throw new Error("A conversation ID is required.");
    const owner = db.prepare("SELECT customer_id FROM call_recordings WHERE conversation_id = ?").get(conversationId);
    if (owner && owner.customer_id !== customerId) {
      const error = new Error("That call belongs to a different customer.");
      error.statusCode = 403;
      throw error;
    }
    const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
    const now = new Date().toISOString();
    const valid = events.filter((event) => EVENT_TYPES.has(String(event.type || "")));

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO call_recordings
          (conversation_id, customer_id, provider, model, scenario, started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO NOTHING
      `).run(
        conversationId,
        customerId,
        String(body.provider || "gemini-live").slice(0, 80),
        String(body.model || "").slice(0, 120) || null,
        String(body.scenario || "").slice(0, 80) || null,
        String(body.startedAt || now).slice(0, 40),
        now,
      );
      if (body.scenario) {
        db.prepare("UPDATE call_recordings SET scenario = ? WHERE conversation_id = ?")
          .run(String(body.scenario).slice(0, 80), conversationId);
      }

      for (const event of valid) {
        const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
        insertEvent.run(
          conversationId,
          event.type,
          event.turnId ? String(event.turnId).slice(0, 120) : null,
          event.epochId ? String(event.epochId).slice(0, 120) : null,
          Math.max(0, Number(event.atMs) || 0),
          event.durationMs == null ? null : Math.max(0, Number(event.durationMs) || 0),
          event.value == null ? null : Number(event.value) || 0,
          JSON.stringify(detail).slice(0, 6000),
          now,
        );

        if (event.type === "usage_updated") {
          db.prepare(`
            UPDATE call_recordings SET
              prompt_tokens = MAX(prompt_tokens, ?),
              response_tokens = MAX(response_tokens, ?),
              total_tokens = MAX(total_tokens, ?)
            WHERE conversation_id = ?
          `).run(
            Number(detail.promptTokenCount) || 0,
            Number(detail.responseTokenCount) || 0,
            Number(detail.totalTokenCount) || 0,
            conversationId,
          );
        }
        if (event.type === "session_ended") {
          db.prepare("UPDATE call_recordings SET ended_at = ?, duration_ms = ? WHERE conversation_id = ?")
            .run(now, Number(event.durationMs) || Number(event.atMs) || 0, conversationId);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { accepted: valid.length, rejected: events.length - valid.length };
  }

  /**
   * Playback evidence for one Twin response epoch, used by the Gate 3
   * confirmation-audibility guard. Returns `known: false` when the browser has
   * not reported anything about that epoch yet, so the guard can fail open
   * rather than block a real customer on a missing telemetry flush.
   */
  function heardEvidence(conversationId, epochId) {
    const identifier = String(epochId || "").trim();
    if (!identifier) return { known: false, audibleChunks: 0, state: null, reason: "no_epoch_supplied" };
    const rows = db.prepare(`
      SELECT event_type, at_ms, value_num, detail_json
      FROM call_events
      WHERE conversation_id = ? AND epoch_id = ?
      ORDER BY at_ms, id
    `).all(String(conversationId || ""), identifier);
    if (!rows.length) return { known: false, audibleChunks: 0, state: null, reason: "no_events_recorded" };
    let audibleChunks = 0;
    let state = null;
    for (const row of rows) {
      if (row.event_type === "heard_state_transition") {
        audibleChunks = Math.max(audibleChunks, Number(row.value_num) || 0);
        const detail = JSON.parse(row.detail_json || "{}");
        if (HEARD_STATES.includes(detail.state)) state = detail.state;
      }
      if (row.event_type === "response_audio_started") audibleChunks = Math.max(audibleChunks, 1);
    }
    return { known: true, audibleChunks, state, events: rows.length };
  }

  function report(conversationId) {
    const session = db.prepare(`
      SELECT cr.*, c.name AS customer_name, c.account_number
      FROM call_recordings cr JOIN customers c ON c.id = cr.customer_id
      WHERE cr.conversation_id = ?
    `).get(conversationId);
    if (!session) return null;

    const events = db.prepare(`
      SELECT event_type, turn_id, epoch_id, at_ms, duration_ms, value_num, detail_json
      FROM call_events WHERE conversation_id = ? ORDER BY at_ms, id
    `).all(conversationId).map((event) => ({ ...event, detail: JSON.parse(event.detail_json || "{}") }));

    const of = (type) => events.filter((event) => event.event_type === type);
    const durations = (type) => of(type).filter((event) => event.duration_ms != null).map((event) => event.duration_ms);
    const count = (type) => of(type).length;

    // ---- Response latency -------------------------------------------------
    const responseLatency = durations("response_audio_started");

    // ---- Audible stop -----------------------------------------------------
    const interruptions = of("response_interrupted").map((event) => ({
      epoch_id: event.epoch_id,
      at_ms: round(event.at_ms),
      provider_signal_ms: round(event.detail.providerSignalMs),
      playback_clear_ms: event.detail.playbackClearMs == null ? null : Number(event.detail.playbackClearMs),
      audible_stop_ms: event.detail.audibleStopMs == null ? null : Number(event.detail.audibleStopMs),
      audible_stop_precision: event.detail.audibleStopPrecision || "unknown",
      queued_sources_cleared: Number(event.detail.queuedSourcesCleared) || 0,
      audible_chunks_before_stop: Number(event.detail.audibleChunksBeforeStop) || 0,
    }));
    const audibleStop = interruptions.map((item) => item.audible_stop_ms).filter((value) => value != null);
    const playbackClear = interruptions.map((item) => item.playback_clear_ms).filter((value) => value != null);

    // ---- Heard state ------------------------------------------------------
    const epochs = new Map();
    for (const event of events) {
      if (!event.epoch_id) continue;
      const epoch = epochs.get(event.epoch_id) || {
        epoch_id: event.epoch_id,
        first_at_ms: event.at_ms,
        state: "planned",
        audible_chunks: 0,
        drafted_text: "",
        heard_text: "",
        unheard_text: "",
        resume_injected: false,
      };
      if (event.event_type === "heard_state_transition") {
        const detail = event.detail;
        if (HEARD_STATES.includes(detail.state)) epoch.state = detail.state;
        epoch.audible_chunks = Math.max(epoch.audible_chunks, Number(event.value_num) || 0);
        if (detail.draftedText) epoch.drafted_text = String(detail.draftedText);
        if (detail.heardText != null) epoch.heard_text = String(detail.heardText);
        if (detail.unheardText != null) epoch.unheard_text = String(detail.unheardText);
      }
      if (event.event_type === "resume_context_injected") epoch.resume_injected = true;
      epochs.set(event.epoch_id, epoch);
    }
    const epochList = [...epochs.values()].sort((a, b) => a.first_at_ms - b.first_at_ms);

    // ---- Interruption outcome estimate ------------------------------------
    // For each interrupted epoch, how much of what the caller did NOT hear
    // reappeared in the Twin's next spoken response? High coverage suggests the
    // explanation was preserved and resumed; low coverage with high coverage of
    // the *already heard* part suggests a restart. Estimate only.
    // The opening line, used only to spot the Twin starting over from scratch.
    const openingEpoch = epochList.find((epoch) => epoch.drafted_text) || null;
    const openingText = openingEpoch?.drafted_text || "";
    const outcomes = [];
    for (let index = 0; index < epochList.length; index += 1) {
      const epoch = epochList[index];
      if (epoch.state !== "interrupted") continue;
      const next = epochList.slice(index + 1).find((candidate) => candidate.drafted_text);
      const resumeCoverage = next ? coverageRatio(epoch.unheard_text, next.drafted_text) : null;
      const repeatCoverage = next ? coverageRatio(epoch.heard_text, next.drafted_text) : null;
      // Never score an epoch against itself: that would read as a reintroduction
      // whenever the opening line is the only drafted text on record.
      const reintroductionCoverage = next && openingText && next.epoch_id !== openingEpoch.epoch_id
        ? coverageRatio(openingText.slice(0, 160), next.drafted_text.slice(0, 240))
        : null;
      outcomes.push({
        epoch_id: epoch.epoch_id,
        next_epoch_id: next?.epoch_id || null,
        resume_coverage: resumeCoverage,
        repeat_coverage: repeatCoverage,
        reintroduction_coverage: reintroductionCoverage,
        estimate: resumeCoverage == null
          ? "unknown"
          : resumeCoverage >= 0.5
            ? "preserved_or_resumed"
            : repeatCoverage != null && repeatCoverage >= 0.6
              ? "restarted"
              : "yielded_to_new_topic",
        precision: "estimated-from-text-overlap",
      });
    }
    const preserved = outcomes.filter((item) => item.estimate === "preserved_or_resumed").length;
    const restarted = outcomes.filter((item) => item.estimate === "restarted").length;
    const suspectedReintroductions = outcomes
      .filter((item) => item.reintroduction_coverage != null && item.reintroduction_coverage >= 0.6).length;

    // ---- Business actions -------------------------------------------------
    const preparedActions = of("action_prepared").map((event) => ({
      at_ms: round(event.at_ms),
      intent_id: event.detail.intentId || null,
      request_type: event.detail.requestType || null,
    }));
    const committedActions = of("action_committed").map((event) => ({
      at_ms: round(event.at_ms),
      intent_id: event.detail.intentId || null,
      request_type: event.detail.requestType || null,
      reference: event.detail.reference || null,
      repeated: event.detail.repeated === true,
    }));
    const blockedActions = of("action_blocked").map((event) => ({
      at_ms: round(event.at_ms),
      phase: event.detail.phase || null,
      code: event.detail.code || null,
      reason: event.detail.reason || null,
    }));

    // ---- Reconciliation against the real database -------------------------
    const intents = db.prepare(`
      SELECT id, request_type, status, target_plan_name, amount, created_at, completed_at
      FROM action_intents WHERE conversation_id = ? ORDER BY created_at
    `).all(conversationId);
    const reviewRequests = db.prepare(`
      SELECT reference, type, status, reason, amount, created_at
      FROM service_requests WHERE conversation_id = ? ORDER BY created_at
    `).all(conversationId);
    const executedPlanChanges = db.prepare(`
      SELECT idempotency_key, status, from_plan_id, to_plan_id, created_at
      FROM plan_changes WHERE conversation_id = ? ORDER BY created_at
    `).all(conversationId);
    const completedIntents = intents.filter((intent) => intent.status === "completed").length;
    const executions = reviewRequests.length + executedPlanChanges.length;
    const uniqueCommittedIntents = new Set(committedActions.map((item) => item.intent_id).filter(Boolean)).size;

    const databaseMatch = {
      completed_intents: completedIntents,
      database_executions: executions,
      unique_committed_intents_in_timeline: uniqueCommittedIntents,
      duplicate_executions: Math.max(0, executions - completedIntents),
      money_issued: 0,
      /** Exactly-once proof: one confirmed intent produced exactly one row. */
      executions_match_intents: executions === completedIntents,
      /** The browser timeline and the database tell the same story. */
      timeline_matches_database: uniqueCommittedIntents === completedIntents,
      matches: executions === completedIntents && uniqueCommittedIntents === completedIntents,
    };

    // ---- Transcript -------------------------------------------------------
    const transcript = [];
    for (const event of events) {
      const speaker = event.event_type === "input_transcript_received"
        ? "customer"
        : event.event_type === "output_transcript_received"
          ? "twin"
          : null;
      const text = String(event.detail.text || "");
      if (!speaker || !text) continue;
      const previous = transcript.at(-1);
      const key = event.epoch_id || event.turn_id;
      if (previous && previous.speaker === speaker && previous.key === key) {
        previous.text += text;
      } else {
        transcript.push({ speaker, key, turn_id: event.turn_id, at_ms: round(event.at_ms), text });
      }
    }

    // ---- V5 experiment block ---------------------------------------------
    // Everything here is observation. It is derived only from the v5_* events,
    // which are not read by the confirmation-audibility guard, and it is kept
    // in its own object so a reader can see it never mixes into the gate
    // metrics above.
    const v5Configured = of("v5_experiment_configured").at(-1) || null;
    const laneOpens = of("v5_transcript_lane_opened");
    const laneCloses = of("v5_transcript_lane_closed");
    const laneErrors = of("v5_transcript_lane_error");
    const laneDegraded = of("v5_transcript_lane_degraded");
    const laneSegments = of("v5_transcript_segment");
    const laneUsage = of("v5_transcript_usage");
    const laneIds = [...new Set([...laneOpens, ...laneCloses, ...laneSegments].map((event) => event.detail.laneId).filter(Boolean))];

    // Playback quality. This block exists because a repetitive tick under the
    // agent's voice was reported by ear and had no number anywhere to check it
    // against. It is measurement, not a gate result.
    const playbackContext = of("v5_playback_context").at(-1) || null;
    const playbackSummary = of("v5_playback_summary").at(-1) || null;
    const playbackGaps = of("v5_playback_gap");
    const gapDurations = playbackGaps.map((event) => event.duration_ms).filter((value) => Number.isFinite(value));

    const v5Playback = playbackContext || playbackSummary
      ? {
        mode: playbackSummary?.detail.mode || playbackContext?.detail.mode || null,
        provider_output_sample_rate: playbackContext?.detail.providerOutputSampleRate ?? null,
        requested_sample_rate: playbackContext?.detail.requestedSampleRate ?? null,
        actual_sample_rate: playbackContext?.detail.actualSampleRate ?? null,
        matches_provider_rate: playbackContext?.detail.matchesProviderRate ?? null,
        /** True means the browser re-converted every chunk on its own, which
         *  leaves a discontinuity at each chunk boundary. */
        per_chunk_resampling: playbackContext?.detail.perChunkResampling ?? null,
        fallback_reason: playbackContext?.detail.fallbackReason ?? null,
        base_latency_ms: playbackContext?.detail.baseLatencyMs ?? null,
        chunks_scheduled: playbackSummary?.detail.chunksScheduled ?? null,
        gaps_inserted: playbackSummary?.detail.gapsInserted ?? playbackGaps.length,
        gap_rate: playbackSummary?.detail.gapRate ?? null,
        total_gap_ms: round(playbackSummary?.detail.totalGapMs ?? (gapDurations.length ? gapDurations.reduce((a, b) => a + b, 0) : null)),
        worst_gap_ms: round(playbackSummary?.detail.worstGapMs ?? (gapDurations.length ? Math.max(...gapDurations) : null)),
        gap_precision: "exact-scheduler-arithmetic-not-an-estimate",
        interpretation:
          "per_chunk_resampling true is the known cause of a periodic tick under the agent's voice: the browser restarts its resampling filter at every chunk boundary. gaps_inserted counts silence the scheduler had to add because a chunk arrived too late to be contiguous; each one is a separate audible discontinuity.",
      }
      : null;

    const v5Experiment = {
      /** Null when this call ran without the V5 additions. */
      configured: v5Configured
        ? {
          at_ms: round(v5Configured.at_ms),
          build_version: v5Configured.detail.buildVersion || null,
          voice_style_requested: v5Configured.detail.requestedStyle ?? null,
          voice_style_effective: v5Configured.detail.effectiveStyle ?? null,
          style_fell_back: v5Configured.detail.fellBackToBaseline === true,
          prompt_fingerprint: v5Configured.detail.promptFingerprint || null,
          prompt_characters: v5Configured.detail.promptCharacters ?? null,
          style_section_fingerprint: v5Configured.detail.styleSectionFingerprint ?? null,
          fingerprint_kind: v5Configured.detail.fingerprintKind || null,
          voice_model: v5Configured.detail.voiceModel || null,
          voice_name: v5Configured.detail.voiceName || null,
          sdk_version: v5Configured.detail.sdkVersion || null,
          smart_transcript_enabled: v5Configured.detail.smartTranscriptEnabled === true,
          transcript_lab_enabled: v5Configured.detail.transcriptLabEnabled === true,
          effective_configuration: v5Configured.detail.effectiveConfiguration || null,
        }
        : null,
      /** One row per dedicated/observed transcript lane on this call. */
      transcript_lanes: laneIds.map((laneId) => {
        const opened = laneOpens.filter((event) => event.detail.laneId === laneId);
        const closed = laneCloses.filter((event) => event.detail.laneId === laneId).at(-1) || null;
        const segments = laneSegments.filter((event) => event.detail.laneId === laneId);
        const finals = segments.filter((event) => event.detail.kind === "final");
        const errors = laneErrors.filter((event) => event.detail.laneId === laneId);
        const degraded = laneDegraded.filter((event) => event.detail.laneId === laneId);
        const usage = laneUsage.filter((event) => event.detail.laneId === laneId).at(-1) || null;
        const endToFinal = finals
          .map((event) => event.detail.endToFinalMs)
          .filter((value) => Number.isFinite(value));
        return {
          lane_id: laneId,
          label: opened.at(-1)?.detail.label || null,
          provenance: opened.at(-1)?.detail.provenance || null,
          authority: "display-only",
          generations: opened.length,
          reconnects: Math.max(0, opened.length - 1),
          opened_at_ms: opened.length ? round(opened[0].at_ms) : null,
          closed_at_ms: closed ? round(closed.at_ms) : null,
          final_state: closed?.detail.state || (errors.length ? "error" : "unknown"),
          setup_ms: round(opened.at(-1)?.detail.setupMs ?? null),
          credential_ms: round(opened.at(-1)?.detail.credentialMs ?? null),
          first_interim_ms: round(segments.find((event) => event.detail.kind === "interim")?.detail.sinceStartMs ?? null),
          interim_events: segments.length - finals.length,
          final_segments: finals.length,
          end_to_final_p50_ms: round(percentile(endToFinal, 0.5)),
          end_to_final_p95_ms: round(percentile(endToFinal, 0.95)),
          end_to_final_precision: "wall-clock-from-known-last-sample-to-actual-receipt",
          queue_high_water_mark: closed?.detail.queueHighWaterMark ?? null,
          stream_gaps: closed?.detail.streamGaps ?? Math.max(0, opened.length - 1),
          audio_seconds_sent: closed?.detail.audioSecondsSent ?? null,
          timed_out: closed?.detail.state === "timed_out" || closed?.detail.state === "timeout",
          degraded_events: degraded.length,
          errors: errors.map((event) => ({ at_ms: round(event.at_ms), area: event.detail.area || null, message: event.detail.message || null })),
          /** Per-lane token usage, or explicitly unknown. Never merged into the
           *  voice model's usage and never assumed to be zero. */
          usage: usage ? usage.detail.usage || null : null,
          usage_known: Boolean(usage && usage.detail.usage),
        };
      }),
      lab_replays: of("v5_lab_replay_finished").map((event) => ({
        at_ms: round(event.at_ms),
        clip_id: event.detail.clipId || null,
        clip_hash: event.detail.clipHash || null,
        lanes: event.detail.lanes || null,
        alignment_quality: event.detail.alignmentQuality || null,
      })),
      alignment: {
        quality: laneIds.length > 1
          ? (v5Configured?.detail.alignmentQuality || "independent-streams-approximate-by-receipt-time")
          : "not-applicable",
        note: "Lanes are aligned exactly only in the lab, by normalised-audio hash. Live lanes are shown as independent streams.",
      },
      playback: v5Playback,
      authority_note:
        "No transcript lane can authorise, block or alter a business action. The confirmation-audibility guard reads only heard_state_transition and response_audio_started.",
    };

    return {
      ...session,
      duration_ms: round(session.duration_ms),
      metrics: {
        turns: count("user_speech_ended"),
        responses: responseLatency.length,
        response_latency_p50_ms: round(percentile(responseLatency, 0.5)),
        response_latency_p95_ms: round(percentile(responseLatency, 0.95)),
        slowest_response_ms: round(responseLatency.length ? Math.max(...responseLatency) : null),

        interruptions: interruptions.length,
        audible_stop_p50_ms: round(percentile(audibleStop, 0.5)),
        audible_stop_p95_ms: round(percentile(audibleStop, 0.95)),
        slowest_audible_stop_ms: round(audibleStop.length ? Math.max(...audibleStop) : null),
        playback_clear_p95_ms: playbackClear.length ? Number(percentile(playbackClear, 0.95).toFixed(2)) : null,
        interruptions_before_any_audio: interruptions.filter((item) => item.audible_chunks_before_stop === 0).length,

        heard_epochs: epochList.length,
        completed_epochs: epochList.filter((epoch) => epoch.state === "completed").length,
        interrupted_epochs: epochList.filter((epoch) => epoch.state === "interrupted").length,
        unheard_segments_quarantined: count("unheard_content_quarantined"),
        resume_context_injections: count("resume_context_injected"),
        resume_context_failures: count("resume_context_failed"),
        interruption_outcomes_measured: outcomes.length,
        preserved_or_resumed: preserved,
        restarted_after_interruption: restarted,
        suspected_reintroductions: suspectedReintroductions,

        tools_requested: count("tool_requested"),
        tools_completed: count("tool_completed"),
        tools_failed: count("tool_failed"),
        tools_policy_blocked: count("tool_policy_blocked"),
        tool_latency_p50_ms: round(percentile(durations("tool_completed"), 0.5)),
        slowest_tool_ms: round(durations("tool_completed").length ? Math.max(...durations("tool_completed")) : null),

        actions_prepared: preparedActions.length,
        actions_committed: committedActions.length,
        actions_blocked: blockedActions.length,
        errors: count("error"),
      },
      database_match: databaseMatch,
      heard_state_timeline: epochList,
      interruption_timeline: interruptions,
      interruption_outcomes: outcomes,
      response_timeline: of("response_audio_started").map((event) => ({
        epoch_id: event.epoch_id,
        at_ms: round(event.at_ms),
        latency_ms: round(event.duration_ms),
        precision: event.detail.precision || "unknown",
      })),
      action_timeline: { prepared: preparedActions, committed: committedActions, blocked: blockedActions },
      database_state: { intents, review_requests: reviewRequests, plan_changes: executedPlanChanges },
      v5_experiment: v5Experiment,
      transcript,
      events: events.map((event) => ({
        event_type: event.event_type,
        turn_id: event.turn_id,
        epoch_id: event.epoch_id,
        at_ms: round(event.at_ms),
        duration_ms: round(event.duration_ms),
        detail: event.detail,
      })),
    };
  }

  function listCalls(limit = 20) {
    return db.prepare(`
      SELECT cr.conversation_id, cr.scenario, cr.started_at, cr.duration_ms, c.name AS customer_name
      FROM call_recordings cr JOIN customers c ON c.id = cr.customer_id
      ORDER BY cr.created_at DESC LIMIT ?
    `).all(limit);
  }

  function latestReports(limit = 8) {
    return db.prepare("SELECT conversation_id FROM call_recordings ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(({ conversation_id }) => report(conversation_id))
      .filter(Boolean);
  }

  return {
    enabled: true,
    status: () => ({ enabled: true, store: "local-sqlite", precision: "browser-monotonic-ms" }),
    ingest,
    heardEvidence,
    report,
    latestReports,
    listCalls,
  };
}
