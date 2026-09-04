/**
 * The transcript comparison lab -- controller half. No DOM in this file.
 *
 * PLAIN-ENGLISH VERSION
 * ---------------------
 * You pick a short audio clip. The lab turns it into one exact stream of
 * numbers -- once -- and then plays that identical stream to two different
 * speech recognisers, one after the other. One recogniser is asked to write
 * down every word as spoken. The other is asked to tidy the result up. You then
 * see both columns side by side and can say, in your own words, whether the
 * tidy one changed the meaning.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not decide which recogniser is right. Two machines can hear
 *     different words. A difference between them is a difference between two
 *     machine outputs, and nothing more.
 *   - It does not talk to the provider unless you press the run button, and it
 *     refuses to do so at all while the server says real calls are off. The
 *     default path is `dryRunClip`, which produces the whole plan -- model,
 *     mode, config, chunk count, byte count, wall-clock cost -- and contacts
 *     nothing.
 *
 * WHY THE PACING IS SLOW ON PURPOSE
 * ---------------------------------
 * Audio is fed one 100 ms chunk per 100 ms of real time, never faster. A
 * recogniser that endpoints on silence behaves differently when a 30 second
 * clip arrives in one burst, so a fast replay would be measuring our own
 * impatience rather than the recogniser.
 *
 * WHY THE LANES RUN ONE AT A TIME
 * -------------------------------
 * Both lanes hit the same provider quota. Running them together makes a quota
 * refusal look like a recognition failure in whichever lane happened to lose.
 * Sequential replay of byte-identical audio keeps the two results comparable and
 * keeps a refusal attributable.
 *
 * ISOLATION
 * ---------
 * This module imports the audio helpers, the transcript store and the
 * transcriber. It has no import path to the tool executor, the heard-state
 * ledger, the confirmation state or the agent prompt, and nothing it produces is
 * ever handed to any of them. Transcript text leaves this file only through
 * `view()` (for rendering, escaped by the panel) and the two export functions.
 * Flight-recorder events carry counts and timings only -- never a transcript
 * word -- so the call record cannot become a back door for this text.
 */

import {
  CLIP_LIMITS,
  FRAMES_PER_CHUNK,
  TARGET_MIME_TYPE,
  TARGET_SAMPLE_RATE,
  chunkPcm16,
  estimateRms,
  mixToMono,
  normalizeClip,
  validateClipFile,
  validateDecodedClip,
} from "./audio-normalize.js";
import { ALIGNMENT_QUALITY, LANE_DEFINITIONS, createTranscriptStore } from "./transcript-store.js";
import { TRANSCRIBER_DEFAULTS, createTranscriber } from "./gemini-transcriber.js";

/**
 * The two lanes the lab replays, and the provider mode each one asks for.
 *
 * `voice-core-raw` exists in the store for the live sidecar; it has no clip to
 * replay, so the lab never opens it.
 */
const LAB_LANES = Object.freeze({
  "dedicated-verbatim": Object.freeze({ mode: "VERBATIM" }),
  "dedicated-smart": Object.freeze({ mode: "SMART" }),
});

/** Lane order is fixed: the unedited column is always on the left. */
export const LAB_LANE_IDS = Object.freeze(Object.keys(LAB_LANES));

/**
 * The banner the panel must render. Kept here so the export and the screen
 * cannot drift apart, and so nothing downstream can quietly soften it.
 */
export const LAB_PROVENANCE = Object.freeze({
  headline: "Two recognisers can hear different words.",
  points: Object.freeze([
    "Both columns are machine output. Neither is a record of what a person meant.",
    "A difference between the columns proves the two machines disagreed. It is not proof that either one is right.",
    "Neither transcript can authorise, block or change anything. They are display only, and no lane here reaches a tool, a confirmation or the ledger.",
  ]),
});

/**
 * Reasons a reviewer can attach to a segment.
 *
 * `meaning_changed` is the one this whole lab exists for: the readable column
 * can be fluent, well punctuated and still say something the caller did not.
 * These ids are recorded verbatim in the export and are never read at runtime to
 * decide anything.
 */
export const REVIEW_FAILURE_REASONS = Object.freeze([
  Object.freeze({ id: "", label: "No problem recorded" }),
  Object.freeze({ id: "meaning_changed", label: "Meaning changed — the text says something different from the speech" }),
  Object.freeze({ id: "content_removed", label: "Words that mattered were dropped" }),
  Object.freeze({ id: "content_invented", label: "Words appear that were not spoken" }),
  Object.freeze({ id: "identifier_wrong", label: "A name, amount or reference number is wrong" }),
  Object.freeze({ id: "punctuation_changed_sense", label: "Punctuation or formatting changed the sense" }),
  Object.freeze({ id: "wrong_language_or_script", label: "Wrong language or script" }),
  Object.freeze({ id: "unreadable", label: "Too garbled to read" }),
  Object.freeze({ id: "no_output", label: "No text was produced at all" }),
]);

/** Rough loudness below which a clip is almost certainly the wrong file. */
const NEARLY_SILENT_RMS = 0.005;

const MAX_RUNS_KEPT = 12;
const MAX_NOTICES = 8;
const MAX_LANE_EVENTS = 40;

/** Store methods the transcriber and the lab call, forwarded by the tap below. */
const STORE_METHODS = Object.freeze([
  "startGeneration",
  "closeLane",
  "resolveOpenSegments",
  "setLaneStatus",
  "reviewSegment",
  "declareAlignment",
  "canPairSegments",
  "laneView",
  "snapshot",
  "reset",
]);

/**
 * A pass-through store that reports every successfully filed event.
 *
 * The transcriber owns provider-event parsing; this wrapper only observes what
 * it filed, so the flight recorder can carry per-segment timings without the
 * lab second-guessing which provider field meant what.
 */
function observeStore(store, onFiled) {
  const tap = {
    applyEvent(event) {
      const result = store.applyEvent(event);
      if (result?.filed) {
        try { onFiled(event, result); } catch { /* observation must never break a lane */ }
      }
      return result;
    },
  };
  for (const name of STORE_METHODS) {
    tap[name] = (...args) => store[name](...args);
  }
  Object.defineProperty(tap, "alignment", { get: () => store.alignment });
  return tap;
}

