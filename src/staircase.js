/**
 * Adaptive hearing threshold finder (better than single Yes/No).
 *
 * Samsung-style UX: user only answers "can you hear it?"
 * Under the hood: staircase (like clinical audiometry) homes in on
 * the softest level they can still hear — stored as 0..1 for the EQ math.
 *
 * Rules (simplified Hughson–Westlake):
 *  - Hear it  → play quieter
 *  - Miss it  → play louder
 *  - Each time the answer flips, record a reversal and shrink the step
 *  - After enough reversals, average them → threshold
 */

export const STAIR_DEFAULTS = {
  /** First presentation level (clearly audible for most). */
  startLevel: 0.28,
  /** Initial step size in linear gain. */
  startStep: 0.1,
  /** Don't shrink step below this. */
  minStep: 0.018,
  /** Absolute volume floor / ceiling. */
  minLevel: 0.002,
  maxLevel: 1.0,
  /** Stop after this many direction changes. */
  reversalsNeeded: 4,
  /** Safety: force finish after this many Yes/No answers. */
  maxTrials: 14,
  /** Average this many last reversals for the final threshold. */
  averageLast: 4,
};

/**
 * @param {Partial<typeof STAIR_DEFAULTS>} [opts]
 */
export function createStaircase(opts = {}) {
  const cfg = { ...STAIR_DEFAULTS, ...opts };
  return {
    cfg,
    level: clamp(cfg.startLevel, cfg.minLevel, cfg.maxLevel),
    step: cfg.startStep,
    lastHeard: null, // true | false | null
    reversals: [],
    trials: 0,
    done: false,
    threshold: null,
  };
}

/**
 * Apply a Yes/No answer. Mutates stair state.
 * @param {ReturnType<typeof createStaircase>} stair
 * @param {boolean} heard  true = Yes I hear it
 * @returns {{ done: boolean, level: number, threshold: number|null, justReversed: boolean }}
 */
export function answerStaircase(stair, heard) {
  if (stair.done) {
    return {
      done: true,
      level: stair.level,
      threshold: stair.threshold,
      justReversed: false,
    };
  }

  const { cfg } = stair;
  stair.trials += 1;
  let justReversed = false;

  if (stair.lastHeard !== null && stair.lastHeard !== heard) {
    // Reversal: threshold is between previous and current presentation
    stair.reversals.push(stair.level);
    justReversed = true;
    // Shrink step after each reversal (finer search)
    stair.step = Math.max(cfg.minStep, stair.step * 0.55);
  }

  stair.lastHeard = heard;

  if (heard) {
    // Quieter next
    stair.level = clamp(stair.level - stair.step, cfg.minLevel, cfg.maxLevel);
  } else {
    // Louder next
    stair.level = clamp(stair.level + stair.step, cfg.minLevel, cfg.maxLevel);
  }

  const hitFloor = heard && stair.level <= cfg.minLevel + 1e-9;
  const hitCeil = !heard && stair.level >= cfg.maxLevel - 1e-9;
  const enoughReversals = stair.reversals.length >= cfg.reversalsNeeded;
  const maxedOut = stair.trials >= cfg.maxTrials;

  if (hitFloor) {
    // Heard even the softest → excellent at this band
    finish(stair, cfg.minLevel);
  } else if (hitCeil && !heard) {
    // Still can't hear max → mark as needs full boost
    finish(stair, cfg.maxLevel);
  } else if (enoughReversals || maxedOut) {
    const thr = averageReversals(stair.reversals, cfg.averageLast);
    // If we ended without reversals (e.g. only max trials all same), use last level
    finish(stair, thr ?? stair.level);
  }

  return {
    done: stair.done,
    level: stair.level,
    threshold: stair.threshold,
    justReversed,
  };
}

function finish(stair, threshold) {
  stair.done = true;
  stair.threshold = clamp(threshold, stair.cfg.minLevel, stair.cfg.maxLevel);
}

function averageReversals(list, n) {
  if (!list.length) return null;
  const slice = list.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export default { createStaircase, answerStaircase, STAIR_DEFAULTS };
