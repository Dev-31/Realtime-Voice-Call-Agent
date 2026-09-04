#!/usr/bin/env node
/**
 * Opt-in evaluation harness for the dedicated transcription lanes.
 *
 * PLAIN-ENGLISH VERSION
 * ---------------------
 * The owner records a handful of short clips of themselves saying the sentences
 * listed in docs/V5_TRANSCRIPT_CORPUS.md. This script replays each clip to the
 * dedicated speech recogniser twice -- once in VERBATIM mode, once in SMART
 * mode -- and writes down what came back and how long it took. A human then
 * scores the results by reading them, in docs/V5_EVAL_TEMPLATE.csv.
 *
 * The script does not score anything. There is no accuracy number in its
 * output, because nothing here can tell whether a transcript is right.
 *
 * IT DOES NOTHING BY DEFAULT
 * --------------------------
 * Run with no flags and it contacts nothing at all: it decodes the clips
 * locally and prints the exact request it WOULD send. A real provider call
 * needs three separate things true at once --
 *
 *   1. `--live` on the command line,
 *   2. TRANSCRIPT_LAB_LIVE_CALLS=true in the environment,
 *   3. a GEMINI_API_KEY in the environment.
 *
 * Any one of them alone is not consent. Recorded audio of a real person is not
 * ours to spend on a provider call because a script happened to run.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 *   - It will not read or write outside this V5 project. V1-V4 are frozen, and
 *     `isInsideV5` from server/db-path-guard.js is the same guard the database
 *     uses.
 *   - It will not fall back to another model, mode or provider when the
 *     configured one is unavailable. It stops and says which one it wanted.
 *   - It will not omit a clip that failed. A timeout or an error is written to
 *     the report as `timed_out` / `unavailable` and stays in the denominator,
 *     because a comparison that quietly drops its own failures flatters itself.
 *   - It will not put audio bytes, an API key or a credential value in the
 *     report or in any printed line.
 *
 * WHY IT REPLAYS AT WALL CLOCK
 * ----------------------------
 * The recogniser endpoints its own segments from the timing of the audio it
 * receives. Firing every chunk as fast as the socket accepts them would change
 * where segment boundaries fall, so the latency and the segmentation measured
 * here would not be the latency and segmentation a caller would get. Clips are
 * also run strictly one after another: two concurrent sessions would share one
 * quota and one uplink, and then a slow lane would look like a slow model.
 */

import { readFile, readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GoogleGenAI } from "@google/genai";

import { V5_PROJECT_ROOT, isInsideV5 } from "../server/db-path-guard.js";
import { effectiveFeatures, featureSummary } from "../server/config/features.js";
import {
  TRANSCRIPTION_LIMITS,
  isModeAllowed,
  resolveTranscriptionRequest,
  transcriptionConfigStatus,
} from "../server/transcription/config.js";
import { createTranscriptionToken } from "../server/transcription/token.js";
import {
  CLIP_LIMITS,
  FRAMES_PER_CHUNK,
  TARGET_MIME_TYPE,
  chunkPcm16,
  normalizeClip,
  validateClipFile,
  validateDecodedClip,
} from "../src/transcription/audio-normalize.js";
import { createTranscriber } from "../src/transcription/gemini-transcriber.js";
import { ALIGNMENT_QUALITY, createTranscriptStore } from "../src/transcription/transcript-store.js";

const scriptRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

const DEFAULT_CLIP_DIR = join(scriptRoot, "data", "clips");
const DEFAULT_OUT_FILE = join(scriptRoot, "docs", "V5_EVAL_RESULTS.json");

/**
 * The frozen corpus is 24 clips. Nothing above that is a corpus we agreed on,
 * so the ceiling is a typo guard rather than a policy.
 */
const MAX_CLIPS_CEILING = 24;

/** VERBATIM is the "original machine transcript" lane; SMART is the readable one. */
const MODE_TO_LANE = Object.freeze({
  VERBATIM: "dedicated-verbatim",
  SMART: "dedicated-smart",
});

/**
 * A synthetic session, only so the real server-side authorisation path runs.
 *
 * `createTranscriptionToken` counts issuance per session, and this whole run
 * shares one key on purpose: the per-hour credential brake should apply to the
 * harness exactly as it applies to a browser.
 */
const EVAL_SESSION = Object.freeze({
  role: "customer",
  token_hash: "eval-cli",
  principal_id: "eval-cli",
});