function shortMessage(error) {
  return String(error?.message ?? error ?? "").slice(0, 200);
}

function labError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function round(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Math.round(Number(value));
}

function chunkCountFor(byteLength) {
  return Math.max(0, Math.ceil(byteLength / (FRAMES_PER_CHUNK * 2)));
}

/**
 * @param {object} options
 * @param {object} options.features       the object from GET /api/v5/features
 * @param {(request: object) => Promise<object>} options.requestToken POST /api/v5/transcription/token
 * @param {(args: {model: string, config: object, token: object, callbacks: object}) => Promise<object>} options.connect
 * @param {(bytes: ArrayBuffer) => Promise<{channelData: Float32Array[], sampleRate: number, duration: number}>} options.decodeAudio
 * @param {object|null} [options.recorder] flight-recorder client; only counts and timings are sent
 * @param {() => number} [options.now]
 */
export function createTranscriptLab({
  features = null,
  requestToken = null,
  connect = null,
  decodeAudio = null,
  recorder = null,
  now = () => (typeof performance === "object" && performance ? performance.now() : Date.now()),
  readBytes = (file) => file.arrayBuffer(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  idPrefix = "lab",
} = {}) {
  const labFeatures = features?.transcriptLab || {};
  const serverLimits = labFeatures.limits || {};

  /**
   * Our working limits. The server's numbers win where it supplied them; the
   * transcriber defaults fill the rest. Nothing here can raise a server cap --
   * it can only be at or below it.
   */
  const limits = {
    ...TRANSCRIBER_DEFAULTS,
    ...(Number.isFinite(serverLimits.connectTimeoutMs) ? { connectTimeoutMs: serverLimits.connectTimeoutMs } : {}),
    ...(Number.isFinite(serverLimits.finalGraceMs) ? { finalGraceMs: serverLimits.finalGraceMs } : {}),
    ...(Number.isFinite(serverLimits.maxQueuedChunks) ? { maxQueuedChunks: serverLimits.maxQueuedChunks } : {}),
    ...(Number.isFinite(serverLimits.maxHelperSessionSeconds) ? { maxSessionSeconds: serverLimits.maxHelperSessionSeconds } : {}),
    ...(Number.isFinite(serverLimits.maxHelperAudioSeconds) ? { maxAudioSeconds: serverLimits.maxHelperAudioSeconds } : {}),
  };

  const clips = [];
  const runs = [];
  const notices = [];
  /** Transcribers that are open right now, so `cancelRun` can reach them. */
  const activeTranscribers = new Set();
  /** Outstanding pacing waits, so `destroy` can release every one. */
  const pendingWaits = new Set();

  let clipCounter = 0;
  let runCounter = 0;
  let activeRun = null;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Small internals
  // -------------------------------------------------------------------------

  function notice(kind, message, detail = null) {
    notices.unshift({ kind, message: String(message), detail, atMs: now() });
    notices.length = Math.min(notices.length, MAX_NOTICES);
  }

  /**
   * A wait that can be released early.
   *
   * Cancelling a run must not have to sit through the rest of a 100 ms pacing
   * gap, and `destroy()` must not leave a timer alive after the panel is gone.
   */
  function wait(ms) {
    return new Promise((resolve) => {
      const entry = { release: null };
      const timer = setTimeoutImpl(() => {
        pendingWaits.delete(entry);
        resolve();
      }, Math.max(0, ms));
      entry.release = () => {
        clearTimeoutImpl(timer);
        pendingWaits.delete(entry);
        resolve();
      };
      pendingWaits.add(entry);
    });
  }

  function releaseWaits() {
    for (const entry of [...pendingWaits]) entry.release();
  }

  function recorderEvent(type, detail) {
    if (!recorder || typeof recorder.event !== "function") return;
    try { recorder.event(type, { detail }); } catch { /* the recorder is observability, never a dependency */ }
  }

  function realCallsEnabled() {
    return labFeatures.realProviderCallsEnabled === true;
  }

  /** Why real calls are off, in the server's own terms. */
  function blockers() {
    const reasons = [];
    if (labFeatures.enabled === false) reasons.push("transcript_lab_disabled");
    if (labFeatures.realProviderCallsRequested !== true) reasons.push("real_provider_calls_disabled");
    if (features?.credentials?.geminiApiKeyPresent !== true) reasons.push("no_gemini_api_key");
    if (features?.transcription?.modelAllowed !== true) reasons.push("model_not_in_allowlist");
    return reasons;
  }

  function findClip(clipId) {
    return clips.find((clip) => clip.id === clipId) || null;
  }

  function normaliseLanes(requested) {
    const asked = new Set((Array.isArray(requested) ? requested : [requested]).map((value) => String(value)));
    return LAB_LANE_IDS.filter((laneId) => asked.has(laneId));
  }

  /** A clip without its audio. Everything that leaves the lab goes through here. */
  function publicClip(clip) {
    return {
      id: clip.id,
      name: clip.name,
      sizeBytes: clip.sizeBytes,
      declaredType: clip.declaredType,
      extension: clip.extension,
      hash: clip.hash,
      hashPrefix: clip.hash.slice(0, 12),
      durationSeconds: clip.durationSeconds,
      decodedDurationSeconds: clip.decodedDurationSeconds,
      byteLength: clip.byteLength,
      frames: clip.frames,
      chunkCount: clip.chunkCount,
      sampleRate: clip.sampleRate,
      channels: clip.channels,
      mimeType: clip.mimeType,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannels: clip.sourceChannels,
      rmsEstimate: clip.rmsEstimate,
      nearlySilent: clip.nearlySilent,
      addedAtMs: clip.addedAtMs,
      audioRetainedInMemoryOnly: clip.bytes != null,
    };
  }

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  /**
   * Validate, decode and normalise one chosen file.
   *
   * Nothing leaves the browser here. Normalisation happens exactly once, and
   * every lane later replays those same bytes -- which is what makes "the two
   * lanes heard the same thing" a checkable claim rather than an assurance.
   */
  async function addClip(file) {
    if (destroyed) return { ok: false, problems: ["The lab has been closed."] };
    if (!file) return { ok: false, problems: ["No file was chosen."] };
    if (typeof decodeAudio !== "function") {
      return { ok: false, problems: ["This browser build has no audio decoder wired to the lab."] };
    }
    if (clips.length >= CLIP_LIMITS.maxClipsPerBatch) {
      const message = `This batch already holds the maximum of ${CLIP_LIMITS.maxClipsPerBatch} clips. Remove one first.`;
      notice("rejected", message);
      return { ok: false, problems: [message], reason: "batch_full" };
    }

    const fileCheck = validateClipFile({ name: file.name, size: file.size, type: file.type });
    if (!fileCheck.ok) {
      notice("rejected", `${file.name ?? "That file"} was not accepted.`, fileCheck.problems.join(" "));
      return { ok: false, problems: fileCheck.problems, reason: "file_rejected" };
    }

    let decoded;
    try {
      decoded = await decodeAudio(await readBytes(file));
    } catch (error) {
      const problems = ["That file could not be decoded in this browser."];
      notice("rejected", problems[0], shortMessage(error));
      return { ok: false, problems, reason: "decode_failed", detail: shortMessage(error) };
    }

    const channelData = Array.isArray(decoded?.channelData) ? decoded.channelData : [];
    const sampleRate = Number(decoded?.sampleRate) || 0;
    const decodedDuration = Number.isFinite(decoded?.duration) && decoded.duration > 0
      ? Number(decoded.duration)
      : (channelData[0]?.length || 0) / (sampleRate || 1);

    const decodedCheck = validateDecodedClip({
      durationSeconds: decodedDuration,
      sampleRate,
      channels: channelData.length,
    });
    if (!decodedCheck.ok) {
      notice("rejected", `${file.name ?? "That clip"} was not accepted.`, decodedCheck.problems.join(" "));
      return { ok: false, problems: decodedCheck.problems, reason: "clip_rejected" };
    }

    // The loudness estimate is a separate read of the decoded channels. It is
    // never allowed to alter the bytes the lanes replay, which is why it does
    // not reuse -- or feed -- the one-shot normalisation below.
    const rmsEstimate = estimateRms(mixToMono(channelData));

    let normalised;
    try {
      normalised = await normalizeClip(channelData, sampleRate);
    } catch (error) {
      const problems = ["That clip could not be converted to the provider's audio format."];
      notice("rejected", problems[0], shortMessage(error));
      return { ok: false, problems, reason: "normalise_failed", detail: shortMessage(error) };
    }

    clipCounter += 1;
    const clip = {
      id: `${idPrefix}-clip-${clipCounter}`,
      name: String(file.name ?? "clip"),
      sizeBytes: fileCheck.sizeBytes,
      declaredType: fileCheck.declaredType,
      extension: fileCheck.extension,
      addedAtMs: now(),
      bytes: normalised.bytes,
      hash: normalised.hash,
      durationSeconds: normalised.durationSeconds,
      decodedDurationSeconds: decodedDuration,
      byteLength: normalised.byteLength,
      frames: normalised.frames,
      chunkCount: chunkCountFor(normalised.byteLength),
      sampleRate: normalised.sampleRate,
      channels: normalised.channels,
      mimeType: normalised.mimeType,
      sourceSampleRate: normalised.sourceSampleRate,
      sourceChannels: normalised.sourceChannels,
      rmsEstimate,
      nearlySilent: rmsEstimate != null && rmsEstimate < NEARLY_SILENT_RMS,
    };
    clips.push(clip);
    if (clip.nearlySilent) {
      notice("warning", `${clip.name} is almost silent. Check you picked the right file before spending a provider call on it.`);
    }
    return { ok: true, clip: publicClip(clip) };
  }

  function removeClip(clipId) {
    const index = clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return { ok: false, reason: "unknown_clip" };
    if (activeRun && activeRun.clipId === clipId) return { ok: false, reason: "clip_is_running" };
    const [clip] = clips.splice(index, 1);
    clip.bytes = null;
    // The runs stay: a finished comparison is evidence, and dropping it because
    // the source file was removed from the picker would quietly shrink the
    // denominator.
    return { ok: true, clipId };
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  /**
   * Everything a run would do, before any of it happens.
   *
   * The model is not chosen here. The server picks it when it issues the
   * credential; this records what the server reports so a reader can see which
   * model the plan assumes and notice if the two ever disagree.
   */
  function planFor(clip, laneId) {
    const definition = LANE_DEFINITIONS[laneId];
    const mode = LAB_LANES[laneId].mode;
    const chunkCount = chunkCountFor(clip.byteLength);
    const chunkSeconds = FRAMES_PER_CHUNK / TARGET_SAMPLE_RATE;
    return {
      laneId,
      label: definition.label,
      sublabel: definition.sublabel,
      provenance: definition.provenance,
      editorial: definition.editorial,
      authority: definition.authority,
      model: features?.transcription?.model ?? null,
      modelChosenBy: "server",
      mode,
      languageCodes: [],
      useProductVocabulary: false,
      vocabularyNote:
        "The lab never asks for the product vocabulary. It biases recognition, so switching it on would confound a VERBATIM-versus-SMART comparison, and the browser cannot reconstruct the server's term list to match a config-locked credential.",
      requestBody: { lane: "lab", mode, languageCodes: [] },
      requestedLiveConfig: {
        responseModalities: ["TEXT"],
        inputAudioTranscription: { languageCodes: [], mode },
      },
      configChosenBy: "server",
      audio: {
        mimeType: TARGET_MIME_TYPE,
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        framesPerChunk: FRAMES_PER_CHUNK,
        chunkSeconds,
        chunkCount,
        totalBytes: clip.byteLength,
        clipDurationSeconds: clip.durationSeconds,
        wallClockSeconds: chunkCount * chunkSeconds,
        pacingRule: "one chunk per FRAMES_PER_CHUNK/16000 s of wall clock, never faster than realtime",
      },
      graceMs: limits.finalGraceMs,
      estimatedTotalSeconds: chunkCount * chunkSeconds + limits.finalGraceMs / 1000,
      clipId: clip.id,
      clipHash: clip.hash,
      contactsProvider: false,
    };
  }

  function newLaneRecord(clip, laneId) {
    const definition = LANE_DEFINITIONS[laneId];
    return {
      laneId,
      label: definition.label,
      sublabel: definition.sublabel,
      provenance: definition.provenance,
      editorial: definition.editorial,
      authority: definition.authority,
      plan: planFor(clip, laneId),
      effective: null,
      status: { state: "idle", detail: null, atMs: null },
      started: null,
      ended: null,
      terminated: null,
      usage: null,
      errors: [],
      degraded: [],
      timings: {},
      report: null,
    };
  }

  function trimRuns() {
    while (runs.length > MAX_RUNS_KEPT) runs.shift();
  }

  /**
   * The DEFAULT path. Produces the full plan and contacts nothing.
   *
   * No flight-recorder event is emitted for a plan. The recorder's vocabulary
   * only has words for a replay that actually happened, and filing a plan as a
   * replay would overstate what took place.
   */
  function dryRunClip(clipId, { lanes = LAB_LANE_IDS } = {}) {
    const clip = findClip(clipId);
    if (!clip) return { ok: false, reason: "unknown_clip" };
    const laneIds = normaliseLanes(lanes);
    if (!laneIds.length) return { ok: false, reason: "no_lanes_selected" };

    runCounter += 1;
    const at = now();
    const run = {
      id: `${idPrefix}-run-${runCounter}`,
      kind: "plan",
      clipId: clip.id,
      clipName: clip.name,
      clipHash: clip.hash,
      startedAtMs: at,
      finishedAtMs: at,
      cancelled: false,
      contactedProvider: false,
      store: null,
      alignment: {
        quality: ALIGNMENT_QUALITY.none,
        key: clip.hash,
        note: "A plan produces no text, so there is nothing to align yet.",
      },
      pairingAllowed: false,
      lanes: laneIds.map((laneId) => {
        const record = newLaneRecord(clip, laneId);
        record.status = { state: "planned", detail: "No network call was made.", atMs: at };
        return record;
      }),
      blocked: realCallsEnabled() ? null : { reason: "real_provider_calls_disabled", blockers: blockers() },
      note: "Plan only. No audio left this browser and no credential was requested.",
    };
    runs.push(run);
    trimRuns();
    return { ok: true, run: runView(run) };
  }

  // -------------------------------------------------------------------------
  // Real runs
  // -------------------------------------------------------------------------

  /**
   * Fetch a credential and make sure it carries the config the connection needs.
   *
   * The token endpoint reports the configuration the SERVER chose but does not
   * echo the config object. We rebuild it from the server's own answer -- never
   * from what we asked for -- so the session matches the config-locked
   * credential. If the server attached vocabulary terms the browser cannot see,
   * we refuse: connecting with a config we already know is incomplete would
   * either be rejected or, worse, silently accepted as a different experiment.
   */
  async function credentialFor(request) {
    if (typeof requestToken !== "function") {
      throw labError("no_token_source", "The lab has no transcription token endpoint wired to it.");
    }
    const credential = await requestToken(request);
    if (!credential || typeof credential !== "object" || !credential.value) {
      throw labError("token_malformed", "The transcription credential endpoint returned nothing usable.");
    }
    if (credential.liveConfig || credential.config) return credential;
    if (Number(credential.vocabularyTermCount) > 0) {
      throw labError(
        "config_not_reconstructable",
        "The credential reports attached vocabulary terms but does not include the configuration, so the browser cannot match it.",
      );
    }
    return {
      ...credential,
      liveConfig: {
        responseModalities: ["TEXT"],
        inputAudioTranscription: {
          languageCodes: Array.isArray(credential.languageCodes) ? [...credential.languageCodes] : [],
          mode: credential.mode,
        },
      },
      liveConfigSource: "rebuilt-from-server-reported-mode-and-languages",
    };
  }

  function onLaneMetric(laneRecord, metric) {
    const laneId = laneRecord.laneId;
    if (metric.kind === "error") {
      laneRecord.errors.push({ area: metric.area ?? null, message: metric.message ?? null, atMs: round(metric.at) });
      laneRecord.errors.length = Math.min(laneRecord.errors.length, MAX_LANE_EVENTS);
      recorderEvent("v5_transcript_lane_error", { laneId, area: metric.area ?? null, message: metric.message ?? null });
      return;
    }
    if (metric.kind === "queue_overflow") {
      laneRecord.degraded.push({ reason: "queue_overflow", queueDepth: metric.queueDepth ?? null, atMs: round(metric.at) });
      laneRecord.degraded.length = Math.min(laneRecord.degraded.length, MAX_LANE_EVENTS);
      recorderEvent("v5_transcript_lane_degraded", { laneId, reason: "queue_overflow", queueDepth: metric.queueDepth ?? null });
      return;
    }
    if (metric.kind === "usage") {
      laneRecord.usage = metric.usage ?? null;
      recorderEvent("v5_transcript_usage", { laneId, usage: metric.usage ?? null });
      return;
    }
    if (metric.kind === "terminated") {
      laneRecord.terminated = { segmentState: metric.segmentState ?? null, reason: metric.reason ?? null, atMs: round(metric.at) };
    }
  }

  /** Replay the clip's exact bytes through one lane. */
  async function runLane(run, store, clip, laneRecord) {
    const laneId = laneRecord.laneId;
    const definition = LANE_DEFINITIONS[laneId];
    const laneStartedAtMs = now();
    laneRecord.timings.startedAtMs = round(laneStartedAtMs);

    const tapped = observeStore(store, (event) => {
      // Counts and timings only. A transcript word must never reach the call
      // record, which is read by the confirmation-audibility guard.
      recorderEvent("v5_transcript_segment", {
        laneId,
        kind: event.kind,
        sinceStartMs: round(now() - laneStartedAtMs),
      });
    });

    const transcriber = createTranscriber({
      laneId,
      store: tapped,
      connect,
      requestToken: credentialFor,
      now,
      onStatus: (status) => {
        laneRecord.status = { state: status.state, detail: status.detail ?? null, atMs: round(status.at) };
      },
      onMetric: (metric) => onLaneMetric(laneRecord, metric),
      limits: {
        connectTimeoutMs: limits.connectTimeoutMs,
        finalGraceMs: limits.finalGraceMs,
        maxQueuedChunks: limits.maxQueuedChunks,
        maxSessionSeconds: limits.maxSessionSeconds,
        maxAudioSeconds: limits.maxAudioSeconds,
        drainIntervalMs: limits.drainIntervalMs,
      },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    activeTranscribers.add(transcriber);

    try {
      const started = await transcriber.start({ tokenRequest: laneRecord.plan.requestBody });
      laneRecord.started = {
        ok: started.ok === true,
        reason: started.reason ?? null,
        message: started.message ?? null,
      };
      if (started.ok !== true) {
        // `start` already resolved every open segment to a terminal state, so
        // this lane stays in the denominator as an explicit failure.
        laneRecord.report = transcriber.report();
        laneRecord.timings.finishedAtMs = round(now());
        recorderEvent("v5_transcript_lane_error", {
          laneId,
          area: "lab-lane-start",
          message: String(started.reason ?? "start_failed"),
        });
        return;
      }

      laneRecord.effective = {
        model: started.model ?? laneRecord.plan.model,
        mode: started.mode ?? laneRecord.plan.mode,
        generation: started.generation ?? null,
      };
      const opened = transcriber.report();
      recorderEvent("v5_transcript_lane_opened", {
        laneId,
        label: definition.label,
        provenance: definition.provenance,
        setupMs: round(opened.setupMs),
        credentialMs: round(opened.credentialMs),
      });

      const chunks = chunkPcm16(clip.bytes, FRAMES_PER_CHUNK);
      const chunkMs = (FRAMES_PER_CHUNK / TARGET_SAMPLE_RATE) * 1000;
      const paceStartedAtMs = now();
      let sent = 0;
      let stoppedEarly = null;

      for (let index = 0; index < chunks.length; index += 1) {
        if (run.cancelled || destroyed) { stoppedEarly = "cancelled"; break; }
        const accepted = transcriber.pushAudio(chunks[index]);
        if (!accepted.accepted) { stoppedEarly = accepted.reason || "push_refused"; break; }
        sent += 1;
        // Deadline-based, so a slow tick never causes a catch-up burst. Falling
        // behind is allowed; getting ahead of realtime is not.
        const remainingMs = paceStartedAtMs + (index + 1) * chunkMs - now();
        if (remainingMs > 0) await wait(remainingMs);
      }

      const paceSeconds = (now() - paceStartedAtMs) / 1000;
      laneRecord.timings.chunksSent = sent;
      laneRecord.timings.chunksPlanned = chunks.length;
      laneRecord.timings.pacedAudioSeconds = (sent * chunkMs) / 1000;
      laneRecord.timings.paceSeconds = Number(paceSeconds.toFixed(3));
      // 25 ms of slack for timer granularity. Reported, not asserted.
      laneRecord.timings.neverFasterThanRealtime = paceSeconds >= (sent * chunkMs) / 1000 - 0.025;
      laneRecord.timings.stoppedEarly = stoppedEarly;

      if (stoppedEarly === "cancelled") {
        transcriber.stop({ reason: "cancelled_in_the_lab" });
      } else {
        const ended = await transcriber.endAudio({ graceMs: limits.finalGraceMs });
        laneRecord.ended = {
          ok: ended.ok === true,
          timedOut: ended.timedOut === true,
          endToFinalMs: round(ended.endToFinalMs),
          graceMs: ended.graceMs ?? limits.finalGraceMs,
          reason: ended.reason ?? null,
        };
      }
    } catch (error) {
      laneRecord.errors.push({ area: "lab-lane", message: shortMessage(error), atMs: round(now()) });
      transcriber.stop({ reason: "lab_lane_threw" });
      recorderEvent("v5_transcript_lane_error", { laneId, area: "lab-lane", message: shortMessage(error) });
    } finally {
      activeTranscribers.delete(transcriber);
      laneRecord.report = transcriber.report();
      laneRecord.timings.finishedAtMs = round(now());
      recorderEvent("v5_transcript_lane_closed", {
        laneId,
        state: laneRecord.status?.state ?? null,
        queueHighWaterMark: laneRecord.report.queueHighWaterMark,
        audioSecondsSent: laneRecord.report.audioSecondsSent,
        streamGaps: laneRecord.report.reconnects,
      });
    }
  }

  /**
   * Replay one clip through every requested lane, sequentially.
   *
   * Refuses outright while the server says real calls are off, and hands back
   * the plan instead so the reviewer still sees exactly what would have run.
   */
  async function runClip(clipId, { lanes = LAB_LANE_IDS } = {}) {
    if (destroyed) return { ok: false, reason: "lab_destroyed" };
    if (activeRun) return { ok: false, reason: "run_already_in_flight", runId: activeRun.id };
    const clip = findClip(clipId);
    if (!clip) return { ok: false, reason: "unknown_clip" };
    if (!clip.bytes) return { ok: false, reason: "clip_audio_released" };
    const laneIds = normaliseLanes(lanes);
    if (!laneIds.length) return { ok: false, reason: "no_lanes_selected" };
    if (typeof connect !== "function") return { ok: false, reason: "no_connect_function" };

    if (!realCallsEnabled()) {
      const refusal = blockers();
      notice("blocked", "Real transcription calls are switched off on this server. A plan was produced instead.", refusal.join(", "));
      const planned = dryRunClip(clipId, { lanes: laneIds });
      return { ok: false, reason: "real_provider_calls_disabled", blockers: refusal, plan: planned.run ?? null };
    }

    runCounter += 1;
    const runId = `${idPrefix}-run-${runCounter}`;
    let segmentSerial = 0;
    // Run-scoped segment ids, so a reviewer's score can never be filed against
    // a same-named segment from an earlier run.
    const store = createTranscriptStore({
      now,
      idFactory: (prefix) => {
        segmentSerial += 1;
        return `${runId}-${prefix}-${segmentSerial}`;
      },
    });
    // The lab's one real guarantee: every lane replayed byte-identical audio,
    // and this hash is what the comparison is keyed on.
    store.declareAlignment(ALIGNMENT_QUALITY.exact, { key: clip.hash });

    const run = {
      id: runId,
      kind: "provider",
      clipId: clip.id,
      clipName: clip.name,
      clipHash: clip.hash,
      startedAtMs: now(),
      finishedAtMs: null,
      cancelled: false,
      contactedProvider: true,
      store,
      alignment: store.alignment,
      pairingAllowed: false,
      lanes: laneIds.map((laneId) => newLaneRecord(clip, laneId)),
      blocked: null,
      note: "Lanes ran one after another so a quota refusal stays attributable to the lane that hit it.",
    };
    runs.push(run);
    trimRuns();
    activeRun = run;

    recorderEvent("v5_lab_replay_started", {
      clipId: clip.id,
      clipHash: clip.hash,
      lanes: laneIds,
      chunkCount: clip.chunkCount,
      wallClockSeconds: Number(((clip.chunkCount * FRAMES_PER_CHUNK) / TARGET_SAMPLE_RATE).toFixed(2)),
    });

    try {
      for (const laneRecord of run.lanes) {
        if (run.cancelled || destroyed) {
          // A lane that never opened still gets a row, so a cancelled run does
          // not read as a lane that produced silence.
          store.resolveOpenSegments(laneRecord.laneId, "cancelled", {
            detail: "The run was cancelled before this lane started.",
          });
          laneRecord.status = {
            state: "cancelled",
            detail: "The run was cancelled before this lane started.",
            atMs: round(now()),
          };
          continue;
        }
        await runLane(run, store, clip, laneRecord);
      }
    } finally {
      run.finishedAtMs = round(now());
      run.alignment = store.alignment;
      run.pairingAllowed = store.canPairSegments();
      activeRun = null;
      recorderEvent("v5_lab_replay_finished", {
        clipId: clip.id,
        clipHash: clip.hash,
        lanes: laneIds,
        alignmentQuality: store.alignment.quality,
      });
    }

    return { ok: true, run: runView(run) };
  }

  /** Stop everything in flight. Affected segments end as `cancelled`. */
  function cancelRun() {
    if (!activeRun) return { ok: false, reason: "nothing_running" };
    activeRun.cancelled = true;
    for (const transcriber of [...activeTranscribers]) {
      try { transcriber.stop({ reason: "cancelled_in_the_lab" }); } catch { /* already gone */ }
    }
    activeTranscribers.clear();
    releaseWaits();
    notice("cancelled", "The run was cancelled. Unfinished segments are recorded as cancelled, not as silence.");
    return { ok: true, runId: activeRun.id };
  }

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------

  /**
   * File a human score against one machine segment.
   *
   * The store keeps the review beside the machine text and never overwrites it.
   * Segment ids are run-scoped, so the newest-first search below can only match
   * the run the segment actually came from.
   */
  function reviewSegment(laneId, segmentId, review = {}) {
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (!run.store) continue;
      const filed = run.store.reviewSegment(laneId, segmentId, {
        score: review.score ?? null,
        comment: review.comment ?? null,
        failureReason: review.failureReason ?? null,
      });
      if (filed) return { ok: true, runId: run.id, laneId, segmentId, review: filed };
    }
    return { ok: false, reason: "unknown_segment" };
  }

  // -------------------------------------------------------------------------
  // View models
  // -------------------------------------------------------------------------

  function segmentsFor(laneSnapshot) {
    if (!laneSnapshot) return [];
    return laneSnapshot.generations.flatMap((generation) =>
      generation.segments.map((segment) => ({
        id: segment.id,
        laneId: segment.laneId,
        generation: generation.index,
        precededByGap: generation.precededByGap,
        sequence: segment.sequence,
        state: segment.state,
        text: segment.text,
        interimText: segment.interimText,
        displayText: segment.displayText,
        revisions: segment.revisions,
        lateArrival: segment.lateArrival === true,
        note: segment.note ?? null,
        review: segment.review ?? null,
        firstEventAtMs: round(segment.firstEventAtMs),
        finalizedAtMs: round(segment.finalizedAtMs),
      })),
    );
  }

  function laneCounts(segments) {
    const counts = {
      segments: segments.length,
      pending: 0,
      provisional: 0,
      finalized: 0,
      unavailable: 0,
      timed_out: 0,
      cancelled: 0,
      manually_reviewed: 0,
      reviewed: 0,
      lateArrivals: 0,
    };
    for (const segment of segments) {
      if (counts[segment.state] !== undefined) counts[segment.state] += 1;
      if (segment.review) counts.reviewed += 1;
      if (segment.lateArrival) counts.lateArrivals += 1;
    }
    return counts;
  }

  function laneView(run, laneRecord) {
    const snapshot = run.store ? run.store.laneView(laneRecord.laneId) : null;
    const segments = segmentsFor(snapshot);
    return {
      laneId: laneRecord.laneId,
      label: laneRecord.label,
      sublabel: laneRecord.sublabel,
      provenance: laneRecord.provenance,
      editorial: laneRecord.editorial,
      authority: laneRecord.authority,
      plan: laneRecord.plan,
      effective: laneRecord.effective,
      status: snapshot ? { ...snapshot.status, atMs: round(snapshot.status.at) } : laneRecord.status,
      started: laneRecord.started,
      ended: laneRecord.ended,
      terminated: laneRecord.terminated,
      usage: laneRecord.usage,
      usageKnown: laneRecord.usage != null,
      errors: laneRecord.errors.map((entry) => ({ ...entry })),
      degraded: laneRecord.degraded.map((entry) => ({ ...entry })),
      timings: { ...laneRecord.timings },
      report: laneRecord.report ? { ...laneRecord.report } : null,
      stats: snapshot ? { ...snapshot.stats } : null,
      closed: snapshot ? snapshot.closed : false,
      finalizedText: snapshot ? snapshot.finalizedText : "",
      unresolved: snapshot ? snapshot.unresolved : 0,
      failures: snapshot ? snapshot.failures.map((entry) => ({ ...entry })) : [],
      segments,
      counts: laneCounts(segments),
    };
  }

  function runView(run) {
    const lanes = run.lanes.map((laneRecord) => laneView(run, laneRecord));
    const counts = {
      segments: 0,
      finalized: 0,
      provisional: 0,
      pending: 0,
      unavailable: 0,
      timed_out: 0,
      cancelled: 0,
      manually_reviewed: 0,
      reviewed: 0,
    };
    for (const lane of lanes) {
      for (const key of Object.keys(counts)) counts[key] += lane.counts[key] ?? 0;
    }
    return {
      id: run.id,
      kind: run.kind,
      clipId: run.clipId,
      clipName: run.clipName,
      clipHash: run.clipHash,
      clipHashPrefix: run.clipHash.slice(0, 12),
      startedAtMs: round(run.startedAtMs),
      finishedAtMs: round(run.finishedAtMs),
      cancelled: run.cancelled,
      contactedProvider: run.contactedProvider,
      blocked: run.blocked,
      note: run.note,
      alignment: { ...run.alignment },
      pairingAllowed: run.pairingAllowed === true,
      lanes,
      counts,
      /** Only the finalized text is offered for comparison: a hypothesis is not a transcript. */
      comparableText: Object.fromEntries(lanes.map((lane) => [lane.laneId, lane.finalizedText])),
    };
  }

  function totals() {
    const counts = {
      clips: clips.length,
      runs: runs.length,
      plans: 0,
      providerRuns: 0,
      segments: 0,
      finalized: 0,
      provisional: 0,
      pending: 0,
      unavailable: 0,
      timed_out: 0,
      cancelled: 0,
      manually_reviewed: 0,
      reviewed: 0,
      lanesWithNoOutput: 0,
    };
    for (const run of runs) {
      if (run.kind === "plan") counts.plans += 1; else counts.providerRuns += 1;
      const view = runView(run);
      for (const key of ["segments", "finalized", "provisional", "pending", "unavailable", "timed_out", "cancelled", "manually_reviewed", "reviewed"]) {
        counts[key] += view.counts[key] ?? 0;
      }
      for (const lane of view.lanes) {
        if (run.kind === "provider" && !lane.finalizedText) counts.lanesWithNoOutput += 1;
      }
    }
    return counts;
  }

  function view() {
    return {
      enabled: labFeatures.enabled !== false,
      realProviderCallsEnabled: realCallsEnabled(),
      realProviderCallsRequested: labFeatures.realProviderCallsRequested === true,
      dryRunByDefault: labFeatures.dryRunByDefault !== false,
      storeAudioOnDisk: labFeatures.storeAudioOnDisk === true,
      blockers: blockers(),
      model: features?.transcription?.model ?? null,
      modelAllowed: features?.transcription?.modelAllowed === true,
      allowedModes: features?.transcription?.allowedModes ?? [],
      providerFacts: features?.transcription?.providerFacts ?? null,
      freeTierWarning: features?.dataHandling?.freeTierWarning ?? null,
      dataHandlingSource: features?.dataHandling?.source ?? null,
      dataHandlingChecked: features?.dataHandling?.checked ?? null,
      configurationErrors: features?.configurationErrors ?? [],
      provenance: LAB_PROVENANCE,
      segmentStates: ["pending", "provisional", "finalized", "unavailable", "timed_out", "cancelled", "manually_reviewed"],
      failureReasons: REVIEW_FAILURE_REASONS,
      laneOrder: LAB_LANE_IDS,
      lanes: LAB_LANE_IDS.map((laneId) => ({ ...LANE_DEFINITIONS[laneId], mode: LAB_LANES[laneId].mode })),
      clipLimits: {
        maxClipsPerBatch: CLIP_LIMITS.maxClipsPerBatch,
        maxSeconds: CLIP_LIMITS.maxSeconds,
        minSeconds: CLIP_LIMITS.minSeconds,
        maxBytes: CLIP_LIMITS.maxBytes,
      },
      graceMs: limits.finalGraceMs,
      clips: clips.map(publicClip),
      runs: runs.map(runView).reverse(),
      /** True only when at least one run replayed byte-identical audio to every lane. */
      pairingAllowed: runs.some((run) => run.pairingAllowed === true),
      busy: activeRun != null,
      busyClipId: activeRun?.clipId ?? null,
      busyRunId: activeRun?.id ?? null,
      cancellable: activeRun != null,
      notices: notices.map((entry) => ({ ...entry })),
      counts: totals(),
      destroyed,
    };
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  function exportLane(lane) {
    return {
      lane_id: lane.laneId,
      label: lane.label,
      sublabel: lane.sublabel,
      provenance: lane.provenance,
      editorial: lane.editorial,
      authority: lane.authority,
      planned_configuration: lane.plan,
      effective_configuration: lane.effective,
      status: lane.status,
      started: lane.started,
      ended: lane.ended,
      terminated: lane.terminated,
      timings: lane.timings,
      transcriber_report: lane.report,
      stats: lane.stats,
      usage: lane.usage,
      usage_known: lane.usageKnown,
      errors: lane.errors,
      degraded: lane.degraded,
      finalized_text: lane.finalizedText,
      unresolved_segments: lane.unresolved,
      failures: lane.failures,
      segment_states: lane.counts,
      segments: lane.segments.map((segment) => ({
        segment_id: segment.id,
        generation: segment.generation,
        preceded_by_gap: segment.precededByGap,
        sequence: segment.sequence,
        state: segment.state,
        text: segment.text,
        interim_text: segment.interimText,
        revisions: segment.revisions,
        late_arrival: segment.lateArrival,
        note: segment.note,
        review: segment.review,
      })),
    };
  }

  /**
   * A plain, JSON-serialisable record of everything in the lab.
   *
   * Audio bytes are never included -- not the source file, not the normalised
   * PCM, not a sample of it. The clip hash is the identity that makes a run
   * reproducible without shipping someone's voice around.
   */
  function exportReport() {
    return {
      generated_at_iso: new Date().toISOString(),
      build: features?.build ?? null,
      labels: {
        unedited_lane: LANE_DEFINITIONS["dedicated-verbatim"].label,
        edited_lane: LANE_DEFINITIONS["dedicated-smart"].label,
      },
      authority:
        "display-only. No lane in this report reached tool execution, confirmation state, the heard-state ledger, the agent prompt or a tool argument.",
      provenance: { headline: LAB_PROVENANCE.headline, points: [...LAB_PROVENANCE.points] },
      confidence_note:
        "No confidence score is reported. The provider does not return one on this path, and inventing one would be a fabricated number.",
      mode: {
        real_provider_calls_enabled: realCallsEnabled(),
        real_provider_calls_requested: labFeatures.realProviderCallsRequested === true,
        dry_run_by_default: labFeatures.dryRunByDefault !== false,
        store_audio_on_disk: labFeatures.storeAudioOnDisk === true,
        blockers: blockers(),
      },
      transcription_configuration: features?.transcription ?? null,
      data_handling: features?.dataHandling ?? null,
      audio_contract: {
        mime_type: TARGET_MIME_TYPE,
        sample_rate: TARGET_SAMPLE_RATE,
        channels: 1,
        frames_per_chunk: FRAMES_PER_CHUNK,
        pacing_rule: "one chunk per FRAMES_PER_CHUNK/16000 s of wall clock, never faster than realtime",
        normalised_once_per_clip: true,
      },
      clips: clips.map(publicClip),
      runs: runs.map(runView).map((run) => ({
        run_id: run.id,
        kind: run.kind,
        clip_id: run.clipId,
        clip_name: run.clipName,
        clip_hash: run.clipHash,
        contacted_provider: run.contactedProvider,
        cancelled: run.cancelled,
        blocked: run.blocked,
        note: run.note,
        started_at_ms: run.startedAtMs,
        finished_at_ms: run.finishedAtMs,
        duration_ms: run.finishedAtMs == null || run.startedAtMs == null ? null : run.finishedAtMs - run.startedAtMs,
        alignment: run.alignment,
        pairing_allowed: run.pairingAllowed,
        segment_states: run.counts,
        lanes: run.lanes.map(exportLane),
      })),
      counts: totals(),
      audio_included: false,
      audio_note: "Audio bytes are never exported. Clips are identified by the SHA-256 of their normalised samples.",
      known_limitations: [
        "Provider-side enforcement of the config-locked credential has not been independently observed by this build.",
        "A human review is one reviewer's judgement, recorded as written. It is not an accuracy measurement.",
        "A reviewer's score does not change a segment's machine state; the store keeps the two separate on purpose.",
      ],
    };
  }

  /**
   * Escape one CSV cell.
   *
   * Spreadsheets treat a leading `=`, `+`, `-` or `@` as the start of a formula,
   * and every text field below is untrusted -- a transcript, a clip filename or
   * a reviewer's note. A leading apostrophe forces the cell to stay literal.
   */
  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  const CSV_COLUMNS = Object.freeze([
    "run_id", "run_kind", "contacted_provider", "clip_id", "clip_name", "clip_hash",
    "clip_duration_seconds", "clip_bytes", "lane_id", "lane_label", "lane_editorial",
    "model", "mode", "chunk_count", "chunks_sent", "wall_clock_seconds", "pace_seconds",
    "lane_status", "lane_status_detail", "end_to_final_ms", "timed_out",
    "row_kind", "segment_id", "segment_state", "late_arrival", "revisions", "text",
    "review_score", "review_failure_reason", "review_comment", "failure_note",
    "lane_timeouts", "lane_unavailable", "lane_cancelled",
  ]);

  /** The same rows as the JSON report, one line per segment. Never any audio. */
  function exportCsv() {
    const lines = [CSV_COLUMNS.map(csvCell).join(",")];
    for (const run of runs.map(runView)) {
      const clip = clips.find((entry) => entry.id === run.clipId) || null;
      for (const lane of run.lanes) {
        const base = {
          run_id: run.id,
          run_kind: run.kind,
          contacted_provider: run.contactedProvider,
          clip_id: run.clipId,
          clip_name: run.clipName,
          clip_hash: run.clipHash,
          clip_duration_seconds: clip ? clip.durationSeconds.toFixed(3) : "",
          clip_bytes: clip ? clip.byteLength : "",
          lane_id: lane.laneId,
          lane_label: lane.label,
          lane_editorial: lane.editorial,
          model: lane.effective?.model ?? lane.plan.model ?? "",
          mode: lane.effective?.mode ?? lane.plan.mode,
          chunk_count: lane.plan.audio.chunkCount,
          chunks_sent: lane.timings.chunksSent ?? "",
          wall_clock_seconds: lane.plan.audio.wallClockSeconds.toFixed(2),
          pace_seconds: lane.timings.paceSeconds ?? "",
          lane_status: lane.status?.state ?? "",
          lane_status_detail: lane.status?.detail ?? "",
          end_to_final_ms: lane.ended?.endToFinalMs ?? "",
          timed_out: lane.ended?.timedOut === true,
          lane_timeouts: lane.counts.timed_out,
          lane_unavailable: lane.counts.unavailable,
          lane_cancelled: lane.counts.cancelled,
        };
        if (!lane.segments.length) {
          // A lane with no segment still gets a line. Missing output is a
          // failure that stays in the denominator, never an empty success.
          lines.push(CSV_COLUMNS.map((column) => csvCell({
            ...base,
            row_kind: run.kind === "plan" ? "plan" : "lane_without_output",
            segment_id: "",
            segment_state: "",
            late_arrival: "",
            revisions: "",
            text: "",
            review_score: "",
            review_failure_reason: "",
            review_comment: "",
            failure_note: run.kind === "plan" ? "No network call was made." : "The lane produced no segment.",
          }[column])).join(","));
          continue;
        }
        for (const segment of lane.segments) {
          lines.push(CSV_COLUMNS.map((column) => csvCell({
            ...base,
            row_kind: "segment",
            segment_id: segment.id,
            segment_state: segment.state,
            late_arrival: segment.lateArrival,
            revisions: segment.revisions,
            text: segment.state === "provisional" ? segment.interimText : segment.text,
            review_score: segment.review?.score ?? "",
            review_failure_reason: segment.review?.failureReason ?? "",
            review_comment: segment.review?.comment ?? "",
            failure_note: segment.note ?? "",
          }[column])).join(","));
        }
      }
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  function destroy() {
    destroyed = true;
    if (activeRun) activeRun.cancelled = true;
    for (const transcriber of [...activeTranscribers]) {
      try { transcriber.stop({ reason: "lab_destroyed" }); } catch { /* already gone */ }
    }
    activeTranscribers.clear();
    releaseWaits();
    activeRun = null;
    // Drop the audio. The reports keep the hashes, so a run stays readable
    // without holding someone's recorded voice in memory.
    for (const clip of clips) clip.bytes = null;
    return { ok: true };
  }

  return {
    addClip,
    removeClip,
    runClip,
    cancelRun,
    dryRunClip,
    reviewSegment,
    exportReport,
    exportCsv,
    view,
    destroy,
    get busy() { return activeRun != null; },
    get laneIds() { return LAB_LANE_IDS; },
    get limits() { return { ...limits }; },
  };
}
