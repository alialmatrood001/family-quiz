import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  callFinalizeQuestion,
  deleteRoom,
  readState,
  roomRef,
  writeScenario,
} from "../helpers/emulator.mjs";
import { buildScenario, calculateBasePoints } from "../fixtures/scenarios.mjs";

async function expectCallableError(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("unauthenticated caller is rejected", async () => {
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: "auth-room", questionId: "auth-question" }, { authRole: "none" }),
    "UNAUTHENTICATED"
  );
});

test("authenticated non-admin caller is rejected", async () => {
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: "auth-room", questionId: "auth-question" }, { authRole: "user" }),
    "PERMISSION_DENIED"
  );
});

test("invalid and unexpected callable inputs are rejected", async () => {
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: "../bad", questionId: "q" }),
    "INVALID_ARGUMENT"
  );
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: "safe", questionId: "q", points: 999 }),
    "INVALID_ARGUMENT"
  );
});

test("missing room is rejected", async () => {
  const roomId = "edge-missing-room";
  await deleteRoom(roomId);
  await expectCallableError(
    () => callFinalizeQuestion({ roomId, questionId: "missing-question" }),
    "NOT_FOUND"
  );
});

test("unknown or inactive question is rejected", async (t) => {
  const scenario = buildScenario({ roomId: "edge-inactive", playerCount: 1, correctCount: 0, wrongCount: 0 });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: scenario.roomId, questionId: "other-question" }),
    "NOT_FOUND"
  );
  await roomRef(scenario.roomId).update({ stage: "lobby" });
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId }),
    "FAILED_PRECONDITION"
  );
});

test("server ignores client points and isCorrect", async (t) => {
  const scenario = buildScenario({ roomId: "edge-client-trust", playerCount: 1, correctCount: 1, wrongCount: 0 });
  scenario.answers[0].points = 99_999_999;
  scenario.answers[0].isCorrect = false;
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  const answer = scenario.answers[0];
  const expectedBase = calculateBasePoints({ elapsedSeconds: answer.answerTimeSeconds });
  const expected = scenario.players[0].jokerMultiplier
    ? expectedBase * scenario.players[0].jokerMultiplier
    : expectedBase;
  assert.equal(state.players[0].score, scenario.players[0].score + expected);
  assert.equal(state.results[0].results[0].isCorrect, true);
});

test("earliest valid server-timestamped duplicate wins", async (t) => {
  const scenario = buildScenario({ roomId: "edge-duplicate", playerCount: 1, correctCount: 0, wrongCount: 0 });
  const player = scenario.players[0];
  scenario.answers.push(
    {
      id: "answer-late",
      playerId: player.id,
      questionId: scenario.questionId,
      selectedIndex: 0,
      createdAtMs: scenario.question.answerStartAtMs + 5_000,
      points: 999_999,
      isCorrect: false,
    },
    {
      id: "answer-early",
      playerId: player.id,
      questionId: scenario.questionId,
      selectedIndex: 1,
      createdAtMs: scenario.question.answerStartAtMs + 1_000,
      points: -999_999,
      isCorrect: false,
    }
  );
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.equal(state.results[0].counts.duplicateAnswerCount, 1);
  assert.equal(state.results[0].results[0].selectedIndex, 1);
  assert.equal(state.results[0].results[0].isCorrect, true);
});

test("orphan and malformed answers are diagnostic only", async (t) => {
  const scenario = buildScenario({ roomId: "edge-diagnostics", playerCount: 1, correctCount: 0, wrongCount: 0 });
  scenario.answers.push(
    {
      id: "orphan",
      playerId: "missing-player",
      questionId: scenario.questionId,
      selectedIndex: 1,
      createdAtMs: scenario.question.answerStartAtMs + 1_000,
    },
    {
      id: "malformed",
      playerId: scenario.players[0].id,
      questionId: scenario.questionId,
      selectedIndex: -1,
      createdAtMs: scenario.question.answerStartAtMs + 1_000,
    }
  );
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.equal(state.players.length, 1);
  assert.equal(state.results[0].counts.orphanAnswerCount, 1);
  assert.equal(state.results[0].counts.invalidAnswerCount, 1);
  assert.equal(state.results[0].counts.validAnswers, 0);
});

