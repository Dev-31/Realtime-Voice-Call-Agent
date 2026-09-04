/**
 * Browser side of the Call Flight Recorder.
 *
 * Batches events to the authenticated server endpoint. `flush()` is awaited
 * before any business tool call so the server has the heard-state evidence it
 * needs to decide whether a confirmation question actually reached the caller.
 */

function noopRecorder() {
  return {
    enabled: false,
    start() {},
    event() {},
    usage() {},
    async flush() {},
    async end() {},
  };
}

export function createFlightRecorderClient({ token, enabled = true, scenario = null } = {}) {
  if (!enabled || !token) return noopRecorder();

  let conversationId = null;
  let provider = "gemini-live";
  let model = "";
  let startedAt = null;
  let origin = 0;
  let queue = [];
  let flushTimer = null;
  let inFlight = null;
  let ended = false;

  async function sendBatch(events) {
    const response = await fetch("/api/flight-recorder/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ conversationId, provider, model, scenario, startedAt, events }),
    });
    if (!response.ok) throw new Error("The flight recorder endpoint rejected a batch.");
  }

  async function flush() {
    if (inFlight) await inFlight.catch(() => {});
    if (!conversationId || !queue.length) return;
    const events = queue;
    queue = [];
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    inFlight = sendBatch(events).catch(() => {
      // Keep the newest 500 events so a transient failure does not lose the call.
      queue = [...events, ...queue].slice(-500);
    });
    await inFlight;
    inFlight = null;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 250);
  }

  function event(type, { turnId = null, epochId = null, durationMs = null, value = null, detail = {} } = {}) {
    if (!conversationId) return;
    queue.push({ type, turnId, epochId, atMs: performance.now() - origin, durationMs, value, detail });
    if (queue.length >= 25) void flush(); else scheduleFlush();
  }

  return {
    enabled: true,
    get conversationId() { return conversationId; },
    start({ id, voiceProvider, voiceModel }) {
      conversationId = id;
      provider = voiceProvider || provider;
      model = voiceModel || "";
      startedAt = new Date().toISOString();
      origin = performance.now();
      ended = false;
      event("session_started", { detail: { scenario } });
    },
    event,
    usage(metadata = {}) {
      event("usage_updated", {
        detail: {
          promptTokenCount: metadata.promptTokenCount || 0,
          responseTokenCount: metadata.responseTokenCount || 0,
          totalTokenCount: metadata.totalTokenCount || 0,
        },
      });
    },
    flush,
    async end(detail = {}) {
      if (ended || !conversationId) return;
      ended = true;
      event("session_ended", { durationMs: performance.now() - origin, detail });
      await flush();
    },
  };
}