const USAGE = `
transcript:eval - replay consented recorded clips through the dedicated
                  transcription lanes and write a local evaluation report.

  npm run transcript:eval                      dry run: plan only, contacts nothing
  npm run transcript:eval -- --help            this text
  npm run transcript:eval -- --dir data/clips  where the .wav clips are
  npm run transcript:eval -- --live            make real provider calls (see below)

Options
  --dir <path>        Directory of clips. Default data/clips.
                      Refused if it resolves outside this V5 project.
  --live              Make real provider calls. ALSO requires
                      TRANSCRIPT_LAB_LIVE_CALLS=true and GEMINI_API_KEY in the
                      environment. Two independent opt-ins, neither implied by
                      the other.
  --vocabulary        Attach the server's product vocabulary to both lanes.
                      Off by default: it is a second variable, so leaving it off
                      keeps a VERBATIM-versus-SMART result readable. Run the same
                      clips twice, with and without, for a vocabulary A/B.
  --max-clips <n>     Clips to process, 1-${MAX_CLIPS_CEILING}. Default ${CLIP_LIMITS.maxClipsPerBatch}.
  --modes <list>      Comma separated: verbatim,smart. Default verbatim,smart.
  --out <file>        Report path. Default docs/V5_EVAL_RESULTS.json.
                      Refused if it resolves outside this V5 project.
  --help, -h          Print this and exit 0.

Audio format
  Uncompressed 16-bit PCM WAV only: RIFF/WAVE, format tag 1 (or
  WAVE_FORMAT_EXTENSIBLE with the PCM subformat), 16 bits per sample, 1 or 2
  channels, any sample rate. Anything else is refused by name -- this script
  adds no decoder dependency and never guesses at an encoding.

What it never does
  No provider contact without all three opt-ins. No model or provider fallback.
  No audio bytes, API key or credential value in the report or in any log line.
  No accuracy, confidence or "meaning preserved" number: a human scores those
  in docs/V5_EVAL_TEMPLATE.csv.

Exit code
  0 when every clip was usable and every attempted lane run completed.
  1 when anything needs the owner's attention: no clips found, a clip skipped,
    a lane that timed out or was unavailable, or a refused configuration.
`;

// ---------------------------------------------------------------------------
// Redaction and safe printing
// ---------------------------------------------------------------------------

/**
 * Strip anything credential-shaped out of a string before it is printed or
 * stored.
 *
 * This is text formatting, not a decision about meaning. It exists because a
 * transport error message can carry a request URL, and a request URL to the
 * auth-token route can carry a token name.
 */
function redact(text) {
  let out = String(text ?? "");
  const key = process.env.GEMINI_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join("[redacted-credential]");
  return out.replace(/auth_tokens\/[A-Za-z0-9_.\-]+/g, "auth_tokens/[redacted]");
}

/**
 * Transcript text is untrusted content, including on a terminal.
 *
 * Control characters can reposition a cursor and rewrite lines that were
 * already printed, so a transcript could otherwise overwrite the honest label
 * printed above it. Flatten them and truncate.
 */
