/**
 * Audio validation and normalisation for the transcript lab.
 *
 * Everything here is a pure function over typed arrays: no Web Audio, no DOM,
 * no network. That is deliberate -- it means the same code runs in the browser
 * and under `node --test`, so the byte-level behaviour that the whole
 * comparison rests on is actually testable.
 *
 * The one browser-only step (decoding an .mp3/.wav/.webm file into raw
 * samples) stays in `lab.js`, which hands the decoded channel data in here.
 *
 * Target format is the one the provider documents for
 * `gemini-3.5-transcribe-live`: raw 16-bit PCM, 16 kHz, mono, little-endian,
 * MIME `audio/pcm;rate=16000`, sent in roughly 100 ms chunks.
 */

export const TARGET_SAMPLE_RATE = 16000;
export const TARGET_CHANNELS = 1;
export const TARGET_MIME_TYPE = "audio/pcm;rate=16000";
export const BYTES_PER_SAMPLE = 2;

/** 100 ms at 16 kHz. Inside the provider's documented 1,024-2,048 frame range. */
export const FRAMES_PER_CHUNK = 1600;

export const CLIP_LIMITS = Object.freeze({
  maxSeconds: 30,
  minSeconds: 0.25,
  maxBytes: 8 * 1024 * 1024,
  maxClipsPerBatch: 8,
  /** Container types we are willing to hand to the browser decoder. */
  allowedMimePrefixes: Object.freeze(["audio/"]),
  allowedExtensions: Object.freeze([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".flac"]),
});

/**
 * Check a chosen file before decoding it.
 *
 * Size and type only -- the true duration is unknown until it is decoded, which
 * is why `validateDecodedClip` exists as a second gate.
 */
export function validateClipFile({ name = "", size = 0, type = "" } = {}) {
  const problems = [];
  const lowerName = String(name).toLowerCase();
  const extension = lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".")) : "";

  if (!Number.isFinite(size) || size <= 0) problems.push("The file is empty.");
  if (size > CLIP_LIMITS.maxBytes) {
    problems.push(`The file is larger than the ${Math.round(CLIP_LIMITS.maxBytes / (1024 * 1024))} MB limit.`);
  }

  const declaredType = String(type || "");
  const typeLooksAudio = CLIP_LIMITS.allowedMimePrefixes.some((prefix) => declaredType.startsWith(prefix));
  const extensionLooksAudio = CLIP_LIMITS.allowedExtensions.includes(extension);
  if (!typeLooksAudio && !extensionLooksAudio) {
    problems.push("That does not look like an audio file.");
  }

  return {
    ok: problems.length === 0,
    problems,
    extension,
    declaredType,
    sizeBytes: Number(size) || 0,
  };
}

/** Second gate: the real duration, known only after decoding. */
export function validateDecodedClip({ durationSeconds = 0, sampleRate = 0, channels = 0 } = {}) {
  const problems = [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    problems.push("The file decoded to no audio.");
  } else {
    if (durationSeconds > CLIP_LIMITS.maxSeconds) {
      problems.push(`The clip is ${durationSeconds.toFixed(1)} s, over the ${CLIP_LIMITS.maxSeconds} s cap.`);
    }
    if (durationSeconds < CLIP_LIMITS.minSeconds) {
      problems.push("The clip is too short to be worth comparing.");
    }
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) problems.push("The decoded sample rate is unknown.");
  if (!Number.isInteger(channels) || channels < 1) problems.push("The decoded channel count is unknown.");
  return { ok: problems.length === 0, problems };
}

/**
 * Mix any channel layout down to one channel.
 *
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let total = 0;
    for (const channel of channels) total += channel[index];
    mono[index] = total / channels.length;
  }
  return mono;
}

/**
 * Resample to 16 kHz by box averaging.
 *
 * DOWNSAMPLING is bit-identical to the voice core's own resampler, on purpose:
 * if two lanes were resampled differently, part of any word-accuracy difference
 * between them would be our own arithmetic rather than the recogniser.
 *
 * UPSAMPLING is where this function deliberately DIVERGES from the voice core.
 * The voice core only ever downsamples a 44.1/48 kHz microphone to 16 kHz, so
 * its box average never meets a source window narrower than one sample. The lab
 * does: an 8 kHz clip is a perfectly ordinary thing for someone to hand it. In
 * that case `floor(index * ratio) === floor((index + 1) * ratio)`, the window is
 * empty, and a plain box average divides zero by one and emits SILENCE for every
 * other sample -- audibly destroying the clip while looking like it worked.
 * So an empty window falls back to the nearest source sample.
 *
 * The voice core's copy is intentionally left alone: changing it would alter the
 * V4 baseline we are trying to compare against, and it cannot hit this case.
 */
