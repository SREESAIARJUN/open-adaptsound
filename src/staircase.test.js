import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStaircase, answerStaircase } from "./staircase.js";

describe("staircase", () => {
  it("gets quieter after Yes and louder after No", () => {
    const s = createStaircase({ startLevel: 0.3, startStep: 0.1, reversalsNeeded: 99, maxTrials: 99 });
    const a = answerStaircase(s, true);
    assert.ok(a.level < 0.3);
    const b = answerStaircase(s, false);
    assert.ok(b.level > a.level);
  });

  it("finishes after enough reversals with a threshold", () => {
    const s = createStaircase({
      startLevel: 0.3,
      startStep: 0.08,
      minStep: 0.02,
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
      startLevel: 0.05,
      startStep: 0.05,
      minLevel: 0.002,
      reversalsNeeded: 10,
      maxTrials: 30,
    });
    let guard = 0;
    while (!s.done && guard < 30) {
      answerStaircase(s, true);
      guard++;
    }
    assert.equal(s.done, true);
    assert.ok(s.threshold <= 0.01);
  });

  it("marks max threshold when never heard", () => {
    const s = createStaircase({
      startLevel: 0.5,
      startStep: 0.2,
      maxLevel: 1,
      reversalsNeeded: 10,
      maxTrials: 20,
    });
    let guard = 0;
    while (!s.done && guard < 20) {
      answerStaircase(s, false);
      guard++;
    }
    assert.equal(s.done, true);
    assert.equal(s.threshold, 1);
  });
});
