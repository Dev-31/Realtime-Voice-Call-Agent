/**
 * Observability-only speech-energy probe.
 *
 * Its single job is to timestamp roughly when the caller started making sound,
 * so the Call Flight Recorder can report "how long after the caller began
 * speaking did the Twin's audio actually stop?".
 *
 * It does NOT decide turns, does NOT gate the provider's automatic VAD, and
 * does NOT authorise anything. Every number it produces is labelled an
 * estimate. This is deliberately not the V2 Smart Turn path, which the
 * hackathon plan closed for adding about 8.4 s p50 to the physical path.
 */

const DEFAULTS = Object.freeze({
  noiseFloorAlpha: 0.02,
  speechFactor: 3.5,
  minimumFloor: 0.0015,
  startFrames: 2,
  endFrames: 14,
});

function rootMeanSquare(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
  return Math.sqrt(total / Math.max(1, samples.length));
}

export class SpeechEnergyProbe {
  constructor({ onStart = () => {}, onEnd = () => {}, now = () => performance.now(), ...options } = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.now = now;
    this.reset();
  }

  reset() {
    this.noiseFloor = this.options.minimumFloor;
    this.speaking = false;
    this.aboveFrames = 0;
    this.belowFrames = 0;
    this.startedAt = null;
    this.lastStartAt = null;
    this.frameMs = 0;
  }

  push(samples, sampleRate) {
    this.frameMs = (samples.length / Math.max(1, sampleRate)) * 1000;
    const level = rootMeanSquare(samples);
    const threshold = Math.max(this.options.minimumFloor, this.noiseFloor * this.options.speechFactor);

    if (level > threshold) {
      this.aboveFrames += 1;
      this.belowFrames = 0;
    } else {
      this.belowFrames += 1;
      this.aboveFrames = 0;
      // Only adapt the floor while the caller is quiet.
      this.noiseFloor += (level - this.noiseFloor) * this.options.noiseFloorAlpha;
    }

    if (!this.speaking && this.aboveFrames >= this.options.startFrames) {
      this.speaking = true;
      // Back-date to the first frame that crossed the threshold.
      this.startedAt = this.now() - this.aboveFrames * this.frameMs;
      this.lastStartAt = this.startedAt;
      this.onStart({ at: this.startedAt, level, threshold, precision: "browser-energy-estimate" });
    } else if (this.speaking && this.belowFrames >= this.options.endFrames) {
      this.speaking = false;
      const trailingSilenceMs = this.belowFrames * this.frameMs;
      const endedAt = this.now() - trailingSilenceMs;
      this.onEnd({
        at: endedAt,
        durationMs: Math.max(0, endedAt - (this.startedAt ?? endedAt)),
        trailingSilenceMs,
        precision: "browser-energy-estimate",
      });
      this.startedAt = null;
    }
  }

  /** Best estimate of when the caller most recently began speaking. */
  speechStartedAt() {
    return this.speaking ? this.startedAt : this.lastStartAt;
  }
}
