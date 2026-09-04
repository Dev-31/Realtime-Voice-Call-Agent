/**
 * HCR ActionGuard voice core -- direct Gemini Live, browser audio substrate.
 *
 * Responsibilities, in order of importance to the demo:
 *   1. Stop fast and completely when the caller speaks (Gate 1).
 *   2. Know exactly what the caller heard before the stop, and tell the model
 *      so it cannot claim delivery of words that never played (Gate 2).
 *   3. Route every business action through prepare -> distinct later
 *      confirmation -> idempotent commit (Gate 3).
 *   4. Emit an honest event timeline for all of the above (Gate 4).
 */

import { ActivityHandling, GoogleGenAI, Modality } from "@google/genai";
import { HeardStateTracker } from "../hcr/heard-state.js";
import { SpeechEnergyProbe } from "../hcr/speech-energy-probe.js";
import {
  composeSystemInstruction,
  DEFAULT_VOICE_STYLE,
  deliveryStyleReport,
  resolveVoiceStyle,
} from "./delivery-style.js";
import {
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_LEAD_MS,
  V4_PLAYBACK_LEAD_MS,
  createGapMeter,
  createOutputContext,
  resolvePlaybackMode,
} from "./playback-mode.js";
import { DEFAULT_VOICE, resolveVoice, voiceDescriptor } from "./voices.js";
import { DEFAULT_NOISE_MODE, resolveNoiseMode, noiseActivityOverride, noiseModeReport, captureSettingsReport } from "./noise-mode.js";

export const AUDIO_CONFIG = Object.freeze({
  /** 1024 frames at a typical 48 kHz capture rate is about 21 ms per chunk. */
  inputBufferFrames: 1024,
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  prefixPaddingMs: 120,
  silenceDurationMs: 500,
});

const MICROPHONE_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
});

// --- session state ---------------------------------------------------------
let activeSession = null;
let recorder = noopRecorder();
let conversationId = null;
let disconnectRequested = false;
let resumeInjectionEnabled = true;

// --- V5 additions ----------------------------------------------------------
/**
 * The delivery style for THIS session. Fixed at connect time on purpose: a
 * style that changed mid-call would make a paired comparison meaningless.
 */
let activeVoiceStyle = DEFAULT_VOICE_STYLE;
/**
 * Optional transcription sidecar.
 *
 * A plain object with a synchronous `pushAudio` and a `stop`. The voice core
 * knows nothing else about it, never awaits it, and never reads anything back
 * from it. If it throws, the throw is swallowed here and the call continues.
 */
let transcriptHelper = null;
let helperPushFailures = 0;
/**
 * How the output context is created. `continuous` runs it at the provider's own
 * 24 kHz so the browser has nothing to resample per chunk; `v4-compatible`
 * reproduces V4 exactly, audible chunk-boundary tick included.
 */
let activePlaybackMode = DEFAULT_PLAYBACK_MODE;
/** The prebuilt voice for THIS session. Fixed at connect time. */
let activeVoice = DEFAULT_VOICE;
let activeNoiseMode = DEFAULT_NOISE_MODE;
/** Whether the server granted the affective (2.5) engine for this session. */
let activeAffectiveDialog = false;
/** What the output context actually turned out to be. Reported, not assumed. */
let outputContextInfo = null;
/** Counts the silence the scheduler had to insert. See playback-mode.js. */
let gapMeter = createGapMeter();

// --- audio state -----------------------------------------------------------
let microphoneStream = null;
let inputContext = null;
let inputSource = null;
let inputProcessor = null;
let silentGain = null;
let outputContext = null;
let nextPlaybackTime = 0;
let playbackEpoch = 0;
let playbackQueue = Promise.resolve();
const playingSources = new Set();
const audibleTimers = new Set();
let epochPlaybackStartTime = null;
let queuedChunks = 0;
let energyProbe = null;

// --- conversation state ----------------------------------------------------
let heardState = new HeardStateTracker();
let customerTurnId = null;
let awaitingConfirmationPrompt = false;
let confirmationPromptEpochId = null;
let latestCustomerTranscript = "";
let latestPreparedIntentId = null;
let responseLatencyAnchor = null;
const completedToolCalls = new Map();
const cancelledToolCalls = new Set();

function noopRecorder() {
  return { enabled: false, start() {}, event() {}, usage() {}, async flush() {}, async end() {} };
}

export function setResumeInjectionEnabled(value) {
  resumeInjectionEnabled = value !== false;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function resampleTo16k(input, sourceRate) {
  if (sourceRate === AUDIO_CONFIG.inputSampleRate) return input;
  const ratio = sourceRate / AUDIO_CONFIG.inputSampleRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) total += input[sourceIndex];
    output[index] = total / Math.max(1, end - start);
  }
  return output;
}

function floatToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

