import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDisplaySnapshotFromOfficialResult } from "../../../src/display-official-result.js";
import {
  isQuizStageTransitionAllowed,
  nextDisplayPreview,
  previousDisplayPreview,
  publicPlayerDisplayName,
  QUIZ_STAGES,
  runHandledUiAction,
} from "../../../src/quiz-state-machine.js";

test("official-result fallback renders public names, points, and ranking", () => {
  const snapshot = buildDisplaySnapshotFromOfficialResult({
    questionId: "q2",
    players: [
      { id: "p1", displayName: "Public One", fullName: "Private One", phone: "0500000001", authUid: "uid-1" },
      { id: "p2", name: "Public Two", fullName: "Private Two", phone: "0500000002", authUid: "uid-2" },
    ],
    officialResult: {
      questionId: "q2",
      results: [
        { playerId: "p1", answered: true, isCorrect: true, points: 40, scoreBefore: 10, scoreAfter: 50, rankMovement: 1 },
        { playerId: "p2", answered: true, isCorrect: false, points: 0, scoreBefore: 30, scoreAfter: 30, rankMovement: -1 },
      ],
    },
  });
  assert.deepEqual(snapshot.leaderboardAfter.map(({ name, score }) => ({ name, score })), [
    { name: "Public One", score: 50 },
    { name: "Public Two", score: 30 },
  ]);
  assert.deepEqual(snapshot.leaderboardAfter.map((player, index) => ({ name: player.name, rank: index + 1 })), [
    { name: "Public One", rank: 1 },
    { name: "Public Two", rank: 2 },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("Private One"), false);
  assert.equal(JSON.stringify(snapshot).includes("0500000001"), false);
  assert.equal(JSON.stringify(snapshot).includes("uid-1"), false);
  assert.equal(publicPlayerDisplayName({ displayName: "Visible", name: "Legacy" }), "Visible");
});

test("the central state map validates the core quiz lifecycle", () => {
  const lifecycle = [
    QUIZ_STAGES.HOME,
    QUIZ_STAGES.REGISTRATION,
    QUIZ_STAGES.INSTRUCTIONS,
    QUIZ_STAGES.READY,
    QUIZ_STAGES.QUESTION,
    QUIZ_STAGES.REVEAL,
    QUIZ_STAGES.RESULTS,
    QUIZ_STAGES.FINAL_COUNTDOWN,
    QUIZ_STAGES.FINISHED,
  ];
  for (let index = 1; index < lifecycle.length; index += 1) {
    assert.equal(isQuizStageTransitionAllowed(lifecycle[index - 1], lifecycle[index]), true);
  }
  assert.equal(isQuizStageTransitionAllowed(QUIZ_STAGES.QUESTION, QUIZ_STAGES.RESULTS), false);
  assert.equal(isQuizStageTransitionAllowed(QUIZ_STAGES.FINISHED, QUIZ_STAGES.QUESTION), false);
});

test("DisplayView previous, next, and return-to-live navigation remains deterministic", () => {
  assert.deepEqual(previousDisplayPreview({
    displayStage: QUIZ_STAGES.RESULTS,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: QUIZ_STAGES.REVEAL, questionIndex: 1 });
  assert.deepEqual(previousDisplayPreview({
    displayStage: QUIZ_STAGES.QUESTION,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: QUIZ_STAGES.RESULTS, questionIndex: 0 });
  assert.deepEqual(nextDisplayPreview({
    liveStage: QUIZ_STAGES.RESULTS,
    previewStage: QUIZ_STAGES.REVEAL,
    displayStage: QUIZ_STAGES.REVEAL,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: null, questionIndex: null });
});

test("operational button failures are caught instead of becoming unhandled promises", async () => {
  const expected = Object.assign(new Error("failed"), { code: "failed-precondition" });
  let captured;
  assert.equal(await runHandledUiAction(async () => { throw expected; }, (error) => { captured = error; }), false);
  assert.equal(captured, expected);
});

test("the real Admin and Display wiring uses safe handlers and local-only display controls", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /async function handleAdvanceFromDashboardClick\(\)/);
  assert.match(source, /onClick=\{handleAdvanceFromDashboardClick\}/);
  assert.doesNotMatch(source, /onClick=\{advanceFromDashboard\}/);
  assert.match(source, />\s*العرض الحالي\s*</);
  assert.match(source, /"نتائج السؤال الأخير"/);
  assert.match(source, /enabled:\s*initialView !== "display"/);
});
