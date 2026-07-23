const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateBasePoints,
  calculateQuestionPoints,
} = require("../../finalize-question/calculate-points");

const scoring = {
  maxPoints: 1000,
  minPoints: 100,
  seconds: 20,
  answerStartAtMs: 1_000_000,
};

test("base points preserve the current linear and clamped formula", () => {
  assert.equal(calculateBasePoints({ ...scoring, answeredAtMs: 1_000_000 }), 1000);
  assert.equal(calculateBasePoints({ ...scoring, answeredAtMs: 1_010_000 }), 550);
  assert.equal(calculateBasePoints({ ...scoring, answeredAtMs: 1_020_000 }), 100);
  assert.equal(calculateBasePoints({ ...scoring, answeredAtMs: 1_030_000 }), 100);
});

test("correct and wrong answers without a joker preserve current scoring", () => {
  assert.deepEqual(
    calculateQuestionPoints({ ...scoring, answeredAtMs: 1_010_000, isCorrect: true }),
    { basePoints: 550, points: 550 }
  );
  assert.deepEqual(
    calculateQuestionPoints({ ...scoring, answeredAtMs: 1_010_000, isCorrect: false }),
    { basePoints: 550, points: 0 }
  );
});

test("official x2/x3 jokers multiply correct answers and only subtract base on wrong answers", () => {
  assert.equal(
    calculateQuestionPoints({
      ...scoring,
      answeredAtMs: 1_010_000,
      isCorrect: true,
      jokerMultiplier: 2,
    }).points,
    1100
  );
  assert.equal(
    calculateQuestionPoints({
      ...scoring,
      answeredAtMs: 1_010_000,
      isCorrect: true,
      jokerMultiplier: 3,
    }).points,
    1650
  );
  assert.equal(
    calculateQuestionPoints({
      ...scoring,
      answeredAtMs: 1_010_000,
      isCorrect: false,
      jokerMultiplier: 3,
    }).points,
    -550
  );
});