async function api(token, path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || "The request failed.");
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Playback: schedule, measure, and clear instantly on interruption
// ---------------------------------------------------------------------------

/** Exact milliseconds of this epoch's audio that has already left the speaker. */
function audibleMillisecondsSoFar() {
  if (!outputContext || epochPlaybackStartTime == null) return 0;
  return Math.max(0, (outputContext.currentTime - epochPlaybackStartTime) * 1000);
}

function clearPlayback() {
  for (const timer of audibleTimers) clearTimeout(timer);
  audibleTimers.clear();
  for (const source of playingSources) {
    try { source.stop(); } catch {}
    try { source.disconnect(); } catch {}
  }
  playingSources.clear();
  queuedChunks = 0;
  if (outputContext) nextPlaybackTime = outputContext.currentTime;
}

async function playChunk(base64Audio, scheduledEpoch) {
  if (scheduledEpoch !== playbackEpoch) return;
  if (!outputContext) {
    // Created lazily, on the first chunk of the call. The mode is fixed for the
    // whole session so a paired comparison stays meaningful.
    outputContextInfo = createOutputContext({ mode: activePlaybackMode });
    outputContext = outputContextInfo.context;
    recorder.event("v5_playback_context", {
      detail: {
        mode: outputContextInfo.mode,
        requestedSampleRate: outputContextInfo.requestedSampleRate,
        actualSampleRate: outputContextInfo.actualSampleRate,
        providerOutputSampleRate: AUDIO_CONFIG.outputSampleRate,
        matchesProviderRate: outputContextInfo.matchesProviderRate,
        perChunkResampling: outputContextInfo.perChunkResampling,
        fallbackReason: outputContextInfo.fallbackReason,
        baseLatencyMs: Number.isFinite(outputContext.baseLatency)
          ? Number((outputContext.baseLatency * 1000).toFixed(2))
          : null,
        note: outputContextInfo.note,
      },
    });
  }
  if (outputContext.state === "suspended") await outputContext.resume();
  if (scheduledEpoch !== playbackEpoch) return;

  const bytes = base64ToBytes(base64Audio);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  const buffer = outputContext.createBuffer(1, samples.length, AUDIO_CONFIG.outputSampleRate);
  buffer.copyToChannel(samples, 0);
  const durationMs = buffer.duration * 1000;

  const epoch = heardState.ensureEpoch();
  heardState.noteAudioScheduled(durationMs);

  const source = outputContext.createBufferSource();
  source.buffer = buffer;
  source.connect(outputContext.destination);
  if (scheduledEpoch !== playbackEpoch) return;

  // The clamp is correct -- audio cannot be scheduled in the past -- but when
  // the stream stalls it inserts real silence mid-word, which is its own click.
  // V4 never measured that, so nobody could tell whether it was happening.
  // Determined BEFORE scheduling: both the cushion and the gap meter need it.
  const firstChunkOfEpoch = epochPlaybackStartTime == null;

  /**
   * THE CUSHION -- this is the fix for "the voice is bursting out".
   *
   * V4 guaranteed only 20 ms of scheduling headroom. Gemini's chunks are
   * 196-276 ms long, and measurement showed them arriving 2-75 ms late fairly
   * often. Whenever a chunk missed that 20 ms window the scheduler had to
   * insert real silence mid-word, and the audio then resumed abruptly -- a
   * stall-and-burst, several times per reply.
   *
   * So the FIRST chunk of a reply is scheduled a little further ahead, building
   * a cushion that later chunks ride on. Subsequent chunks stay exactly
   * contiguous, so nothing is stretched or delayed once speech has started.
   *
   * ADR-008 asks the load-bearing question about any new output buffering: is
   * it recallable? Yes, completely. `clearPlayback()` iterates `playingSources`
   * -- which every source joins BEFORE `source.start()` -- and stops each one,
   * including sources that have not begun sounding yet. So a barge-in still
   * silences everything instantly. Per ADR-008's own rule, a fully recallable
   * buffer of any depth contributes ZERO to the barge-in floor, so this costs
   * nothing in interruption speed.
   *
   * What it does cost is first-audio latency, by exactly the cushion. That is
   * recorded in the report rather than hidden, because it spends part of the
   * frozen p95 budget.
   */
  const leadSeconds = (firstChunkOfEpoch ? PLAYBACK_LEAD_MS : V4_PLAYBACK_LEAD_MS) / 1000;
  const startAt = Math.max(nextPlaybackTime, outputContext.currentTime + leadSeconds);
  const insertedGapMs = gapMeter.note(startAt, nextPlaybackTime, firstChunkOfEpoch);
  if (insertedGapMs > 1) {
    recorder.event("v5_playback_gap", {
      epochId: heardState.active?.id || null,
      durationMs: Number(insertedGapMs.toFixed(2)),
      detail: {
        reason: "next_chunk_arrived_too_late_to_be_contiguous",
        withinResponse: true,
        precision: "exact-scheduler-arithmetic",
      },
    });
  }
  if (firstChunkOfEpoch) {
    epochPlaybackStartTime = startAt;
    recorder.event("response_audio_started", {
      epochId: epoch.id,
      turnId: customerTurnId,
      durationMs: responseLatencyAnchor == null ? null : performance.now() - responseLatencyAnchor,
      detail: {
        precision: responseLatencyAnchor == null
          ? "unanchored"
          : "browser-estimated-speech-end-to-first-audio-scheduled",
        /**
         * The measurement above is speech-end to audio SCHEDULED. The caller
         * hears it `scheduleLeadMs` later, so anyone comparing against the
         * frozen p95 budget must add this. Reported rather than folded in, so
         * the two V4-comparable numbers stay comparable.
         */
        scheduleLeadMs: Math.round(leadSeconds * 1000),
        audibleAtMs: responseLatencyAnchor == null
          ? null
          : Math.round(performance.now() - responseLatencyAnchor + leadSeconds * 1000),
      },
    });
    responseLatencyAnchor = null;
  }

  playingSources.add(source);
  source.onended = () => {
    playingSources.delete(source);
    queuedChunks = Math.max(0, queuedChunks - 1);
    settleIfDrained();
  };
  source.start(startAt);
  nextPlaybackTime = startAt + buffer.duration;
  queuedChunks += 1;

  // Count the chunk as heard at the moment it actually starts sounding.
  const timer = setTimeout(() => {
    audibleTimers.delete(timer);
    if (scheduledEpoch !== playbackEpoch) return;
    heardState.noteAudioAudible(durationMs);
  }, Math.max(0, (startAt - outputContext.currentTime) * 1000));
  audibleTimers.add(timer);
}