export function resampleTo16k(input, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (!(input instanceof Float32Array)) throw new TypeError("resampleTo16k expects a Float32Array.");
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new RangeError("sourceRate must be positive.");
  if (sourceRate === targetRate) return input;
  if (input.length === 0) return new Float32Array(0);
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  const lastIndex = input.length - 1;
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    if (end <= start) {
      output[index] = input[Math.min(lastIndex, start)];
      continue;
    }
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) total += input[sourceIndex];
    output[index] = total / (end - start);
  }
  return output;
}

/** Float samples in [-1, 1] to little-endian signed 16-bit PCM bytes. */
export function floatToPcm16(samples) {
  if (!(samples instanceof Float32Array)) throw new TypeError("floatToPcm16 expects a Float32Array.");
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export function pcm16DurationSeconds(bytes, sampleRate = TARGET_SAMPLE_RATE) {
  const length = bytes?.byteLength ?? bytes?.length ?? 0;
  return length / BYTES_PER_SAMPLE / sampleRate;
}

/**
 * Split PCM bytes into wall-clock-sized chunks.
 *
 * Every chunk except possibly the last is exactly `framesPerChunk` frames, so
 * the replay pacing below can rely on a constant chunk duration.
 */
export function chunkPcm16(bytes, framesPerChunk = FRAMES_PER_CHUNK) {
  if (!bytes || typeof bytes.byteLength !== "number") throw new TypeError("chunkPcm16 expects a byte array.");
  const bytesPerChunk = framesPerChunk * BYTES_PER_SAMPLE;
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunks = [];
  for (let offset = 0; offset < source.byteLength; offset += bytesPerChunk) {
    chunks.push(source.slice(offset, Math.min(source.byteLength, offset + bytesPerChunk)));
  }
  return chunks;
}

/** Portable base64 for a byte array: works in the browser and in Node. */
export function bytesToBase64(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer === "function") return Buffer.from(source).toString("base64");
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < source.length; offset += stride) {
    binary += String.fromCharCode.apply(null, source.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

/**
 * SHA-256 of the exact normalised samples.
 *
 * This hash is the identity of a clip. It is what makes "same input to every
 * lane" a checkable claim rather than an assurance, and it is what the lab
 * aligns lanes on instead of guessing by turn position or text similarity.
 */
export async function sha256Hex(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("No SubtleCrypto available for hashing.");
  const view = source.buffer instanceof ArrayBuffer && source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
    ? source.buffer
    : source.slice().buffer;
  const digest = await subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The one-shot normalisation every lane shares.
 *
 * Called ONCE per clip. Each lane then replays the identical bytes, so no lane
 * can be advantaged by a different resampling path.
 *
 * @param {Float32Array[]} channelData decoded channels
 * @param {number} sourceSampleRate
 */
export async function normalizeClip(channelData, sourceSampleRate) {
  const mono = mixToMono(channelData);
  const resampled = resampleTo16k(mono, sourceSampleRate);
  const pcm = floatToPcm16(resampled);
  // Detach from the Int16Array's buffer so the returned bytes are independent.
  const bytes = pcm.slice();
  const hash = await sha256Hex(bytes);
  return {
    bytes,
    hash,
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    mimeType: TARGET_MIME_TYPE,
    sourceSampleRate,
    sourceChannels: Array.isArray(channelData) ? channelData.length : 0,
    frames: resampled.length,
    durationSeconds: resampled.length / TARGET_SAMPLE_RATE,
    byteLength: bytes.byteLength,
  };
}

/**
 * Very rough loudness, for a "this clip is nearly silent" warning in the lab.
 *
 * Reported as an estimate and never used to score a recogniser, gate a lane, or
 * authorise anything. It exists so a reviewer notices they picked the wrong
 * file before spending a provider call on it.
 */
export function estimateRms(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) return null;
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
  return Math.sqrt(total / samples.length);
}
