/**
 * Audio math: dB HL thresholds → parametric EQ gains + preamp headroom.
 *
 * The hearing test measures a threshold per band in "dB HL-ish" units
 * (0 ≈ excellent hearing at the calibrated reference volume). Gains are
 * computed RELATIVE to the user's best band, which self-calibrates for
 * headphone sensitivity and system volume: EQ can only fix the *shape*
 * of hearing loss, never uniform loss (that's the volume knob's job).
 *
 * Modes:
 *  - full     : 100% inversion of the measured curve
 *  - half     : 50% (classic half-gain rule — safer everyday listening)
 *  - gentle   : 35% subtle compensation
 */

/**
 * Full hearing-map bands (ISO-style + extended highs).
 * Covers bass → presence → air up through 16 kHz — tested with beeps only.
 */
export const FREQUENCIES = [
  125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 14000, 16000,
];

/**
 * Equal-loudness correction per band, approximating the ISO 226 threshold
 * of hearing (dB SPL needed at threshold vs. mid frequencies). A pure sine
 * at the same dBFS is far harder to hear at 125 Hz or 16 kHz than at 2 kHz;
 * presenting each band with this offset makes "0 dB HL" mean roughly the
 * same *perceptual* threshold everywhere. Values above 8 kHz are
 * extrapolated (headphone response dominates up there anyway).
 */
export const EQUAL_LOUDNESS_OFFSET_DB = {
  125: 22,
  250: 12,
  500: 4,
  750: 3,
  1000: 2,
  1500: 1,
  2000: -1,
  3000: -5,
  4000: -5,
  6000: 3,
  8000: 13,
  10000: 16,
  12000: 21,
  14000: 27,
  16000: 38,
};

/** dBFS that corresponds to 0 dB HL at the calibrated reference volume. */
export const REF_DBFS_AT_0HL = -85;

/** Presentation clamp so tones never clip or disappear into float noise. */
export const PRESENT_MIN_DBFS = -95;
export const PRESENT_MAX_DBFS = -6;

/** Ignore threshold differences smaller than this (measurement noise). */
export const DEADBAND_DB = 3;

/** Safety cap so extreme thresholds never produce dangerous boosts. */
export const MAX_GAIN_DB = 15.0;

/** Neutral threshold used to fill missing bands. */
export const BASELINE_HL = 0;

/**
 * Parametric peaking Q.
 * Slightly narrower than classic √2 so denser half-octave bands don't smear together.
 */
export const DEFAULT_Q = 1.8;

/** Compensation intensity modes. */
export const MODES = {
  full: { id: "full", label: "Full clarity", factor: 1.0, blurb: "Strongest match to your test" },
  half: { id: "half", label: "Balanced", factor: 0.5, blurb: "Natural everyday boost (recommended)" },
  gentle: { id: "gentle", label: "Gentle", factor: 0.35, blurb: "Subtle lift — good for music first" },
};

/**
 * Convert a staircase level (dB HL) for a band into the dBFS the tone
 * generator should actually play, including the equal-loudness offset.
 * @param {number} frequency
 * @param {number} levelHl
 * @returns {number} presentation level in dBFS
 */
export function hlToPresentationDbfs(frequency, levelHl) {
  const offset = EQUAL_LOUDNESS_OFFSET_DB[frequency] ?? 0;
  const dbfs = REF_DBFS_AT_0HL + offset + levelHl;
  return clamp(dbfs, PRESENT_MIN_DBFS, PRESENT_MAX_DBFS);
}

/** dBFS → linear Web Audio gain. */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Build left/right filter maps and dynamic preamp from measured thresholds.
 *
 * @param {Record<number, number>} leftThresholds  dB HL per frequency
 * @param {Record<number, number>} rightThresholds dB HL per frequency
 * @param {{ mode?: string, factor?: number }} [options]
 */
export function buildProfile(leftThresholds, rightThresholds, options = {}) {
  const modeId = options.mode || "half";
  const mode = MODES[modeId] || MODES.half;
  const factor = options.factor != null ? Number(options.factor) : mode.factor;

  const left = normalizeThresholdMap(leftThresholds);
  const right = normalizeThresholdMap(rightThresholds);

  // Reference = the user's best hearing across all bands and both ears.
  // Average of the two lowest values so a single lucky "yes" can't drag
  // the whole reference down and inflate every other gain.
  const reference = bestReference([
    ...FREQUENCIES.map((f) => left[f]),
    ...FREQUENCIES.map((f) => right[f]),
  ]);

  const gainFor = (hl) => {
    if (hl == null || Number.isNaN(Number(hl))) return 0;
    const raw = (Number(hl) - reference - DEADBAND_DB) * clamp(factor, 0, 1);
    return round1(clamp(raw, 0, MAX_GAIN_DB));
  };

  const filters = [];
  const leftGains = {};
  const rightGains = {};
  let maxBoost = 0;

  for (const freq of FREQUENCIES) {
    const lGain = gainFor(left[freq]);
    const rGain = gainFor(right[freq]);
    leftGains[freq] = lGain;
    rightGains[freq] = rGain;
    maxBoost = Math.max(maxBoost, lGain, rGain);

    filters.push({ frequency: freq, gainDb: lGain, q: DEFAULT_Q, channel: "L" });
    filters.push({ frequency: freq, gainDb: rGain, q: DEFAULT_Q, channel: "R" });
  }

  const preampDb = maxBoost > 0 ? round1(-maxBoost) : 0;

  return {
    filters,
    preampDb,
    leftGains,
    rightGains,
    maxBoost: round1(maxBoost),
    reference: round1(reference),
    mode: mode.id,
    factor,
  };
}

function bestReference(values) {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (!nums.length) return BASELINE_HL;
  if (nums.length === 1) return nums[0];
  return (nums[0] + nums[1]) / 2;
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
    parts.push("Your hearing looks even across the board — little or no boost needed.");
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
  EQUAL_LOUDNESS_OFFSET_DB,
  REF_DBFS_AT_0HL,
  BASELINE_HL,
  DEADBAND_DB,
  DEFAULT_Q,
  MAX_GAIN_DB,
  MODES,
  hlToPresentationDbfs,
  dbToGain,
  buildProfile,
  describeProfile,
  profileToInvokePayload,
};