test("no answers finalizes every player with zero question points", async (t) => {
  const scenario = buildScenario({ roomId: "edge-no-answers", playerCount: 4, correctCount: 0, wrongCount: 0 });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.deepEqual(
    state.players.map((player) => player.score).sort((a, b) => a - b),
    scenario.players.map((player) => player.score).sort((a, b) => a - b)
  );
  assert.equal(state.results[0].counts.unanswered, 4);
});

test("invalid official joker is ignored instead of becoming x3", async (t) => {
  const scenario = buildScenario({ roomId: "edge-invalid-joker", playerCount: 1, correctCount: 1, wrongCount: 0 });
  scenario.players[0].jokerUsed = true;
  scenario.players[0].jokerQuestionId = scenario.questionId;
  scenario.players[0].jokerTiming = "before";
  scenario.players[0].jokerMultiplier = 99;
  scenario.players[0].jokerLockedAtMs = scenario.question.answerStartAtMs - 1_000;
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.equal(state.results[0].counts.invalidJoker, 1);
  assert.equal(state.results[0].results[0].jokerApplied, false);
  assert.equal(state.results[0].results[0].points, state.results[0].results[0].basePoints);
});

test("previous result documents and compatibility map entries are preserved", async (t) => {
  const scenario = buildScenario({ roomId: "edge-history", playerCount: 1, correctCount: 0, wrongCount: 0 });
  scenario.room.questionResultsById = { "previous-question": { questionId: "previous-question" } };
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await roomRef(scenario.roomId).collection("questionResults").doc("previous-question").set({
    questionId: "previous-question",
    runId: "previous-run",
  });
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.ok(state.room.questionResultsById["previous-question"]);
  assert.ok(state.room.questionResultsById[scenario.questionId]);
  assert.equal(state.results.length, 2);
});

test("fresh lock aborts and stale lock is recoverable", async (t) => {
  const scenario = buildScenario({ roomId: "edge-lock", playerCount: 1, correctCount: 0, wrongCount: 0 });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await roomRef(scenario.roomId).update({
    finalization: {
      status: "processing",
      questionId: scenario.questionId,
      startedAtMs: Date.now(),
      runId: "fresh-run",
    },
  });
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId }),
    "ABORTED"
  );
  await roomRef(scenario.roomId).update({ "finalization.startedAtMs": Date.now() - 60_000 });
  const result = await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  assert.equal(result.status, "finalized");
});

test("post-claim failure records a recoverable failed state without partial scores", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-atomic-limit",
    playerCount: 401,
    correctCount: 0,
    wrongCount: 0,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await expectCallableError(
    () => callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId }),
    "FAILED_PRECONDITION"
  );
  const state = await readState(scenario.roomId);
  assert.equal(state.room.finalization.status, "failed");
  assert.equal(state.room.processingQuestionId, null);
  assert.equal(state.results.length, 0);
  assert.deepEqual(
    state.players.map((player) => player.score).sort((a, b) => a - b),
    scenario.players.map((player) => player.score).sort((a, b) => a - b)
  );
});

test("answer without a server timestamp is ignored", async (t) => {
  const scenario = buildScenario({ roomId: "edge-no-server-time", playerCount: 1, correctCount: 0, wrongCount: 0 });
  scenario.answers.push({
    id: "client-time-only",
    playerId: scenario.players[0].id,
    questionId: scenario.questionId,
    selectedIndex: 1,
    answeredAt: scenario.question.answerStartAtMs + 1_000,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion({ roomId: scenario.roomId, questionId: scenario.questionId });
  const state = await readState(scenario.roomId);
  assert.equal(state.results[0].counts.invalidAnswerCount, 1);
  assert.equal(state.players[0].score, scenario.players[0].score);
});

test("cleanup removes official result documents", async () => {
  const roomId = "edge-cleanup";
  await roomRef(roomId).set({ synthetic: true });
  await roomRef(roomId).collection("questionResults").doc("q").set({
    finalizedAt: Timestamp.now(),
  });
  await deleteRoom(roomId);
  assert.equal((await roomRef(roomId).get()).exists, false);
});
