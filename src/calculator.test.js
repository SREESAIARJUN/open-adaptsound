import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  thresholdToGainDb,
  buildProfile,
  describeProfile,
  BASELINE_THRESHOLD,
  MAX_GAIN_DB,
  FREQUENCIES,
  MODES,
} from "./calculator.js";

describe("thresholdToGainDb", () => {
  it("returns 0 at or below healthy baseline", () => {
    assert.equal(thresholdToGainDb(0.05), 0);
    assert.equal(thresholdToGainDb(BASELINE_THRESHOLD), 0);
    assert.equal(thresholdToGainDb(0.01), 0);
  });

  it("applies logarithmic inversion above baseline", () => {
    const gain = thresholdToGainDb(0.35);
    assert.ok(gain > 13 && gain < 14, `expected ~13.4, got ${gain}`);
  });

  it("caps extreme gains", () => {
    assert.equal(thresholdToGainDb(1.0), MAX_GAIN_DB);
  });

  it("scales with half-gain factor", () => {
    const full = thresholdToGainDb(0.35, { factor: 1 });
    const half = thresholdToGainDb(0.35, { factor: 0.5 });
    assert.ok(Math.abs(half * 2 - full) < 0.15, `half=${half} full=${full}`);
  });
});

describe("buildProfile", () => {
  it("produces all freqs × 2 channels filters and matching preamp", () => {
    const left = Object.fromEntries(FREQUENCIES.map((f) => [f, 0.2]));
    const right = Object.fromEntries(FREQUENCIES.map((f) => [f, 0.1]));
    const profile = buildProfile(left, right, { mode: "full" });

    assert.equal(profile.filters.length, FREQUENCIES.length * 2);
    assert.ok(profile.preampDb <= 0);
    assert.equal(profile.preampDb, -profile.maxBoost);
    for (const f of profile.filters) {
      assert.ok(f.gainDb <= profile.maxBoost + 0.05);
    }
  });

  it("handles healthy hearing with flat profile", () => {
    const healthy = Object.fromEntries(FREQUENCIES.map((f) => [f, 0.06]));
    const profile = buildProfile(healthy, healthy);
    assert.equal(profile.preampDb, 0);
    assert.ok(profile.filters.every((f) => f.gainDb === 0));
  });

  it("supports asymmetric left/right maps", () => {
    const left = { 4000: 0.4, 8000: 0.5 };
    const right = { 4000: 0.05, 8000: 0.05 };
    const profile = buildProfile(left, right, { mode: "full" });
    const l4 = profile.filters.find((f) => f.frequency === 4000 && f.channel === "L");
    const r4 = profile.filters.find((f) => f.frequency === 4000 && f.channel === "R");
    assert.ok(l4.gainDb > 0);
    assert.equal(r4.gainDb, 0);
  });

  it("defaults to balanced (half) mode", () => {
    const left = Object.fromEntries(FREQUENCIES.map((f) => [f, 0.35]));
    const right = { ...left };
    const profile = buildProfile(left, right);
    assert.equal(profile.mode, "half");
    assert.equal(profile.factor, MODES.half.factor);
    const full = buildProfile(left, right, { mode: "full" });
    assert.ok(profile.maxBoost < full.maxBoost);
  });

  it("describeProfile returns friendly non-empty text", () => {
    const left = Object.fromEntries(FREQUENCIES.map((f) => [f, 0.25]));
    const profile = buildProfile(left, left, { mode: "half" });
    const text = describeProfile(profile);
    assert.ok(text.length > 20);
    assert.ok(/Intensity/i.test(text));
  });
});
