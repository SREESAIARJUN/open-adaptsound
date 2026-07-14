import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildProfile,
  describeProfile,
  hlToPresentationDbfs,
  dbToGain,
  DEADBAND_DB,
  MAX_GAIN_DB,
  PRESENT_MIN_DBFS,
  PRESENT_MAX_DBFS,
  REF_DBFS_AT_0HL,
  EQUAL_LOUDNESS_OFFSET_DB,
  FREQUENCIES,
  MODES,
} from "./calculator.js";

describe("hlToPresentationDbfs", () => {
  it("maps 0 dB HL at 1 kHz near the reference floor", () => {
    const db = hlToPresentationDbfs(1000, 0);
    assert.equal(db, REF_DBFS_AT_0HL + EQUAL_LOUDNESS_OFFSET_DB[1000]);
  });

  it("applies equal-loudness offsets so lows/highs play hotter", () => {
    const at125 = hlToPresentationDbfs(125, 20);
    const at2000 = hlToPresentationDbfs(2000, 20);
    assert.ok(at125 > at2000, `125 Hz (${at125}) should be hotter than 2 kHz (${at2000})`);
  });

  it("clamps to the safe presentation window", () => {
    assert.equal(hlToPresentationDbfs(16000, 200), PRESENT_MAX_DBFS);
    assert.equal(hlToPresentationDbfs(2000, -200), PRESENT_MIN_DBFS);
  });

  it("quiet levels are genuinely quiet in linear gain", () => {
    // The old linear engine bottomed out at gain 0.002 (-54 dBFS) — still audible.
    const floorGain = dbToGain(hlToPresentationDbfs(1000, -10));
    assert.ok(floorGain < 0.001, `floor gain ${floorGain} should be < 0.001`);
  });
});

describe("buildProfile (relative dB HL)", () => {
  const flat = (hl) => Object.fromEntries(FREQUENCIES.map((f) => [f, hl]));

  it("uniform thresholds → flat profile (EQ can't fix uniform loss)", () => {
    const profile = buildProfile(flat(30), flat(30), { mode: "full" });
    assert.equal(profile.preampDb, 0);
    assert.ok(profile.filters.every((f) => f.gainDb === 0));
  });

  it("boosts weak bands relative to the best band", () => {
    const left = flat(5);
    left[8000] = 20; // 15 dB worse at 8 kHz
    const profile = buildProfile(left, flat(5), { mode: "full" });
    const l8k = profile.leftGains[8000];
    assert.ok(
      Math.abs(l8k - (15 - DEADBAND_DB)) < 0.2,
      `expected ~${15 - DEADBAND_DB} dB, got ${l8k}`
    );
    assert.equal(profile.leftGains[1000], 0);
    assert.equal(profile.preampDb, -profile.maxBoost);
  });

  it("small differences inside the deadband produce no boost", () => {
    const left = flat(5);
    left[4000] = 5 + DEADBAND_DB - 1;
    const profile = buildProfile(left, flat(5), { mode: "full" });
    assert.equal(profile.leftGains[4000], 0);
  });

  it("caps extreme gains", () => {
    const left = flat(0);
    left[16000] = 70;
    const profile = buildProfile(left, flat(0), { mode: "full" });
    assert.equal(profile.leftGains[16000], MAX_GAIN_DB);
  });

  it("one lucky low answer can't inflate every gain (robust reference)", () => {
    // All bands 20 dB HL except a single spurious -10 outlier
    const left = flat(20);
    left[1000] = -10;
    const profile = buildProfile(left, flat(20), { mode: "full" });
    // Reference = avg of two lowest (-10 and 20) = 5, not -10
    const g = profile.leftGains[4000];
    assert.ok(g <= 20 - 5 - DEADBAND_DB + 0.2, `gain ${g} should use robust reference`);
  });

  it("supports asymmetric left/right maps", () => {
    const left = flat(5);
    left[4000] = 25;
    const right = flat(5);
    const profile = buildProfile(left, right, { mode: "full" });
    const l4 = profile.filters.find((f) => f.frequency === 4000 && f.channel === "L");
    const r4 = profile.filters.find((f) => f.frequency === 4000 && f.channel === "R");
    assert.ok(l4.gainDb > 0);
    assert.equal(r4.gainDb, 0);
  });

  it("produces all freqs × 2 channels and defaults to balanced mode", () => {
    const left = flat(5);
    left[8000] = 25;
    const profile = buildProfile(left, flat(5));
    assert.equal(profile.filters.length, FREQUENCIES.length * 2);
    assert.equal(profile.mode, "half");
    assert.equal(profile.factor, MODES.half.factor);
    const full = buildProfile(left, flat(5), { mode: "full" });
    assert.ok(profile.maxBoost < full.maxBoost);
  });

  it("describeProfile returns friendly non-empty text", () => {
    const left = flat(5);
    left[8000] = 25;
    const profile = buildProfile(left, flat(5), { mode: "half" });
    const text = describeProfile(profile);
    assert.ok(text.length > 20);
    assert.ok(/Intensity/i.test(text));
  });
});
