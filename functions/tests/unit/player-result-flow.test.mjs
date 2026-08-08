import assert from "node:assert/strict";
import test from "node:test";
import {
  createUiSingleFlightGate,
  percentile,
  resolvePlayerQuestionResult,
} from "../../../src/player-question-result.js";

const resultState = (results) => ({
  loading: false,
  exists: true,
  result: { questionId: "q1", results },
});

test("the canonical result distinguishes correct, wrong, and unanswered players", () => {
  const results = [
    { playerId: "p1", answered: true, selectedIndex: 0, isCorrect: true, basePoints: 500, awardedPoints: 1000, jokerApplied: true, jokerMultiplier: 2, rank: 1, responseTimeMs: 250 },
    { playerId: "p2", answered: true, selectedIndex: 1, isCorrect: false, basePoints: 0, awardedPoints: 0, rank: 2 },
    { playerId: "p3", answered: false, selectedIndex: null, isCorrect: null, awardedPoints: 0, rank: 3 },
  ];
  const p1 = resolvePlayerQuestionResult({ playerId: "p1", questionId: "q1", officialResultState: resultState(results) });
  const p2 = resolvePlayerQuestionResult({ playerId: "p2", questionId: "q1", officialResultState: resultState(results) });
  const p3 = resolvePlayerQuestionResult({ playerId: "p3", questionId: "q1", officialResultState: resultState(results) });
  assert.deepEqual({ answered: p1.answered, correct: p1.isCorrect, points: p1.points, rank: p1.rank }, { answered: true, correct: true, points: 1000, rank: 1 });
  assert.deepEqual({ answered: p2.answered, correct: p2.isCorrect }, { answered: true, correct: false });
  assert.equal(p3.answered, false);
});

test("a confirmed answer is never labelled unanswered while the official listener is pending", () => {
  const resolution = resolvePlayerQuestionResult({
    playerId: "p1",
    questionId: "q1",
    officialResultState: { loading: true, exists: false, result: null },
    roomSnapshot: { questionId: "q1", answeredByPlayer: {} },
    confirmedAnswer: { playerId: "p1", questionId: "q1", selectedIndex: 0 },
  });
  assert.equal(resolution.status, "loading");
  assert.equal(resolution.answered, true);
});

test("canonical rows override an incomplete compatibility snapshot", () => {
  const resolution = resolvePlayerQuestionResult({
    playerId: "p1",
    questionId: "q1",
    officialResultState: resultState([{ playerId: "p1", answered: true, isCorrect: true, points: 10 }]),
    roomSnapshot: { questionId: "q1", answeredByPlayer: {} },
  });
  assert.equal(resolution.source, "official-result");
  assert.equal(resolution.answered, true);
});

test("the UI single-flight gate gives immediate feedback and blocks a slow double click", async () => {
  const gate = createUiSingleFlightGate();
  assert.equal(gate.tryStart(), true);
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.tryStart(), false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  gate.finish();
  assert.equal(gate.tryStart(), true);
});

test("performance diagnostics calculate median and p95 without brittle thresholds", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(values, 0.5), 50);
  assert.equal(percentile(values, 0.95), 100);
});
