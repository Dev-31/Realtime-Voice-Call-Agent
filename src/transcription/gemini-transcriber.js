/**
 * One dedicated transcription connection, with a hard boundary around it.
 *
 * PLAIN-ENGLISH VERSION
 * ---------------------
 * The voice call already works. This is a second listener sitting beside it,
 * writing down what it hears. It is allowed to be slow, to fail, or to be
 * switched off, and none of that may disturb the call. So:
 *
 *   - `pushAudio()` never waits for anything. It copies the bytes into a
 *     bounded queue and returns. It is safe to call from the microphone
 *     callback because it does no work there.
 *   - If the queue fills up, the helper STOPS and says it is degraded. It does
 *     not grow without limit, and it does not quietly throw audio away and then
 *     present the resulting gappy text as if it were complete.
 *   - Every failure path -- refused credential, refused connection, provider
 *     error, timeout, session cap -- ends with an explicit terminal state on the
 *     lane, so a missing transcript is visible as a failure rather than looking
 *     like silence.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * It receives `store` (a plain data structure) and callbacks. It has no access
 * to the voice session, the tool executor, the heard-state tracker, or the API
 * client that performs business actions. It cannot send anything to the agent.
 *
 * PROVIDER SHAPE
 * --------------
 * Live transcription has no boolean finality flag. Partial and final text are
 * distinguished by WHICH field arrives:
 *   serverContent.interimInputTranscription.text -> interim hypothesis
 *   serverContent.inputTranscription.text        -> finalised segment
 * A single server event may carry several parts, so every field present is
 * handled rather than the first one matched.
 */

import { TARGET_MIME_TYPE, bytesToBase64 } from "./audio-normalize.js";

export const TRANSCRIBER_DEFAULTS = Object.freeze({
  maxQueuedChunks: 200,
  connectTimeoutMs: 5000,
  finalGraceMs: 10000,
  maxSessionSeconds: 420,
  maxAudioSeconds: 420,
  /** How often the drain loop looks at the queue when it has nothing to do. */
  drainIntervalMs: 20,
});

/**
 * Read every transcription field out of one provider message.
 *
 * Exported so tests can drive it with real recorded event shapes, including
 * events that carry both fields at once.
 */
export function readTranscriptionEvents(message) {
  const content = message?.serverContent;
  if (!content || typeof content !== "object") return [];
  const events = [];
  const interim = content.interimInputTranscription;
  if (interim && typeof interim.text === "string" && interim.text.length) {
    events.push({ kind: "interim", text: interim.text });
  }
  const final = content.inputTranscription;
  if (final && typeof final.text === "string" && final.text.length) {
    events.push({ kind: "final", text: final.text });
  }
  return events;
}

/**
 * @param {object} options
 * @param {string} options.laneId which store lane this connection writes to
 * @param {object} options.store  a transcript store (data only)
 * @param {(args: {model: string, config: object, token: object, callbacks: object}) => Promise<object>} options.connect
 *        opens the provider session. Injected so tests never touch a network.
 * @param {() => Promise<object>} options.requestToken fetches a constrained credential
 * @param {() => number} [options.now] monotonic clock
 * @param {(status: object) => void} [options.onStatus]
 * @param {(metric: object) => void} [options.onMetric] observability sink
 */