function safeConsoleText(text, limit = 160) {
  const source = redact(text);
  let flattened = "";
  for (const character of source) {
    const code = character.codePointAt(0);
    flattened += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  flattened = flattened.split(/\s+/).filter(Boolean).join(" ");
  if (!flattened) return "(empty)";
  return flattened.length > limit ? `${flattened.slice(0, limit)}...` : flattened;
}

function say(line = "") {
  console.log(line);
}

function fail(message, { code = 1 } = {}) {
  console.error(`\n${redact(message)}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    help: false,
    live: false,
    dir: DEFAULT_CLIP_DIR,
    out: DEFAULT_OUT_FILE,
    maxClips: CLIP_LIMITS.maxClipsPerBatch,
    modes: ["VERBATIM", "SMART"],
    /**
     * The product vocabulary biases recognition towards our plan names. That is
     * a SECOND variable, so it defaults to off: with it always on, a
     * VERBATIM-versus-SMART result could not be separated from a
     * vocabulary-versus-no-vocabulary result. Turn it on deliberately, for a
     * vocabulary A/B against the same clip hashes.
     */
    useProductVocabulary: false,
  };

  const needsValue = (flag, value) => {
    if (value === undefined) throw new Error(`${flag} needs a value. Run --help for the list of options.`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--live") {
      options.live = true;
    } else if (flag === "--vocabulary") {
      options.useProductVocabulary = true;
    } else if (flag === "--no-vocabulary") {
      options.useProductVocabulary = false;
    } else if (flag === "--dir") {
      options.dir = needsValue(flag, argv[(index += 1)]);
    } else if (flag === "--out") {
      options.out = needsValue(flag, argv[(index += 1)]);
    } else if (flag === "--max-clips") {
      const raw = needsValue(flag, argv[(index += 1)]);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CLIPS_CEILING) {
        throw new Error(`--max-clips must be a whole number from 1 to ${MAX_CLIPS_CEILING}. Got ${raw}.`);
      }
      options.maxClips = parsed;
    } else if (flag === "--modes") {
      const raw = needsValue(flag, argv[(index += 1)]);
      const wanted = String(raw)
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean);
      if (!wanted.length) throw new Error("--modes needs at least one of verbatim,smart.");
      for (const mode of wanted) {
        if (!isModeAllowed(mode) || !MODE_TO_LANE[mode]) {
          throw new Error(`--modes accepts verbatim and smart only. Got ${mode.toLowerCase()}.`);
        }
      }
      // Deduplicate rather than run the same lane twice under one clip hash.
      options.modes = [...new Set(wanted)];
    } else {
      throw new Error(`Unknown option ${flag}. Run --help for the list of options.`);
    }
  }

  return options;
}

/** Resolve a path relative to the project, then refuse anything outside it. */
function insideProjectOrRefuse(candidate, label) {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(join(scriptRoot, candidate));
  if (!isInsideV5(target)) {
    throw new Error(
      `Refusing to use a ${label} outside this V5 project.\n` +
        `  requested: ${target}\n` +
        `  V5 root:   ${V5_PROJECT_ROOT}\n` +
        "V1-V4 are frozen, and this harness reads clips and writes a report. " +
        "Copy the clips into this project first.",
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Strict 16-bit PCM WAV reader
// ---------------------------------------------------------------------------

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * The 14 bytes every KSDATAFORMAT_SUBTYPE_* GUID shares after its format tag.
 *
 * Checking them means a WAVE_FORMAT_EXTENSIBLE header is accepted because its
 * subformat really is PCM, not because its first two bytes happened to read
 * as 1.
 */
const SUBFORMAT_GUID_TAIL = Object.freeze([
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

const WAV_FORMAT_REQUIREMENT =
  "Required format: uncompressed 16-bit PCM WAV -- RIFF/WAVE container, format tag 1 " +
  "(or WAVE_FORMAT_EXTENSIBLE with the PCM subformat), 16 bits per sample, 1 or 2 " +
  "channels, any sample rate. Re-export the clip in that format; this harness adds no " +
  "decoder dependency and does not guess at another encoding.";

function ascii(bytes, at, length) {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[at + index]);
  return out;
}

function readFormatChunk(view, at, size) {
  if (size < 16) throw new Error(`The fmt chunk is ${size} bytes; a PCM fmt chunk is at least 16. ${WAV_FORMAT_REQUIREMENT}`);
  const formatTag = view.getUint16(at, true);
  const channels = view.getUint16(at + 2, true);
  const sampleRate = view.getUint32(at + 4, true);
  const bitsPerSample = view.getUint16(at + 14, true);

  let effectiveTag = formatTag;
  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (size < 40) {
      throw new Error(`This file declares WAVE_FORMAT_EXTENSIBLE but its fmt chunk is only ${size} bytes, so the subformat cannot be read. ${WAV_FORMAT_REQUIREMENT}`);
    }
    if (view.getUint16(at + 16, true) < 22) {
      throw new Error(`This file declares WAVE_FORMAT_EXTENSIBLE with a short extension block. ${WAV_FORMAT_REQUIREMENT}`);
    }
    effectiveTag = view.getUint16(at + 24, true);
    for (let index = 0; index < SUBFORMAT_GUID_TAIL.length; index += 1) {
      if (view.getUint8(at + 26 + index) !== SUBFORMAT_GUID_TAIL[index]) {
        throw new Error(`This file's WAVE_FORMAT_EXTENSIBLE subformat GUID is not a recognised WAVE subformat. ${WAV_FORMAT_REQUIREMENT}`);
      }
    }
  }

  if (effectiveTag !== WAVE_FORMAT_PCM) {
    throw new Error(`This file is WAV format tag ${formatTag}${effectiveTag === formatTag ? "" : ` (subformat ${effectiveTag})`}, which is not uncompressed PCM. ${WAV_FORMAT_REQUIREMENT}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`This file is ${bitsPerSample}-bit. ${WAV_FORMAT_REQUIREMENT}`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`This file has ${channels} channels. ${WAV_FORMAT_REQUIREMENT}`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 192000) {
    throw new Error(`This file declares a sample rate of ${sampleRate} Hz, which is not usable. ${WAV_FORMAT_REQUIREMENT}`);
  }

  return { formatTag, effectiveTag, channels, sampleRate, bitsPerSample };
}

/**
 * Decode a PCM WAV file into per-channel float samples.
 *
 * Int16 is converted back with the same asymmetric scale `floatToPcm16` uses in
 * the other direction, so a clip that is already 16 kHz mono round-trips to
 * byte-identical PCM. That matters because the clip hash is the identity the
 * two lanes are aligned on.
 */
function decodeWavPcm16(bytes) {
  if (bytes.byteLength < 44) {
    throw new Error(`The file is ${bytes.byteLength} bytes, too small to hold a WAV header. ${WAV_FORMAT_REQUIREMENT}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error(`The file does not begin with a RIFF/WAVE header. ${WAV_FORMAT_REQUIREMENT}`);
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) {
      throw new Error(`The ${id.trim() || "unnamed"} chunk declares ${size} bytes but the file ends first, so this clip is truncated. Re-record or re-export it.`);
    }
    if (id === "fmt ") format = readFormatChunk(view, body, size);
    else if (id === "data") data = { start: body, size };
    // RIFF pads every odd-length chunk to an even boundary.
    offset = body + size + (size % 2);
  }

  if (!format) throw new Error(`The file has no fmt chunk. ${WAV_FORMAT_REQUIREMENT}`);
  if (!data) throw new Error(`The file has no data chunk. ${WAV_FORMAT_REQUIREMENT}`);

  const frameBytes = format.channels * 2;
  const frames = Math.floor(data.size / frameBytes);
  if (frames === 0) throw new Error("The data chunk holds no complete audio frames.");

  const channelData = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    const frameStart = data.start + frame * frameBytes;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const sample = view.getInt16(frameStart + channel * 2, true);
      channelData[channel][frame] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
    }
  }

  return {
    channelData,
    sampleRate: format.sampleRate,
    channels: format.channels,
    frames,
    durationSeconds: frames / format.sampleRate,
  };
}

// ---------------------------------------------------------------------------
// Clip discovery and preparation
// ---------------------------------------------------------------------------

async function listClipFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true, files: [] };
    throw new Error(`Could not read ${directory}: ${error?.code || "unknown error"}`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".wav")
    .map((entry) => entry.name)
    // Lexicographic order, so `clip-01-...` runs first and the run order in the
    // report is reproducible across machines.
    .sort((a, b) => a.localeCompare(b, "en"));
  return { missing: false, files };
}