function settleIfDrained() {
  if (queuedChunks > 0 || playingSources.size > 0) return;
  const epoch = heardState.noteAudioDrained();
  if (!epoch) return;
  recorder.event("agent_speech_ended", {
    epochId: epoch.id,
    durationMs: epoch.audibleMs,
    detail: { chunks: epoch.audibleChunks, precision: "decoded-audio-fully-played" },
  });
  emitHeardState(epoch);
  epochPlaybackStartTime = null;
}

function emitHeardState(epoch) {
  const snapshot = typeof epoch.snapshot === "function" ? epoch.snapshot() : epoch;
  recorder.event("heard_state_transition", {
    epochId: snapshot.epochId,
    turnId: customerTurnId,
    value: snapshot.audibleChunks,
    detail: snapshot,
  });
}

// ---------------------------------------------------------------------------
// Interruption: stop, freeze the heard/unheard split, hand the truth back
// ---------------------------------------------------------------------------

function handleProviderInterruption() {
  const signalAt = performance.now();
  const speechStartedAt = energyProbe?.speechStartedAt() ?? null;
  const audibleMs = audibleMillisecondsSoFar();
  const queuedBeforeClear = playingSources.size + queuedChunks;

  playbackEpoch += 1;
  clearPlayback();
  const clearedAt = performance.now();
  epochPlaybackStartTime = null;

  const epoch = heardState.interrupt({ audibleMsOverride: audibleMs });
  if (!epoch) return;

  recorder.event("response_interrupted", {
    epochId: epoch.id,
    turnId: customerTurnId,
    durationMs: epoch.audibleMs,
    detail: {
      providerSignalMs: speechStartedAt == null ? null : signalAt - speechStartedAt,
      playbackClearMs: clearedAt - signalAt,
      audibleStopMs: speechStartedAt == null ? null : clearedAt - speechStartedAt,
      audibleStopPrecision: speechStartedAt == null
        ? "unmeasured"
        : "browser-energy-estimated-speech-start-plus-exact-clear",
      queuedSourcesCleared: queuedBeforeClear,
      audibleChunksBeforeStop: epoch.audibleChunks,
      discardedChunks: Math.max(0, epoch.scheduledChunks - epoch.audibleChunks),
    },
  });
  emitHeardState(epoch);

  if (epoch.unheardText) {
    recorder.event("unheard_content_quarantined", {
      epochId: epoch.id,
      value: epoch.unheardText.length,
      detail: {
        heardCharacters: epoch.heardText.length,
        unheardCharacters: epoch.unheardText.length,
        unheardText: epoch.unheardText,
        precision: "estimated-from-audio-progress",
      },
    });
  }
  injectResumeNote(epoch);
}

/**
 * Push the heard/unheard split back into the provider session.
 *
 * A provider-managed Live session keeps its own transcript, and we cannot
 * delete the part that never played. So we correct it instead: an explicit
 * call-state note that the system instruction treats as authoritative.
 */
