/**
 * Web Audio diagnostic engine.
 * Samsung-style pulsed beeps → StereoPannerNode for exclusive L/R routing.
 */

export class ToneEngine {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.panner = null;
    this.playing = false;
    this._volume = 0.1;
    /** 'beep' = Samsung-like short pulses | 'steady' = continuous | 'pulse' = soft gate */
    this.mode = "beep";
    this._pulseTimer = null;
    this._pulseOn = true;
    this._beepPhase = 0;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * @param {"beep"|"pulse"|"steady"} mode
   */
  setToneMode(mode) {
    this.mode = mode || "beep";
    if (this.playing) {
      this._restartModulation();
    }
  }

  /** @deprecated use setToneMode — kept for settings compat */
  setPulseMode(enabled) {
    this.setToneMode(enabled ? "beep" : "steady");
  }

  /**
   * @param {number} frequencyHz
   * @param {"L"|"R"} ear
   * @param {number} volume 0..1
   * @param {{ mode?: string, pulse?: boolean }} [opts]
   */
  async play(frequencyHz, ear, volume = 0.1, opts = {}) {
    await this.ensureContext();
    if (opts.mode) this.mode = opts.mode;
    else if (opts.pulse != null) this.mode = opts.pulse ? "beep" : "steady";

    const pan = ear === "R" || ear === "right" ? 1 : -1;
    const vol = clamp01(volume);

    if (this.playing && this.osc && this.gain && this.panner) {
      this.osc.frequency.setTargetAtTime(frequencyHz, this.ctx.currentTime, 0.012);
      this.panner.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.01);
      this._volume = vol;
      if (this.mode === "steady") this._setVolume(vol, 0.03);
      // beep/pulse pick up new volume on next on-cycle
      return;
    }

    this.stop(true);

    this.osc = this.ctx.createOscillator();
    this.osc.type = "sine";
    this.osc.frequency.value = frequencyHz;

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;

    this.panner = this.ctx.createStereoPanner();
    this.panner.pan.value = pan;

    this.osc.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(this.ctx.destination);

    this.osc.start();
    this.playing = true;
    this._volume = vol;
    this._restartModulation();
  }

  setVolume(volume) {
    this._volume = clamp01(volume);
    if (this.playing && this.gain && this.ctx) {
      if (this.mode === "steady") {
        this._setVolume(this._volume, 0.02);
      } else if (this._pulseOn) {
        this._setVolume(this._volume, 0.015);
      }
    }
  }

  getVolume() {
    return this._volume;
  }

  stop(instant = false) {
    this._clearModulation();

    if (!this.osc) {
      this.playing = false;
      return;
    }

    const osc = this.osc;
    const gain = this.gain;
    const ctx = this.ctx;

    try {
      if (!instant && gain && ctx) {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(Math.max(gain.gain.value, 0), t);
        gain.gain.linearRampToValueAtTime(0, t + 0.025);
        osc.stop(t + 0.035);
      } else {
        osc.stop();
      }
    } catch {
      /* already stopped */
    }

    try {
      osc.disconnect();
      gain?.disconnect();
      this.panner?.disconnect();
    } catch {
      /* ignore */
    }

    this.osc = null;
    this.gain = null;
    this.panner = null;
    this.playing = false;
  }

  async suspend() {
    this.stop();
    if (this.ctx && this.ctx.state === "running") {
      await this.ctx.suspend();
    }
  }

  _restartModulation() {
    this._clearModulation();
    if (this.mode === "steady") {
      this._setVolume(this._volume, 0.04);
      return;
    }
    if (this.mode === "beep") {
      this._startBeepPattern();
      return;
    }
    this._startSoftPulse();
  }

  _clearModulation() {
    if (this._pulseTimer) {
      clearTimeout(this._pulseTimer);
      this._pulseTimer = null;
    }
    this._pulseOn = true;
    this._beepPhase = 0;
  }

  /**
   * Samsung-like: beep · beep · beep · (pause) · repeat
   * Pattern: 180ms on, 140ms off × 3, then 520ms silence.
   */
  _startBeepPattern() {
    this._beepPhase = 0;
    const tick = () => {
      if (!this.playing || !this.gain || !this.ctx) return;

      // phases 0,2,4 = on; 1,3,5 = short gap; 6 = long pause
      const onPhases = new Set([0, 2, 4]);
      const longPausePhase = 6;

      if (onPhases.has(this._beepPhase)) {
        this._pulseOn = true;
        this._setVolume(this._volume, 0.012);
        this._pulseTimer = setTimeout(tick, 180);
      } else if (this._beepPhase === longPausePhase) {
        this._pulseOn = false;
        this._setVolume(0, 0.02);
        this._pulseTimer = setTimeout(tick, 520);
      } else {
        this._pulseOn = false;
        this._setVolume(0, 0.015);
        this._pulseTimer = setTimeout(tick, 140);
      }

      this._beepPhase = (this._beepPhase + 1) % 7;
    };
    tick();
  }

  /** Soft continuous gate (legacy pulse). */
  _startSoftPulse() {
    this._pulseOn = true;
    const beat = () => {
      if (!this.playing || !this.gain || !this.ctx) return;
      if (this._pulseOn) {
        this._setVolume(this._volume, 0.03);
      } else {
        this._setVolume(0, 0.04);
      }
      this._pulseOn = !this._pulseOn;
      this._pulseTimer = setTimeout(beat, this._pulseOn ? 280 : 400);
    };
    beat();
  }

  _setVolume(vol, rampSec) {
    if (!this.gain || !this.ctx) return;
    const t = this.ctx.currentTime;
    const current = Math.max(this.gain.gain.value, 0.00001);
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(current, t);
    const target = Math.max(vol, 0);
    if (target <= 0) {
      this.gain.gain.linearRampToValueAtTime(0.00001, t + rampSec);
      this.gain.gain.setValueAtTime(0, t + rampSec + 0.001);
    } else {
      this.gain.gain.linearRampToValueAtTime(target, t + rampSec);
    }
  }
}

/**
 * Ambient noise check via microphone RMS. Fails open if mic denied.
 */
export async function checkAmbientNoise(durationMs = 1400) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: true,
      level: null,
      skipped: true,
      message: "Mic check unavailable. Make sure the room is quiet.",
    };
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  } catch {
    return {
      ok: true,
      level: null,
      skipped: true,
      message: "Microphone permission skipped. Confirm your room is quiet.",
    };
  }

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const data = new Float32Array(analyser.fftSize);
    const samples = [];
    const start = performance.now();

    await new Promise((resolve) => {
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        samples.push(Math.sqrt(sum / data.length));
        if (performance.now() - start >= durationMs) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });

    source.disconnect();
    await ctx.close();
    stream.getTracks().forEach((t) => t.stop());

    const avg = samples.reduce((a, b) => a + b, 0) / Math.max(samples.length, 1);
    const QUIET = 0.02;
    const NOISY = 0.05;
    const ok = avg < QUIET;

    let message;
    if (avg < QUIET) {
      message = "Room looks quiet. Great for an accurate test.";
    } else if (avg < NOISY) {
      message = "A little background noise — OK to continue, quieter is better.";
    } else {
      message = "Ambient noise is high. Move somewhere quieter if you can.";
    }

    return { ok, level: avg, skipped: false, message };
  } catch {
    stream?.getTracks?.().forEach((t) => t.stop());
    return {
      ok: true,
      level: null,
      skipped: true,
      message: "Could not finish noise check. Continue in a quiet room.",
    };
  }
}

function clamp01(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export default ToneEngine;
