import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStaircase, answerStaircase, STAIR_DEFAULTS } from "./staircase.js";

describe("staircase (dB HL domain)", () => {
  it("gets quieter after Yes and louder after No", () => {
    const s = createStaircase({ startLevel: 35, startStep: 10, reversalsNeeded: 99, maxTrials: 99 });
    const a = answerStaircase(s, true);
    assert.ok(a.level < 35);
    const b = answerStaircase(s, false);
    assert.ok(b.level > a.level);
  });

  it("finishes after enough reversals with a threshold", () => {
    const s = createStaircase({
      startLevel: 35,
      startStep: 10,
      minStep: 2.5,
      reversalsNeeded: 4,
      maxTrials: 40,
    });
    // Alternate yes/no to force reversals around the threshold
    let heard = true;
    let guard = 0;
    while (!s.done && guard < 40) {
      answerStaircase(s, heard);
      heard = !heard;
      guard++;
    }
    assert.equal(s.done, true);
    assert.ok(s.threshold != null);
    assert.ok(s.threshold >= s.cfg.minLevel && s.threshold <= s.cfg.maxLevel);
  });

  it("marks excellent hearing when always yes down to floor", () => {
    const s = createStaircase({
      startLevel: 20,
      startStep: 10,
      minLevel: -10,
      reversalsNeeded: 10,
      maxTrials: 30,
    });
    let guard = 0;
    while (!s.done && guard < 30) {
      answerStaircase(s, true);
      guard++;
    }
    assert.equal(s.done, true);
    assert.equal(s.threshold, -10);
  });

  it("marks max threshold when never heard", () => {
    const s = createStaircase({
      startLevel: 35,
      startStep: 10,
      maxLevel: 70,
      reversalsNeeded: 10,
      maxTrials: 20,
    });
    let guard = 0;
    while (!s.done && guard < 20) {
      answerStaircase(s, false);
      guard++;
    }
    assert.equal(s.done, true);
    assert.equal(s.threshold, 70);
  });

  it("simulated listener converges near their true threshold", () => {
    // Listener hears anything at or above 22 dB HL
    const TRUE_THRESHOLD = 22;
    const s = createStaircase();
    let guard = 0;
    while (!s.done && guard < STAIR_DEFAULTS.maxTrials + 2) {
      answerStaircase(s, s.level >= TRUE_THRESHOLD);
      guard++;
    }
    assert.equal(s.done, true);
    assert.ok(
      Math.abs(s.threshold - TRUE_THRESHOLD) <= 8,
      `threshold ${s.threshold} should be within 8 dB of ${TRUE_THRESHOLD}`
    );
  });
});