function injectResumeNote(epoch) {
  const note = heardState.resumeNote();
  if (!note) return;
  if (!resumeInjectionEnabled || !activeSession) {
    recorder.event("resume_context_failed", {
      epochId: epoch.id,
      detail: { reason: resumeInjectionEnabled ? "no_active_session" : "disabled_by_operator" },
    });
    return;
  }
  try {
    activeSession.sendClientContent({
      turns: [{ role: "user", parts: [{ text: note }] }],
      turnComplete: false,
    });
    recorder.event("resume_context_injected", {
      epochId: epoch.id,
      value: note.length,
      detail: { note, mechanism: "sendClientContent(turnComplete:false)" },
    });
  } catch (error) {
    recorder.event("resume_context_failed", { epochId: epoch.id, detail: { reason: error.message } });
  }
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

async function startMicrophone(onStatus) {
  microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { ...MICROPHONE_CONSTRAINTS } });
  const settings = microphoneStream.getAudioTracks?.()[0]?.getSettings?.() || {};
  recorder.event("audio_frontend_ready", {
    detail: {
      requested: MICROPHONE_CONSTRAINTS,
      actual: {
        echoCancellation: settings.echoCancellation ?? null,
        noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null,
        channelCount: settings.channelCount ?? null,
        sampleRate: settings.sampleRate ?? null,
      },
      role: "capture-telemetry-only",
      note: "Headphones are the judged baseline. Open-speaker echo handling is not validated.",
    },
  });

  inputContext = new AudioContext({ latencyHint: "interactive" });
  await inputContext.resume();

  energyProbe = new SpeechEnergyProbe({
    onStart: (detail) => {
      customerTurnId = `turn-${crypto.randomUUID()}`;
      recorder.event("user_speech_started", { turnId: customerTurnId, detail });
    },
    onEnd: (detail) => {
      responseLatencyAnchor = performance.now() - detail.trailingSilenceMs;
      recorder.event("user_speech_ended", {
        turnId: customerTurnId,
        durationMs: detail.durationMs,
        detail,
      });
    },
  });

  inputSource = inputContext.createMediaStreamSource(microphoneStream);
  inputProcessor = inputContext.createScriptProcessor(AUDIO_CONFIG.inputBufferFrames, 1, 1);
  silentGain = inputContext.createGain();
  silentGain.gain.value = 0;
  inputProcessor.onaudioprocess = (event) => {
    if (!activeSession) return;
    const mono = event.inputBuffer.getChannelData(0);
    energyProbe?.push(mono, inputContext.sampleRate);
    const audio = floatToPcm16(resampleTo16k(mono, inputContext.sampleRate));
    try {
      activeSession.sendRealtimeInput({
        audio: { data: bytesToBase64(audio), mimeType: `audio/pcm;rate=${AUDIO_CONFIG.inputSampleRate}` },
      });
    } catch (error) {
      recorder.event("error", { detail: { area: "microphone-send", message: error.message } });
    }

    // V5 sidecar tap. Deliberately LAST, so the voice path has already been
    // served, and deliberately synchronous with no await: this runs inside the
    // audio callback. `pushAudio` copies the bytes into its own bounded queue
    // and returns. Nothing here can change the sample rate, chunk size, timing
    // or activity decisions the voice core just used -- the helper receives the
    // same bytes that were sent, after they were sent.
    if (transcriptHelper) {
      try {
        transcriptHelper.pushAudio(audio);
      } catch (error) {
        // A broken helper must never end or reconnect the main call.
        helperPushFailures += 1;
        if (helperPushFailures <= 3) {
          recorder.event("v5_transcript_lane_error", {
            detail: {
              laneId: transcriptHelper.laneId || "unknown",
              area: "audio-tap",
              message: error.message,
            },
          });
        }
        if (helperPushFailures > 3) transcriptHelper = null;
      }
    }
  };
  inputSource.connect(inputProcessor);
  inputProcessor.connect(silentGain);
  silentGain.connect(inputContext.destination);
  onStatus(`Microphone live · ${Math.round((AUDIO_CONFIG.inputBufferFrames / (settings.sampleRate || 48000)) * 1000)} ms chunks`);
}

// ---------------------------------------------------------------------------
// Gemini configuration
// ---------------------------------------------------------------------------