/**
 * Decode, validate and normalise one clip. Never contacts anything.
 *
 * A clip that fails either gate comes back as `{ skipped: true, reasons }` and
 * is carried through to the report, because "we did not measure this one" is a
 * result and an absent row is not.
 */
async function prepareClip({ directory, fileName, order }) {
  const path = join(directory, fileName);
  const id = basename(fileName, extname(fileName));
  const base = { id, file: fileName, path, order };

  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    return { ...base, skipped: true, reasons: [`Could not read the file: ${error?.code || "unknown error"}`] };
  }

  const fileGate = validateClipFile({ name: fileName, size: stats.size, type: "" });
  if (!fileGate.ok) {
    return { ...base, bytes: stats.size, skipped: true, reasons: fileGate.problems };
  }

  let decoded;
  try {
    const bytes = new Uint8Array(await readFile(path));
    decoded = decodeWavPcm16(bytes);
  } catch (error) {
    return { ...base, bytes: stats.size, skipped: true, reasons: [redact(error?.message || "The file could not be decoded.")] };
  }

  const decodedGate = validateDecodedClip({
    durationSeconds: decoded.durationSeconds,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
  });
  if (!decodedGate.ok) {
    return {
      ...base,
      bytes: stats.size,
      sourceSampleRate: decoded.sampleRate,
      sourceChannels: decoded.channels,
      sourceDurationSeconds: Number(decoded.durationSeconds.toFixed(3)),
      skipped: true,
      reasons: decodedGate.problems,
    };
  }

  // The same one-shot normalisation the browser lab uses, so the eval path and
  // the lab path cannot differ by their own arithmetic.
  const normalized = await normalizeClip(decoded.channelData, decoded.sampleRate);
  const chunks = chunkPcm16(normalized.bytes, FRAMES_PER_CHUNK);

  return {
    ...base,
    skipped: false,
    reasons: [],
    bytes: stats.size,
    sourceSampleRate: decoded.sampleRate,
    sourceChannels: decoded.channels,
    sourceDurationSeconds: Number(decoded.durationSeconds.toFixed(3)),
    hash: normalized.hash,
    durationSeconds: Number(normalized.durationSeconds.toFixed(3)),
    normalizedBytes: normalized.byteLength,
    mimeType: normalized.mimeType,
    chunkCount: chunks.length,
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Live lane run
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

/**
 * Ask the real server-side issuer for a constrained credential.
 *
 * `createTranscriptionToken` pins the credential to one model and one config,
 * and returns the model and mode it pinned -- but not the config object itself.
 * Recomputing it from the same server-side resolver, with the same request
 * body, is the only way to be certain the connection uses the configuration the
 * credential was constrained to rather than something reconstructed by hand.
 */
function credentialRequester({ model, mode, languageCodes, useProductVocabulary }) {
  const body = { model, mode, languageCodes, useProductVocabulary, lane: "lab" };
  return async () => {
    const resolved = resolveTranscriptionRequest(body);
    if (!resolved.ok) {
      const error = new Error(resolved.error);
      error.code = "invalid_transcription_request";
      throw error;
    }
    const credential = await createTranscriptionToken({
      session: EVAL_SESSION,
      body,
      features: effectiveFeatures(),
      now: Date.now(),
    });
    return { ...credential, liveConfig: resolved.liveConfig };
  };
}

async function openProviderSession({ model, config, token, callbacks }) {
  const ai = new GoogleGenAI({ apiKey: token.value, httpOptions: { apiVersion: "v1beta" } });
  return ai.live.connect({ model, config, callbacks });
}

/**
 * One clip, one mode, one fresh session.
 *
 * Every terminal path returns a lane record. There is no path that returns
 * nothing, because a lane with no record would silently leave the denominator.
 */
async function runLane({ clip, mode, model, languageCodes, useProductVocabulary, laneRunIndex }) {
  const laneId = MODE_TO_LANE[mode];
  const clock = () => performance.now();
  const store = createTranscriptStore({ now: clock });
  store.declareAlignment(ALIGNMENT_QUALITY.exact, {
    key: clip.hash,
    note: "Every lane replayed the byte-identical normalised PCM identified by this hash.",
  });

  const statusTrail = [];
  const transcriber = createTranscriber({
    laneId,
    store,
    now: clock,
    requestToken: credentialRequester({ model, mode, languageCodes, useProductVocabulary }),
    connect: openProviderSession,
    onStatus: ({ state, detail }) => {
      statusTrail.push({ state, detail: detail == null ? null : redact(detail) });
    },
    limits: {
      connectTimeoutMs: TRANSCRIPTION_LIMITS.connectTimeoutMs,
      finalGraceMs: TRANSCRIPTION_LIMITS.finalGraceMs,
      maxQueuedChunks: TRANSCRIPTION_LIMITS.maxQueuedChunks,
      maxSessionSeconds: TRANSCRIPTION_LIMITS.maxHelperSessionSeconds,
      maxAudioSeconds: TRANSCRIPTION_LIMITS.maxHelperAudioSeconds,
    },
  });

  const startedAt = new Date().toISOString();
  const started = await transcriber.start();

  let replay = { chunksPushed: 0, pushRefusedAt: null, pushRefusedReason: null };
  let ended = null;

  if (started.ok) {
    for (let index = 0; index < clip.chunks.length; index += 1) {
      const chunk = clip.chunks[index];
      const push = transcriber.pushAudio(chunk);
      if (!push.accepted) {
        replay.pushRefusedAt = index;
        replay.pushRefusedReason = push.reason;
        break;
      }
      replay.chunksPushed += 1;
      // Pace on the chunk's own duration so the recogniser sees real timing.
      await sleep((chunk.byteLength / 2 / 16000) * 1000);
    }
    ended = await transcriber.endAudio({ graceMs: TRANSCRIPTION_LIMITS.finalGraceMs });
  }

  const view = store.laneView(laneId) || { finalizedText: "", generations: [], failures: [], status: { state: "unavailable", detail: "no_lane_view" } };
  const laneReport = transcriber.report();
  const finalizedText = String(view.finalizedText || "");

  const errors = [
    ...(started.ok ? [] : [{ area: "start", message: redact(started.message || started.reason || "start refused") }]),
    ...(replay.pushRefusedReason ? [{ area: "replay", message: `audio replay stopped at chunk ${replay.pushRefusedAt}: ${replay.pushRefusedReason}` }] : []),
    ...laneReport.errors.map((entry) => ({ area: entry.area, message: redact(entry.message) })),
  ];

  let state;
  if (!started.ok) state = "unavailable";
  else if (ended?.timedOut) state = "timed_out";
  else if (ended?.ok && finalizedText) state = "completed";
  else if (ended?.ok) {
    // A finalised lane with no text is not a success with an empty answer. We
    // asked the provider to transcribe known speech and got nothing back.
    state = "unavailable";
    errors.push({ area: "result", message: "The lane finalised with no text. Recorded as unavailable, not as an empty transcript." });
  } else state = "unavailable";

  const segments = view.generations
    .flatMap((generation) => generation.segments.map((segment) => ({ ...segment, generationIndex: generation.index })))
    .map((segment) => ({
      segmentId: segment.id,
      generation: segment.generationIndex,
      sequence: segment.sequence,
      state: segment.state,
      // Finalised text only. A provisional hypothesis is not a transcript and
      // must never be scored as one.
      text: segment.state === "finalized" ? segment.text : "",
      interimRevisions: segment.revisions,
      lateArrival: segment.lateArrival,
      note: segment.note == null ? null : redact(segment.note),
    }));

  return {
    laneRunIndex,
    laneId,
    mode,
    model,
    state,
    startedAt,
    finishedAt: new Date().toISOString(),
    finalizedText,
    segments,
    laneStatus: { state: view.status.state, detail: view.status.detail == null ? null : redact(view.status.detail) },
    statusTrail,
    endToFinalMs: laneReport.endToFinalMs == null ? null : Math.round(laneReport.endToFinalMs),
    endToFinalPrecision: laneReport.endToFinalPrecision,
    credentialMs: laneReport.credentialMs == null ? null : Math.round(laneReport.credentialMs),
    setupMs: laneReport.setupMs == null ? null : Math.round(laneReport.setupMs),
    firstInterimAfterStartMs: laneReport.firstInterimAfterStartMs == null ? null : Math.round(laneReport.firstInterimAfterStartMs),
    chunksPlanned: clip.chunkCount,
    chunksSent: laneReport.chunksSent,
    audioSecondsSent: Number(laneReport.audioSecondsSent.toFixed(3)),
    queueHighWaterMark: laneReport.queueHighWaterMark,
    reconnects: laneReport.reconnects,
    disconnects: laneReport.disconnects,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile, reported with its sample count.
 *
 * Below three samples the number is still printed -- hiding it would be its own
 * kind of dishonesty -- but it carries `lowConfidence` and a note, so it cannot
 * be quoted as a p95 without the caveat travelling with it.
 */
function percentiles(values) {
  const samples = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const at = (fraction) =>
    samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)] : null;
  const lowConfidence = samples.length > 0 && samples.length < 3;
  return {
    samples: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    lowConfidence,
    note: samples.length === 0
      ? "No completed lane produced a measurable end-to-final time. Nothing to report."
      : lowConfidence
        ? `Computed from ${samples.length} sample${samples.length === 1 ? "" : "s"}. That is fewer than 3, so this is an observation and not a percentile.`
        : `Computed from ${samples.length} samples, nearest-rank.`,
  };
}

// ---------------------------------------------------------------------------
// SDK version
// ---------------------------------------------------------------------------

async function sdkVersion() {
  const declaredRange = await readFile(join(scriptRoot, "package.json"), "utf8")
    .then((text) => JSON.parse(text)?.dependencies?.["@google/genai"] ?? null)
    .catch(() => null);
  const installed = await readFile(join(scriptRoot, "node_modules", "@google", "genai", "package.json"), "utf8")
    .then((text) => JSON.parse(text)?.version ?? null)
    .catch(() => null);
  return { package: "@google/genai", installed, declaredRange, node: process.version };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const RULE = "-".repeat(84);

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }

  if (options.help) {
    say(USAGE.trimEnd());
    process.exit(0);
  }

  let clipDirectory;
  let outFile;
  try {
    clipDirectory = insideProjectOrRefuse(options.dir, "clip directory");
    outFile = insideProjectOrRefuse(options.out, "report path");
  } catch (error) {
    fail(error.message);
    return;
  }

  const transcription = transcriptionConfigStatus();
  const features = effectiveFeatures();
  const versions = await sdkVersion();

  // No automatic fallback. If the configured model is not one this server will
  // ever issue a credential for, the run stops here.
  if (!transcription.modelAllowed) {
    fail(
      `The configured transcription model ${transcription.model} is not in this server's allowlist ` +
        `(${transcription.allowedModels.join(", ")}).\n` +
        "This harness does not substitute another model or provider. Fix TRANSCRIPT_MODEL and run again.",
    );
    return;
  }

  const envLiveCalls = features.transcriptLab.realProviderCallsRequested;
  const keyPresent = features.credentials.geminiApiKeyPresent;
  const liveRequested = options.live;
  const liveAllowed = liveRequested && envLiveCalls && keyPresent;

  const mode = liveAllowed ? "live" : "dry-run";
  const startedAt = new Date().toISOString();

  say("");
  say("V5 transcription evaluation harness");
  say(RULE);
  say(`Mode              ${mode === "live" ? "LIVE - real provider calls will be made" : "DRY RUN - nothing is sent to the provider"}`);
  say(`Clip directory    ${clipDirectory}`);
  say(`Report path       ${outFile}`);
  say(`Model             ${transcription.model} (allowlisted)`);
  say(`Modes             ${options.modes.join(", ")}`);
  say(`Max clips         ${options.maxClips}`);
  say(`Product vocab     ${options.useProductVocabulary ? "on (recognition bias, a second variable)" : "off"}`);
  say(`Audio contract    ${TARGET_MIME_TYPE}, mono, ${FRAMES_PER_CHUNK} frames per chunk`);
  say(`SDK               @google/genai ${versions.installed ?? "not installed"} on Node ${versions.node}`);
  say(RULE);
  say("Opt-in state");
  say(`  --live flag                    ${liveRequested ? "given" : "not given"}`);
  say(`  TRANSCRIPT_LAB_LIVE_CALLS      ${envLiveCalls ? "true" : "false"}`);
  say(`  GEMINI_API_KEY                 ${keyPresent ? "present (value never printed or stored)" : "absent"}`);
  if (liveRequested && !liveAllowed) {
    say("");
    say("  --live was requested but refused. Both environment opt-ins must also be set:");
    if (!envLiveCalls) say("    TRANSCRIPT_LAB_LIVE_CALLS=true is not set.");
    if (!keyPresent) say("    GEMINI_API_KEY is not set.");
    say("  Continuing as a dry run. Nothing will be sent.");
  }
  if (features.configurationErrors.length) {
    say("");
    say("Configuration warnings");
    for (const problem of features.configurationErrors) say(`  ${redact(problem)}`);
  }
  say(RULE);

  const listing = await listClipFiles(clipDirectory);
  if (listing.missing) {
    say("");
    say(`The clip directory does not exist yet: ${clipDirectory}`);
    say("Record the 24 clips described in docs/V5_TRANSCRIPT_CORPUS.md, save them there as");
    say("16-bit PCM WAV, and run this again. Nothing has been sent and no report was written.");
    say("");
    process.exit(1);
  }

  const selected = listing.files.slice(0, options.maxClips);
  const notSelected = listing.files.length - selected.length;

  if (!selected.length) {
    say("");
    say(`No .wav clips found in ${clipDirectory}`);
    say("Record the 24 clips described in docs/V5_TRANSCRIPT_CORPUS.md and save them there.");
    say(`File naming, from the manifest: clip-01-ordinary-plan-price.wav`);
    say(`${WAV_FORMAT_REQUIREMENT}`);
    say("Nothing has been sent and no report was written.");
    say("");
    process.exit(1);
  }

  say("");
  say(`Found ${listing.files.length} .wav file${listing.files.length === 1 ? "" : "s"}; processing ${selected.length} in this order:`);
  if (notSelected > 0) {
    say(`  ${notSelected} file${notSelected === 1 ? "" : "s"} beyond --max-clips ${options.maxClips} ${notSelected === 1 ? "was" : "were"} left out of this run.`);
  }

  const clips = [];
  for (let index = 0; index < selected.length; index += 1) {
    const clip = await prepareClip({ directory: clipDirectory, fileName: selected[index], order: index + 1 });
    clips.push(clip);
    say("");
    say(`  ${String(clip.order).padStart(2, "0")}. ${clip.file}`);
    if (clip.skipped) {
      say(`      SKIPPED - stays in the denominator as a skipped clip`);
      for (const reason of clip.reasons) say(`      reason: ${reason}`);
      continue;
    }
    say(`      source        ${clip.sourceSampleRate} Hz, ${clip.sourceChannels} channel${clip.sourceChannels === 1 ? "" : "s"}, ${clip.sourceDurationSeconds} s, ${clip.bytes} bytes on disk`);
    say(`      normalised    ${clip.durationSeconds} s, ${clip.normalizedBytes} bytes, ${clip.chunkCount} chunks of ${FRAMES_PER_CHUNK} frames`);
    say(`      clip hash     ${clip.hash}`);
    say(`      would send    model ${transcription.model}, mimeType ${clip.mimeType}`);
    for (const laneMode of options.modes) {
      const resolved = resolveTranscriptionRequest({
        model: transcription.model,
        mode: laneMode,
        languageCodes: [],
        useProductVocabulary: options.useProductVocabulary,
        lane: "lab",
      });
      say(`      lane ${MODE_TO_LANE[laneMode].padEnd(19)} config ${JSON.stringify(resolved.liveConfig)}`);
    }
  }

  const usable = clips.filter((clip) => !clip.skipped);
  const skippedClips = clips.length - usable.length;
  const laneRunsPlanned = usable.length * options.modes.length;

  say("");
  say(RULE);
  say(`Planned lane runs  ${laneRunsPlanned} (${usable.length} usable clip${usable.length === 1 ? "" : "s"} x ${options.modes.length} mode${options.modes.length === 1 ? "" : "s"}), run strictly one at a time`);
  if (laneRunsPlanned > TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour) {
    say("");
    say(`  Credential ceiling: the server issues at most ${TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour} transcription credentials per session per hour,`);
    say(`  and each lane run needs a fresh one. Lane runs past number ${TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour} will be refused and recorded as`);
    say("  unavailable / token_rate_limited. They stay in the denominator. Split the corpus across");
    say("  separate hours with --max-clips rather than raising the brake.");
  }
  say(RULE);

  const laneRuns = [];
  if (mode === "live") {
    say("");
    say("Replaying clips. Each clip is paced at wall clock and each lane gets a fresh session.");
    let laneRunIndex = 0;
    for (const clip of usable) {
      for (const laneMode of options.modes) {
        laneRunIndex += 1;
        say("");
        say(`  run ${String(laneRunIndex).padStart(2, "0")}  ${clip.id}  ${laneMode}`);
        const run = await runLane({
          clip,
          mode: laneMode,
          model: transcription.model,
          languageCodes: [],
          useProductVocabulary: options.useProductVocabulary,
          laneRunIndex,
        });
        laneRuns.push({ clipId: clip.id, clipHash: clip.hash, ...run });
        say(`        state         ${run.state}`);
        say(`        endToFinalMs  ${run.endToFinalMs == null ? "not measured" : run.endToFinalMs}`);
        say(`        segments      ${run.segments.length}`);
        say(`        text          ${safeConsoleText(run.finalizedText)}`);
        for (const error of run.errors) say(`        error         ${error.area}: ${safeConsoleText(error.message)}`);
      }
    }
  } else {
    for (const clip of usable) {
      for (const laneMode of options.modes) {
        laneRuns.push({
          clipId: clip.id,
          clipHash: clip.hash,
          laneRunIndex: null,
          laneId: MODE_TO_LANE[laneMode],
          mode: laneMode,
          model: transcription.model,
          state: "planned",
          finalizedText: null,
          segments: [],
          endToFinalMs: null,
          errors: [],
          note: "Dry run. Nothing was sent, so there is no result - not an empty one.",
        });
      }
    }
  }

  const attempted = mode === "live" ? laneRuns.length : 0;
  const counts = {
    attempted,
    completed: laneRuns.filter((run) => run.state === "completed").length,
    timedOut: laneRuns.filter((run) => run.state === "timed_out").length,
    unavailable: laneRuns.filter((run) => run.state === "unavailable").length,
    skipped: skippedClips,
    planned: laneRunsPlanned,
    clipsFound: listing.files.length,
    clipsSelected: clips.length,
    clipsUsable: usable.length,
    clipsSkipped: skippedClips,
    laneRunsNotAttempted: mode === "live" ? 0 : laneRunsPlanned,
  };

  const completedRuns = laneRuns.filter((run) => run.state === "completed");
  const latency = {
    all: percentiles(completedRuns.map((run) => run.endToFinalMs)),
    byMode: Object.fromEntries(
      options.modes.map((laneMode) => [
        laneMode,
        percentiles(completedRuns.filter((run) => run.mode === laneMode).map((run) => run.endToFinalMs)),
      ]),
    ),
    definition:
      "Wall clock from the last audio sample this harness sent to the arrival of the last finalised segment. " +
      "Only completed lane runs contribute. Timed-out and unavailable runs are counted separately and are not " +
      "silently excluded from the pass rate.",
  };

  const report = {
    schema: "v5-transcription-eval/1",
    runAt: startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    optIns: {
      liveFlagGiven: liveRequested,
      environmentLiveCallsEnabled: envLiveCalls,
      credentialPresent: keyPresent,
      liveAllowed,
      note: "All three must be true for a provider call. No credential value is recorded anywhere in this file.",
    },
    effectiveConfiguration: {
      clipDirectory,
      reportPath: outFile,
      maxClips: options.maxClips,
      modes: options.modes,
      lanes: options.modes.map((laneMode) => MODE_TO_LANE[laneMode]),
      model: transcription.model,
      allowedModels: transcription.allowedModels,
      languageCodes: [],
      useProductVocabulary: options.useProductVocabulary,
      productVocabularyTerms: transcription.productVocabularyTerms,
      productVocabularyRole: transcription.productVocabularyRole,
      liveConfigPerMode: Object.fromEntries(
        options.modes.map((laneMode) => [
          laneMode,
          resolveTranscriptionRequest({
            model: transcription.model,
            mode: laneMode,
            languageCodes: [],
            useProductVocabulary: options.useProductVocabulary,
            lane: "lab",
          }).liveConfig,
        ]),
      ),
      audioContract: {
        mimeType: TARGET_MIME_TYPE,
        framesPerChunk: FRAMES_PER_CHUNK,
        pacing: "wall-clock, never faster than realtime",
        concurrency: "one lane at a time, sequential clips, for quota isolation",
      },
      limits: TRANSCRIPTION_LIMITS,
      clipLimits: CLIP_LIMITS,
      credentialCeilingPerSessionPerHour: TRANSCRIPTION_LIMITS.maxTokensPerSessionPerHour,
      finalGraceMs: TRANSCRIPTION_LIMITS.finalGraceMs,
      retries: "none - no retry, no model fallback, no provider fallback",
    },
    featureFlags: featureSummary(),
    versions,
    runOrder: clips.map((clip) => ({ order: clip.order, id: clip.id, file: clip.file, skipped: clip.skipped })),
    clips: clips.map((clip) => ({
      id: clip.id,
      file: clip.file,
      hash: clip.hash ?? null,
      durationSeconds: clip.durationSeconds ?? null,
      bytes: clip.bytes ?? null,
      order: clip.order,
      sourceSampleRate: clip.sourceSampleRate ?? null,
      sourceChannels: clip.sourceChannels ?? null,
      normalizedBytes: clip.normalizedBytes ?? null,
      chunkCount: clip.chunkCount ?? null,
      skipped: clip.skipped,
      skipReasons: clip.reasons,
    })),
    laneRuns,
    counts,
    latency,
    unmeasured: [
      "word recognition accuracy / word error rate - scored by a human in docs/V5_EVAL_TEMPLATE.csv",
      "readability - scored by a human",
      "meaning preservation, including consent, negation, amount and quoted speech - scored by a human, and the only score that can block promotion",
      "provider-side confidence - the provider reports none for this path and none is invented here",
      "whether either lane is closer to what was actually said - this file compares machine outputs to each other, nothing more",
    ],
    guarantees: [
      "No audio bytes are stored in this file.",
      "No API key or credential value is stored in this file or printed by the harness.",
      "Skipped, timed-out and unavailable runs stay in the denominator.",
      "Transcript text in this file is untrusted content. Escape it before rendering it anywhere.",
    ],
  };

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // -------------------------------------------------------------------------
  // Closing summary: what was measured, and what is still unknown.
  // -------------------------------------------------------------------------
  say("");
  say(RULE);
  say(`Report written to ${outFile}`);
  say(RULE);
  say("Counts");
  say(`  clips found            ${counts.clipsFound}`);
  say(`  clips selected         ${counts.clipsSelected}`);
  say(`  clips usable           ${counts.clipsUsable}`);
  say(`  clips skipped          ${counts.clipsSkipped}   (still in the denominator)`);
  say(`  lane runs planned      ${counts.planned}`);
  say(`  lane runs attempted    ${counts.attempted}`);
  say(`  completed              ${counts.completed}`);
  say(`  timed out              ${counts.timedOut}`);
  say(`  unavailable            ${counts.unavailable}`);
  say("");
  say("Measured by this run");
  say("  Byte size, decoded duration, chunk count and SHA-256 of every usable clip.");
  say("    Local arithmetic. Identical to the browser lab's normalisation path.");
  if (mode === "live") {
    say("  Whether each lane run produced finalised text, timed out, or was unavailable.");
    say(`  endToFinalMs: last sample sent -> last finalised segment received.`);
    say(`    all lanes  p50 ${latency.all.p50 ?? "n/a"} ms  p95 ${latency.all.p95 ?? "n/a"} ms  (${latency.all.samples} sample${latency.all.samples === 1 ? "" : "s"})`);
    say(`    ${latency.all.note}`);
    for (const laneMode of options.modes) {
      const stats = latency.byMode[laneMode];
      say(`    ${laneMode.padEnd(9)} p50 ${stats.p50 ?? "n/a"} ms  p95 ${stats.p95 ?? "n/a"} ms  (${stats.samples} sample${stats.samples === 1 ? "" : "s"})${stats.lowConfidence ? "  LOW CONFIDENCE, fewer than 3 samples" : ""}`);
    }
  } else {
    say("  Nothing else. This was a dry run: the plan above is what WOULD be sent.");
  }
  say("");
  say("Unknown after this run - nothing here computed it, and nothing should claim it");
  for (const item of report.unmeasured) say(`  ${item}`);
  say("");
  say("Next step");
  say("  Open docs/V5_EVAL_TEMPLATE.csv, score each clip by reading the two lanes side by side,");
  say("  and check the result against the proposed promotion criteria in");
  say("  docs/V5_TRANSCRIPT_CORPUS.md. Those criteria were fixed before this run and must not");
  say("  be edited now that there are results to look at.");
  say(RULE);

  const needsAttention =
    counts.clipsSkipped > 0 ||
    counts.timedOut > 0 ||
    counts.unavailable > 0 ||
    counts.clipsUsable === 0;
  if (needsAttention) {
    say("Exit 1: something above needs the owner's attention.");
    say("");
    process.exit(1);
  }
  say("Exit 0: every clip was usable and every attempted lane run completed.");
  say("");
  process.exit(0);
}

main().catch((error) => {
  fail(`The harness stopped: ${error?.message || "unknown error"}`);
});
