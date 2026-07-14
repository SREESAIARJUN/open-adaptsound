/**
 * Audio math: threshold volumes → parametric EQ gains + preamp headroom.
 *
 * Modes:
 *  - full     : 100% log inversion (PRD baseline)
 *  - half     : 50% (classic half-gain rule — safer everyday listening)
 *  - gentle   : 40% softer compensation
 */

/**
 * Full hearing-map bands (ISO-style + extended highs).
 * Covers bass → presence → air up through 16 kHz — tested with beeps only.
 */
export const FREQUENCIES = [
  125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 14000, 16000,
];

/** Midpoint of PRD healthy baseline range (0.05–0.1). */
export const BASELINE_THRESHOLD = 0.075;

/**
 * Parametric peaking Q.
 * Slightly narrower than classic √2 so denser half-octave bands don't smear together.
 */
export const DEFAULT_Q = 1.8;

/** Safety cap so extreme thresholds never produce dangerous boosts. */
export const MAX_GAIN_DB = 18.0;

export const MIN_THRESHOLD = 0.001;
export const MAX_THRESHOLD = 1.0;

/** Compensation intensity modes. */
export const MODES = {
  full: { id: "full", label: "Full clarity", factor: 1.0, blurb: "Strongest match to your test" },
  half: { id: "half", label: "Balanced", factor: 0.5, blurb: "Natural everyday boost (recommended)" },
  gentle: { id: "gentle", label: "Gentle", factor: 0.4, blurb: "Subtle lift — good for music first" },
};

/**
 * Convert a normalized volume threshold (0–1) to compensation gain in dB.
 * @param {number} threshold
 * @param {object} [opts]
 * @param {number} [opts.baseline]
 * @param {number} [opts.factor] 0..1 scale of full inversion
 * @param {number} [opts.maxGainDb]
 */
export function thresholdToGainDb(threshold, opts = {}) {
  const baseline = opts.baseline ?? BASELINE_THRESHOLD;
  const factor = opts.factor ?? 1.0;
  const maxGain = opts.maxGainDb ?? MAX_GAIN_DB;

  const t = clamp(Number(threshold), MIN_THRESHOLD, MAX_THRESHOLD);
  const b = Math.max(MIN_THRESHOLD, Number(baseline) || BASELINE_THRESHOLD);

  if (t <= b) {
    return 0;
  }

  const raw = 20 * Math.log10(t / b) * clamp(factor, 0, 1);
  const capped = Math.min(maxGain, raw);
  return round1(capped);
}

/**
 * Build left/right filter maps and dynamic preamp from measured thresholds.
 *
 * @param {Record<number, number>|Map|Array} leftThresholds
 * @param {Record<number, number>|Map|Array} rightThresholds
 * @param {{ mode?: string, factor?: number }} [options]
 */
export function buildProfile(leftThresholds, rightThresholds, options = {}) {
  const modeId = options.mode || "half";
  const mode = MODES[modeId] || MODES.half;
  const factor = options.factor != null ? Number(options.factor) : mode.factor;

  const left = normalizeThresholdMap(leftThresholds);
  const right = normalizeThresholdMap(rightThresholds);

  const filters = [];
  const leftGains = {};
  const rightGains = {};
  let maxBoost = 0;

  for (const freq of FREQUENCIES) {
    const lGain = thresholdToGainDb(left[freq] ?? BASELINE_THRESHOLD, { factor });
    const rGain = thresholdToGainDb(right[freq] ?? BASELINE_THRESHOLD, { factor });
    leftGains[freq] = lGain;
    rightGains[freq] = rGain;
    maxBoost = Math.max(maxBoost, lGain, rGain);

    filters.push({
      frequency: freq,
      gainDb: lGain,
      q: DEFAULT_Q,
      channel: "L",
    });
    filters.push({
      frequency: freq,
      gainDb: rGain,
      q: DEFAULT_Q,
      channel: "R",
    });
  }

  const preampDb = maxBoost > 0 ? round1(-maxBoost) : 0;

  return {
    filters,
    preampDb,
    leftGains,
    rightGains,
    maxBoost: round1(maxBoost),
    mode: mode.id,
    factor,
  };
}

/**
 * Human-friendly summary without technical jargon.
 */
export function describeProfile(profile) {
  if (!profile) return "No profile yet.";

  const bands = (gains) => {
    const highs = [8000, 10000, 12000, 14000, 16000].map((f) => gains[f] || 0);
    const mids = [1000, 1500, 2000, 3000, 4000, 6000].map((f) => gains[f] || 0);
    const lows = [125, 250, 500, 750].map((f) => gains[f] || 0);
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return { high: avg(highs), mid: avg(mids), low: avg(lows) };
  };

  const L = bands(profile.leftGains || {});
  const R = bands(profile.rightGains || {});
  const overall = Math.max(profile.maxBoost || 0, 0);

  const parts = [];
  if (overall < 1) {
    parts.push("Your hearing looks strong across the board — little or no boost needed.");
  } else if (overall < 4) {
    parts.push("A light personal touch will make quiet details easier to catch.");
  } else if (overall < 9) {
    parts.push("A clear personal boost will help certain tones stand out.");
  } else {
    parts.push("A stronger personal boost is tuned for the tones you hear least.");
  }

  const highNeed = Math.max(L.high, R.high);
  const midNeed = Math.max(L.mid, R.mid);
  if (highNeed > midNeed + 1.5 && highNeed > 2) {
    parts.push("High tones get the most help (speech clarity & sparkle).");
  } else if (midNeed > highNeed + 1.5 && midNeed > 2) {
    parts.push("Mid tones get the most help (voices & instruments).");
  }

  const asym = Math.abs((profile.leftGains?.[4000] || 0) - (profile.rightGains?.[4000] || 0));
  if (asym > 2) {
    parts.push("Left and right ears are tuned independently.");
  }

  const mode = MODES[profile.mode] || MODES.half;
  parts.push(`Intensity: ${mode.label}.`);

  return parts.join(" ");
}

export function profileToInvokePayload(profile) {
  return {
    filters: profile.filters.map((f) => ({
      frequency: f.frequency,
      gainDb: f.gainDb,
      q: f.q,
      channel: f.channel,
    })),
    preampDb: profile.preampDb,
  };
}

function normalizeThresholdMap(input) {
  const out = {};
  if (!input) return out;

  if (input instanceof Map) {
    for (const [k, v] of input) out[Number(k)] = Number(v);
    return out;
  }

  if (Array.isArray(input)) {
    FREQUENCIES.forEach((freq, i) => {
      if (input[i] != null) out[freq] = Number(input[i]);
    });
    return out;
  }

  for (const [k, v] of Object.entries(input)) {
    out[Number(k)] = Number(v);
  }
  return out;
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export default {
  FREQUENCIES,
  BASELINE_THRESHOLD,
  DEFAULT_Q,
  MAX_GAIN_DB,
  MODES,
  thresholdToGainDb,
  buildProfile,
  describeProfile,
  profileToInvokePayload,
};