export function toolDeclarations() {
  return [{
    functionDeclarations: [
      {
        name: "get_account_context",
        description: "Read this authenticated caller's live account: current plan, exact INR prices, latest bill, any disputed charge, and recent requests. Required before answering any account-specific question. Its result is the only authority for account facts.",
        parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "submit_billing_request",
        description: "The only surface that causes a real business action, in two phases across two separate caller turns. Use phase 'prepare' when the caller's complete contribution asks, by its meaning in context, for a specific supported outcome; prepare never changes anything and returns a server intent ID to read back. Use phase 'commit' with that intent ID only after a later complete caller turn confirms that same request. Never infer either phase from a particular word, spelling, quoted speech, hypothetical, or background audio.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            phase: { type: "string", enum: ["prepare", "commit"] },
            requestType: { type: "string", enum: ["plan_change", "refund_review"] },
            targetPlanId: { type: ["string", "null"], description: "For a plan change, an exact active plan ID from get_account_context." },
            amount: { type: ["number", "null"], description: "For a billing review, the disputed amount the caller named, or null. The server drops any amount the account does not support." },
            intentId: { type: ["string", "null"], description: "For commit, the server intent ID that prepare returned." },
          },
          required: ["phase", "requestType"],
          additionalProperties: false,
        },
      },
    ],
  }];
}

export const VOICE_NAME = "Kore";

/**
 * The live session configuration.
 *
 * `voiceStyle` changes exactly ONE thing: which system-instruction string is
 * sent. The voice, the modalities, the tool declarations and every endpointing
 * threshold are identical for both styles, which is what makes the A/B a
 * comparison of delivery rather than of two different agents.
 *
 * Deliberately absent: `enableAffectiveDialog` and `proactivity`. Google
 * documents both as unsupported on gemini-3.1-flash-live-preview -- they are
 * 2.5-only, and require v1beta even there -- so sending them would be a silent
 * no-op at best. Checked 2026-09-03:
 * https://ai.google.dev/gemini-api/docs/live-api/capabilities
 */
export function liveConfig(
  customer = {},
  { voiceStyle = DEFAULT_VOICE_STYLE, voice = DEFAULT_VOICE, affectiveDialog = false, noiseMode = DEFAULT_NOISE_MODE } = {},
) {
  const chosenVoice = resolveVoice(voice).voice;
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: chosenVoice } } },
    /**
     * Only ever set when the SERVER granted the 2.5 engine. Google documents
     * affective dialogue as unsupported on 3.1, so sending it there would be
     * a silent no-op that made the report look like the feature was on.
     */
    ...(affectiveDialog ? { enableAffectiveDialog: true } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: AUDIO_CONFIG.prefixPaddingMs,
        silenceDurationMs: AUDIO_CONFIG.silenceDurationMs,
        ...noiseActivityOverride(noiseMode),
      },
    },
    systemInstruction: composeSystemInstruction(customer, voiceStyle),
    tools: toolDeclarations(),
  };
}

/** The style this session is actually running. */
export function activeVoiceStyleName() {
  return activeVoiceStyle;
}

/** The voice and engine this session is actually running. */
export function activeVoiceIdentity() {
  return {
    voice: activeVoice,
    descriptor: voiceDescriptor(activeVoice),
    affectiveDialog: activeAffectiveDialog,
  };
}

/** The playback mode this session is running, and what it actually got. */
export function playbackStatus() {
  return {
    mode: activePlaybackMode,
    actualSampleRate: outputContextInfo?.actualSampleRate ?? null,
    perChunkResampling: outputContextInfo?.perChunkResampling ?? null,
    fallbackReason: outputContextInfo?.fallbackReason ?? null,
    gaps: gapMeter.report(),
  };
}

/**
 * Attach or detach the transcription sidecar.
 *
 * Contract for whatever is attached: `pushAudio(Uint8Array)` must be
 * synchronous, cheap and non-throwing, and `stop()` must be safe to call twice.
 */
export function setTranscriptHelper(helper) {
  transcriptHelper = helper || null;
  helperPushFailures = 0;
  return Boolean(transcriptHelper);
}

export function transcriptHelperAttached() {
  return Boolean(transcriptHelper);
}