export function createTranscriber({
  laneId,
  store,
  connect,
  requestToken,
  now = () => (typeof performance === "object" ? performance.now() : 0),
  onStatus = () => {},
  onMetric = () => {},
  limits = {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const config = { ...TRANSCRIBER_DEFAULTS, ...limits };

  // --- state ---------------------------------------------------------------
  let generation = -1;
  /** Identity of the session we currently accept messages from. */
  let liveSession = null;
  let sessionSerial = 0;
  let state = "idle";
  let stopped = true;
  const queue = [];
  let queuedBytes = 0;
  let queueHighWater = 0;
  let droppedChunks = 0;
  let sentChunks = 0;
  let sentBytes = 0;
  let audioEnded = false;
  let draining = false;
  const timers = new Set();
  const metrics = {
    tokenRequestedAt: null,
    tokenReceivedAt: null,
    connectStartedAt: null,
    socketOpenAt: null,
    firstInterimAt: null,
    firstFinalAt: null,
    lastFinalAt: null,
    audioEndedAt: null,
    closedAt: null,
    errors: [],
    disconnects: 0,
    reconnects: 0,
  };

  function track(fn, delay) {
    const timer = setTimeoutImpl(() => {
      timers.delete(timer);
      fn();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function clearTimers() {
    for (const timer of timers) clearTimeoutImpl(timer);
    timers.clear();
  }

  function setState(next, detail = null) {
    state = next;
    store?.setLaneStatus?.(laneId, next, detail);
    onStatus({ laneId, state: next, detail, generation, at: now() });
  }

  function noteError(area, message) {
    // Message text only, never a credential and never raw audio.
    const entry = { area, message: String(message ?? "").slice(0, 300), at: now(), generation };
    metrics.errors.push(entry);
    if (metrics.errors.length > 50) metrics.errors.shift();
    onMetric({ laneId, kind: "error", ...entry });
  }

  /** Give up on this lane, with an explicit reason recorded on every segment. */
  function terminate(segmentState, reason, { statusState = segmentState } = {}) {
    if (stopped && state === segmentState) return;
    stopped = true;
    clearTimers();
    const session = liveSession;
    liveSession = null;
    try { session?.close?.(); } catch { /* already gone */ }
    queue.length = 0;
    queuedBytes = 0;
    store?.resolveOpenSegments?.(laneId, segmentState, { detail: reason });
    store?.closeLane?.(laneId, { state: statusState, detail: reason });
    metrics.closedAt = now();
    setState(statusState, reason);
    onMetric({ laneId, kind: "terminated", segmentState, reason, at: now() });
  }

  /** Drain loop. Runs outside every hot callback. */
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!stopped) {
        if (!queue.length) {
          if (audioEnded) return;
          await new Promise((resolve) => track(resolve, config.drainIntervalMs));
          continue;
        }
        const session = liveSession;
        if (!session) return;
        const chunk = queue.shift();
        queuedBytes -= chunk.byteLength;
        try {
          session.sendRealtimeInput({
            audio: { data: bytesToBase64(chunk), mimeType: TARGET_MIME_TYPE },
          });
          sentChunks += 1;
          sentBytes += chunk.byteLength;
        } catch (error) {
          noteError("transcription-send", error?.message);
          terminate("unavailable", "send_failed");
          return;
        }
      }
    } finally {
      draining = false;
    }
  }

  function handleMessage(session, messageGeneration, message) {
    // Ignore anything from a previous connection generation. After a reconnect
    // the old socket can still deliver a queued message; treating it as current
    // would show stale words as the newest thing the caller said.
    if (session !== liveSession || messageGeneration !== generation) {
      onMetric({ laneId, kind: "stale_message_ignored", messageGeneration, generation, at: now() });
      return;
    }
    const events = readTranscriptionEvents(message);
    for (const event of events) {
      const at = now();
      if (event.kind === "interim" && metrics.firstInterimAt == null) metrics.firstInterimAt = at;
      if (event.kind === "final") {
        if (metrics.firstFinalAt == null) metrics.firstFinalAt = at;
        metrics.lastFinalAt = at;
      }
      store?.applyEvent?.({ laneId, kind: event.kind, text: event.text, generation, receivedAtMs: at });
    }
    if (message?.usageMetadata) {
      onMetric({ laneId, kind: "usage", usage: message.usageMetadata, generation, at: now() });
    }
  }

  return {
    get laneId() { return laneId; },
    get state() { return state; },
    get generation() { return generation; },
    get queueDepth() { return queue.length; },

    /**
     * Open a connection.
     *
     * A failure here is a normal outcome, not an exception to propagate into a
     * call: it resolves to `{ ok: false, reason }` and leaves the lane in a
     * terminal `unavailable` state.
     */
    async start({ tokenRequest = {} } = {}) {
      if (!stopped) return { ok: false, reason: "already_running" };
      stopped = false;
      audioEnded = false;
      queue.length = 0;
      queuedBytes = 0;
      generation += 1;
      sessionSerial += 1;
      if (generation > 0) metrics.reconnects += 1;
      store?.startGeneration?.(laneId, { detail: `generation ${generation}` });
      setState("requesting_credential");

      let credential;
      metrics.tokenRequestedAt = now();
      try {
        credential = await requestToken(tokenRequest);
      } catch (error) {
        noteError("transcription-token", error?.message);
        terminate("unavailable", error?.code || "token_refused");
        return { ok: false, reason: error?.code || "token_refused", message: error?.message || null };
      }
      if (stopped) return { ok: false, reason: "stopped_during_token" };
      metrics.tokenReceivedAt = now();

      setState("connecting");
      metrics.connectStartedAt = now();

      const thisGeneration = generation;
      let settled = false;
      const opened = new Promise((resolve) => {
        const timeout = track(() => {
          if (settled) return;
          settled = true;
          noteError("transcription-connect", "startup timeout");
          resolve({ ok: false, reason: "connect_timeout" });
        }, config.connectTimeoutMs);

        (async () => {
          try {
            const session = await connect({
              model: credential.model,
              config: credential.liveConfig || credential.config,
              token: credential,
              callbacks: {
                onopen: () => {
                  metrics.socketOpenAt = now();
                  onMetric({
                    laneId,
                    kind: "socket_opened",
                    setupMs: metrics.connectStartedAt == null ? null : metrics.socketOpenAt - metrics.connectStartedAt,
                    generation: thisGeneration,
                  });
                },
                onmessage: (message) => handleMessage(session, thisGeneration, message),
                onerror: (event) => noteError("transcription-connection", event?.message || "unknown"),
                onclose: (event) => {
                  metrics.disconnects += 1;
                  if (session !== liveSession) return;
                  // Provider closed us. Finish the HELPER only.
                  const reason = event?.reason ? String(event.reason).slice(0, 200) : "provider_closed";
                  terminate(audioEnded ? "finalized" : "unavailable", reason, { statusState: "disconnected" });
                },
              },
            });
            if (settled) {
              try { session?.close?.(); } catch { /* nothing to do */ }
              return;
            }
            settled = true;
            clearTimeoutImpl(timeout);
            timers.delete(timeout);
            liveSession = session;
            resolve({ ok: true, session });
          } catch (error) {
            if (settled) return;
            settled = true;
            clearTimeoutImpl(timeout);
            timers.delete(timeout);
            noteError("transcription-connect", error?.message);
            resolve({ ok: false, reason: "connect_failed", message: error?.message || null });
          }
        })();
      });

      const result = await opened;
      if (!result.ok) {
        terminate("unavailable", result.reason);
        return result;
      }
      if (stopped) {
        try { result.session.close?.(); } catch { /* nothing to do */ }
        return { ok: false, reason: "stopped_during_connect" };
      }

      setState("listening");

      // Our own session ceiling, kept below the provider's documented cap so we
      // degrade on our terms rather than being cut off mid-segment.
      track(() => {
        if (stopped) return;
        terminate("timed_out", "session_duration_cap");
      }, config.maxSessionSeconds * 1000);

      void drain();
      return { ok: true, generation, model: credential.model, mode: credential.mode || null };
    },

    /**
     * Hand the helper a copy of some audio.
     *
     * SYNCHRONOUS AND CHEAP BY CONTRACT. This is the function the microphone
     * callback calls, so it must never await, never allocate unboundedly, and
     * never throw into the caller.
     */
    pushAudio(bytes) {
      if (stopped || audioEnded) return { accepted: false, reason: "not_running" };
      const source = bytes instanceof Uint8Array ? bytes : null;
      if (!source || source.byteLength === 0) return { accepted: false, reason: "empty" };

      if (queue.length >= config.maxQueuedChunks) {
        // The consumer has fallen behind. Stop, and be honest about it. The
        // alternative -- dropping chunks and continuing -- would produce a
        // transcript with invisible holes in it.
        droppedChunks += 1;
        onMetric({ laneId, kind: "queue_overflow", queueDepth: queue.length, at: now() });
        terminate("timed_out", "queue_overflow_helper_stopped", { statusState: "degraded" });
        return { accepted: false, reason: "queue_overflow" };
      }

      // Copy so the voice core can reuse or mutate its own buffer freely.
      const copy = source.slice();
      queue.push(copy);
      queuedBytes += copy.byteLength;
      if (queue.length > queueHighWater) queueHighWater = queue.length;
      return { accepted: true, queueDepth: queue.length };
    },

    /**
     * Say that no more audio is coming, then wait a bounded grace period for a
     * final result.
     *
     * If nothing final arrives, the run is recorded as `timed_out` with its
     * partial text preserved -- it stays in the denominator as a failure rather
     * than being omitted from the comparison.
     */
    async endAudio({ graceMs = config.finalGraceMs } = {}) {
      if (stopped) return { ok: false, reason: "not_running" };
      audioEnded = true;
      metrics.audioEndedAt = now();
      setState("finishing");

      // Let the drain loop empty the queue first.
      const drainDeadline = now() + graceMs;
      while (queue.length && !stopped && now() < drainDeadline) {
        await new Promise((resolve) => track(resolve, config.drainIntervalMs));
      }

      try { liveSession?.sendRealtimeInput?.({ audioStreamEnd: true }); }
      catch (error) { noteError("transcription-stream-end", error?.message); }

      const finalsBefore = metrics.lastFinalAt;
      const deadline = now() + graceMs;
      while (!stopped && now() < deadline) {
        // A new final after the audio ended is what we are waiting for.
        if (metrics.lastFinalAt != null && metrics.lastFinalAt !== finalsBefore) break;
        if (metrics.lastFinalAt != null && metrics.audioEndedAt != null && metrics.lastFinalAt > metrics.audioEndedAt) break;
        await new Promise((resolve) => track(resolve, config.drainIntervalMs));
      }

      const gotFinalAfterAudio = metrics.lastFinalAt != null
        && metrics.audioEndedAt != null
        && metrics.lastFinalAt >= metrics.audioEndedAt;

      if (gotFinalAfterAudio || metrics.lastFinalAt != null) {
        terminate("finalized", "audio_complete", { statusState: "complete" });
        return {
          ok: true,
          timedOut: false,
          endToFinalMs: metrics.audioEndedAt == null || metrics.lastFinalAt == null
            ? null
            : metrics.lastFinalAt - metrics.audioEndedAt,
        };
      }

      terminate("timed_out", "no_final_within_grace_period");
      return { ok: false, timedOut: true, graceMs, endToFinalMs: null };
    },

    /** Operator or caller stopped it. Everything is torn down. */
    stop({ reason = "stopped" } = {}) {
      if (stopped) return { ok: true, alreadyStopped: true };
      terminate("cancelled", reason, { statusState: "stopped" });
      return { ok: true };
    },

    /** Everything the call report needs about this lane. Never any audio. */
    report() {
      return {
        laneId,
        state,
        generation,
        reconnects: metrics.reconnects,
        disconnects: metrics.disconnects,
        queueHighWaterMark: queueHighWater,
        droppedChunkEvents: droppedChunks,
        chunksSent: sentChunks,
        audioSecondsSent: sentBytes / 2 / 16000,
        credentialMs: metrics.tokenRequestedAt == null || metrics.tokenReceivedAt == null
          ? null
          : metrics.tokenReceivedAt - metrics.tokenRequestedAt,
        setupMs: metrics.connectStartedAt == null || metrics.socketOpenAt == null
          ? null
          : metrics.socketOpenAt - metrics.connectStartedAt,
        firstInterimAfterStartMs: metrics.socketOpenAt == null || metrics.firstInterimAt == null
          ? null
          : metrics.firstInterimAt - metrics.socketOpenAt,
        endToFinalMs: metrics.audioEndedAt == null || metrics.lastFinalAt == null
          ? null
          : metrics.lastFinalAt - metrics.audioEndedAt,
        endToFinalPrecision: "wall-clock-from-known-last-sample-to-actual-receipt",
        errors: metrics.errors.map((entry) => ({ ...entry })),
        /** Per-lane usage is reported only when the provider supplied it. */
        usageKnown: false,
      };
    },
  };
}