export function shouldPlayProviderAudio(message) {
  return Boolean(message?.data && !message?.serverContent?.interrupted);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function blockedToolResult(error) {
  return {
    ok: false,
    executed: false,
    accountUnchanged: true,
    error: error.body?.error || error.message,
    code: error.body?.code || error.code || "tool_error",
    nextConversationAction: error.body?.recovery || "state_that_nothing_changed_and_stop",
  };
}

async function runToolCall(token, call, onToolEvent, turn) {
  if (completedToolCalls.has(call.id)) return completedToolCalls.get(call.id);
  const startedAt = performance.now();
  recorder.event("tool_requested", {
    turnId: turn.id,
    epochId: heardState.active?.id || null,
    detail: { name: call.name, callId: call.id, phase: call.args?.phase || null },
  });

  let response;
  try {
    if (call.name === "get_account_context") {
      const context = await api(token, "/api/voice/account-context");
      response = { id: call.id, name: call.name, response: { ok: true, ...context } };
      recorder.event("tool_completed", {
        turnId: turn.id,
        durationMs: performance.now() - startedAt,
        detail: { name: call.name, planId: context.account?.currentPlan?.id || null },
      });
    } else if (call.name === "submit_billing_request") {
      response = await runBillingTool(token, call, startedAt, onToolEvent, turn);
    } else {
      response = {
        id: call.id,
        name: call.name,
        response: { ok: false, error: "That tool is not available.", nextConversationAction: "stop" },
      };
      recorder.event("tool_failed", { detail: { name: call.name, reason: "unknown_tool" } });
    }
  } catch (error) {
    const payload = blockedToolResult(error);
    response = { id: call.id, name: call.name, response: payload };
    recorder.event(error.statusCode === 409 ? "tool_policy_blocked" : "tool_failed", {
      turnId: turn.id,
      durationMs: performance.now() - startedAt,
      detail: { name: call.name, code: payload.code, reason: payload.error },
    });
    if (call.name === "submit_billing_request") {
      recorder.event("action_blocked", {
        turnId: turn.id,
        detail: { phase: call.args?.phase || null, code: payload.code, reason: payload.error },
      });
      onToolEvent(`Action blocked · ${payload.error}`);
    }
  }

  completedToolCalls.set(call.id, response);
  return response;
}

async function runBillingTool(token, call, startedAt, onToolEvent, turn) {
  const args = call.args || {};
  const phase = String(args.phase || "");

  // Give the server the heard-state evidence it needs before it decides.
  await recorder.flush();

  const payload = {
    phase,
    requestType: args.requestType,
    targetPlanId: args.targetPlanId ?? null,
    amount: args.amount ?? null,
    intentId: phase === "commit" ? (args.intentId || latestPreparedIntentId) : null,
    preparationKey: call.id,
    conversationId,
    customerTurnId: turn.id,
    customerTranscript: turn.transcript,
    confirmationPromptEpochId: phase === "commit" ? confirmationPromptEpochId : null,
  };

  const result = await api(token, "/api/voice/billing-request", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const durationMs = performance.now() - startedAt;
  recorder.event("tool_completed", {
    turnId: turn.id,
    durationMs,
    detail: { name: call.name, phase, requestType: result.request?.requestType || null },
  });

  if (phase === "prepare") {
    latestPreparedIntentId = result.intentId;
    awaitingConfirmationPrompt = true;
    confirmationPromptEpochId = null;
    recorder.event("action_prepared", {
      turnId: turn.id,
      detail: {
        intentId: result.intentId,
        requestType: result.request?.requestType,
        supersededPendingRequests: result.supersededPendingRequests || 0,
        mutated: false,
      },
    });
    onToolEvent(
      result.request?.requestType === "plan_change"
        ? `Prepared · ${result.request.targetPlanName} · awaiting a separate confirmation`
        : "Prepared · Billing review request · awaiting a separate confirmation",
    );
  } else {
    recorder.event("action_committed", {
      turnId: turn.id,
      detail: {
        intentId: result.intentId,
        requestType: result.request?.requestType,
        reference: result.reference || null,
        repeated: result.repeated === true,
        confirmationAudibility: result.confirmationAudibility?.code || null,
      },
    });
    latestPreparedIntentId = null;
    onToolEvent(
      result.repeated
        ? "Replay ignored · the existing result was reused, nothing ran twice"
        : `Executed exactly once · ${result.reference || result.intentId}`,
    );
  }

  return { id: call.id, name: call.name, response: { ok: true, ...result } };
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export async function connectVoiceAgent({
  token,
  customer,
  recorder: recorderClient,
  onStatus,
  onToolEvent,
  voiceStyle = DEFAULT_VOICE_STYLE,
  playbackMode = DEFAULT_PLAYBACK_MODE,
  voice = DEFAULT_VOICE,
  voiceMode = "standard",
  noiseMode = DEFAULT_NOISE_MODE,
  features = null,
}) {
  if (activeSession) return activeSession;
  recorder = recorderClient || noopRecorder();
  conversationId = crypto.randomUUID();
  disconnectRequested = false;
  activeVoiceStyle = resolveVoiceStyle(voiceStyle).style;
  activePlaybackMode = resolvePlaybackMode(playbackMode).mode;
  activeVoice = resolveVoice(voice).voice;
  activeNoiseMode = resolveNoiseMode(noiseMode);
  gapMeter = createGapMeter();

  heardState = new HeardStateTracker({
    idFactory: () => `epoch-${crypto.randomUUID()}`,
    now: () => performance.now(),
    onTransition: (snapshot) => {
      if (snapshot.state === "planned") {
        recorder.event("response_planned", { epochId: snapshot.epochId, detail: { resumeOf: snapshot.resumeOf } });
        if (awaitingConfirmationPrompt) {
          awaitingConfirmationPrompt = false;
          confirmationPromptEpochId = snapshot.epochId;
        }
      }
    },
  });

  onStatus("Requesting a short-lived Gemini Live credential…");
  // The server validates the mode against its own allowlist and returns the
  // model it chose. We never name a model from here.
  const credential = await api(token, "/api/voice/client-token", {
    method: "POST",
    body: JSON.stringify({ voiceMode }),
  });
  activeAffectiveDialog = credential.affectiveDialog === true;
  const ai = new GoogleGenAI({
    apiKey: credential.value,
    httpOptions: { apiVersion: credential.apiVersion || "v1beta" },
  });
  const connectStartedAt = performance.now();
  recorder.start({ id: conversationId, voiceProvider: "gemini-live", voiceModel: credential.model });

  // Record exactly which configuration this call ran, so a reader can tell
  // whether two calls really were identical apart from the delivery style.
  recorder.event("v5_experiment_configured", {
    detail: {
      ...deliveryStyleReport(customer, activeVoiceStyle),
      buildVersion: features?.build?.version || null,
      voiceModel: credential.model,
      voiceName: activeVoice,
      voiceDescriptor: voiceDescriptor(activeVoice),
      voiceMode: credential.voiceMode || null,
      voiceModeDowngraded: credential.voiceModeDowngraded || null,
      affectiveDialog: activeAffectiveDialog,
      engineExperimental: credential.experimental === true,
      smartTranscriptEnabled: features?.smartTranscript?.serverEnabled === true,
      transcriptLabEnabled: features?.transcriptLab?.enabled === true,
      helperAttached: Boolean(transcriptHelper),
      playbackMode: activePlaybackMode,
      effectiveConfiguration: {
        inputSampleRate: AUDIO_CONFIG.inputSampleRate,
        outputSampleRate: AUDIO_CONFIG.outputSampleRate,
        prefixPaddingMs: AUDIO_CONFIG.prefixPaddingMs,
        silenceDurationMs: AUDIO_CONFIG.silenceDurationMs,
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        turnDetection: "provider-native-automatic-vad",
        noiseHandling: noiseModeReport(activeNoiseMode),
        affectiveDialog: "not-sent-unsupported-on-this-model",
        proactiveAudio: "not-sent-unsupported-on-this-model",
      },
    },
  });

  const dispatchToolCalls = (calls) => {
    const session = activeSession;
    // Freeze the caller turn now: turnComplete may clear it while a tool is
    // still in flight, and the commit guard depends on this identity.
    const turn = {
      id: customerTurnId || `turn-${crypto.randomUUID()}`,
      transcript: latestCustomerTranscript,
    };
    void (async () => {
      const functionResponses = [];
      for (const call of calls) {
        const response = await runToolCall(token, call, onToolEvent, turn);
        if (response && !cancelledToolCalls.has(call.id)) functionResponses.push(response);
      }
      if (!functionResponses.length || !session || activeSession !== session) return;
      try { session.sendToolResponse({ functionResponses }); }
      catch (error) {
        recorder.event("error", { detail: { area: "tool-response-send", message: error.message } });
      }
    })().catch((error) => {
      recorder.event("error", { detail: { area: "tool-dispatch", message: error.message } });
    });
  };

  const handleMessage = (message) => {
    // Ignore anything from a session that is no longer the active one. The tool
    // path already guards this way; the audio path did not, so a leaked session
    // could keep scheduling audio onto the shared playback cursor and click at
    // every boundary between the two streams. `activeSession` is still null
    // while this very session is connecting, so allow that case through.
    if (activeSession && activeSession !== thisSession) return;
    for (const callId of message.toolCallCancellation?.ids || []) cancelledToolCalls.add(callId);

    if (message.serverContent?.interrupted) {
      handleProviderInterruption();
      onToolEvent("Interruption heard · playback cleared, unfinished words quarantined");
    }

    if (shouldPlayProviderAudio(message)) {
      const audio = message.data;
      const scheduledEpoch = playbackEpoch;
      playbackQueue = playbackQueue
        .then(() => playChunk(audio, scheduledEpoch))
        .catch((error) => recorder.event("error", { detail: { area: "audio-playback", message: error.message } }));
    }

    const input = message.serverContent?.inputTranscription;
    if (input?.text) {
      customerTurnId ||= `turn-${crypto.randomUUID()}`;
      latestCustomerTranscript = `${latestCustomerTranscript} ${input.text}`.trim().slice(-2000);
      recorder.event("input_transcript_received", {
        turnId: customerTurnId,
        detail: { text: input.text, finalized: input.finished !== false, precision: "provider-event" },
      });
      onStatus(`Caller: ${input.text}`);
    }

    const output = message.serverContent?.outputTranscription;
    if (output?.text && !message.serverContent?.interrupted) {
      const epoch = heardState.noteDraftText(output.text, { finished: output.finished === true });
      recorder.event("output_transcript_received", {
        epochId: epoch?.id || null,
        detail: { text: output.text, finalized: output.finished === true, precision: "provider-event" },
      });
      onStatus(`Twin: ${output.text}`);
    }

    if (message.usageMetadata) recorder.usage(message.usageMetadata);

    const calls = message.toolCall?.functionCalls || [];
    if (calls.length && activeSession) dispatchToolCalls(calls);

    if (message.serverContent?.turnComplete) {
      heardState.noteTurnComplete();
      settleIfDrained();
      latestCustomerTranscript = "";
      customerTurnId = null;
    }
  };

  // Identity for the closure above. Assigned immediately after connect resolves.
  let thisSession = null;
  activeSession = await ai.live.connect({
    model: credential.model,
    config: liveConfig(customer, {
      voiceStyle: activeVoiceStyle,
      voice: activeVoice,
      affectiveDialog: activeAffectiveDialog,
      noiseMode: activeNoiseMode,
    }),
    callbacks: {
      onopen: () => {
        recorder.event("socket_opened", { durationMs: performance.now() - connectStartedAt });
        onStatus("Connected · enabling the microphone…");
      },
      onmessage: handleMessage,
      onerror: (event) => {
        recorder.event("error", { detail: { area: "voice-connection", message: event.message || "unknown" } });
        onStatus(`Voice connection error: ${event.message || "please reconnect"}`);
      },
      onclose: () => {
        if (!disconnectRequested) {
          recorder.event("error", { detail: { area: "provider-close", message: "Gemini closed the session." } });
          void recorder.end({ reason: "provider-closed" });
        }
        onStatus("Voice session closed");
      },
    },
  });

  thisSession = activeSession;

  try {
    await startMicrophone(onStatus);
    recorder.event("microphone_ready", { detail: {
      requested: MICROPHONE_CONSTRAINTS,
      ...captureSettingsReport(microphoneStream?.getAudioTracks?.()[0]?.getSettings?.() || {}),
    } });
  } catch (error) {
    disconnectVoiceAgent();
    throw new Error(`The microphone could not start: ${error.message}`);
  }
  onStatus("Live · interruption-safe, account facts and the billing-review workflow are available");
  return activeSession;
}

export function disconnectVoiceAgent() {
  disconnectRequested = true;

  // Publish the playback quality numbers before the recorder is torn down, so
  // the tick is a figure in the report rather than a matter of opinion.
  const gaps = gapMeter.report();
  if (gaps.chunksScheduled > 0) {
    recorder.event("v5_playback_summary", {
      detail: {
        mode: activePlaybackMode,
        actualSampleRate: outputContextInfo?.actualSampleRate ?? null,
        perChunkResampling: outputContextInfo?.perChunkResampling ?? null,
        fallbackReason: outputContextInfo?.fallbackReason ?? null,
        ...gaps,
      },
    });
  }

  // Stop the sidecar first, so it cannot receive a stray chunk during teardown
  // or hold a socket open after the call has ended.
  if (transcriptHelper) {
    try { transcriptHelper.stop?.({ reason: "call_ended" }); } catch { /* already gone */ }
    transcriptHelper = null;
  }
  helperPushFailures = 0;
  if (activeSession) {
    try { activeSession.sendRealtimeInput({ audioStreamEnd: true }); } catch {}
    try { activeSession.close(); } catch {}
  }
  activeSession = null;

  playbackEpoch += 1;
  clearPlayback();
  void recorder.end({ reason: "caller-ended-call" });

  if (inputProcessor) inputProcessor.onaudioprocess = null;
  try { inputSource?.disconnect(); } catch {}
  try { inputProcessor?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  for (const track of microphoneStream?.getTracks?.() || []) track.stop();
  void inputContext?.close?.();
  void outputContext?.close?.();

  microphoneStream = null;
  inputContext = null;
  inputSource = null;
  inputProcessor = null;
  silentGain = null;
  outputContext = null;
  nextPlaybackTime = 0;
  epochPlaybackStartTime = null;
  queuedChunks = 0;
  playbackQueue = Promise.resolve();
  energyProbe = null;

  heardState.reset();
  recorder = noopRecorder();
  conversationId = null;
  customerTurnId = null;
  latestCustomerTranscript = "";
  latestPreparedIntentId = null;
  awaitingConfirmationPrompt = false;
  confirmationPromptEpochId = null;
  responseLatencyAnchor = null;
  completedToolCalls.clear();
  cancelledToolCalls.clear();
  activeVoiceStyle = DEFAULT_VOICE_STYLE;
  activePlaybackMode = DEFAULT_PLAYBACK_MODE;
  activeVoice = DEFAULT_VOICE;
  activeAffectiveDialog = false;
  outputContextInfo = null;
  gapMeter = createGapMeter();
}

/** Live state for the on-screen HCR panel. */
export function heardStateSnapshot() {
  return heardState.snapshot();
}
