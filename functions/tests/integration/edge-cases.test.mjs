import assert from "node:assert/strict";
import test from "node:test";
import {
  callFinalizeQuestion,
  deleteRoom,
  playerMap,
  readState,
  roomRef,
  writeScenario,
} from "../helpers/emulator.mjs";
import { buildScenario } from "../fixtures/scenarios.mjs";

test("missing room is currently created and finalized instead of rejected", { timeout: 30_000 }, async (t) => {
  const roomId = "edge-missing-room";
  t.after(() => deleteRoom(roomId));
  await deleteRoom(roomId);
  const result = await callFinalizeQuestion({ roomId, questionId: "missing-room-question" });
  const state = await readState(roomId);
  assert.deepEqual(result, { success: true, skipped: false });
  assert.equal(state.roomExists, true);
  assert.equal(state.room.processedQuestionId, "missing-room-question");
});

test("missing questionId is currently exposed to callers only as INTERNAL", { timeout: 30_000 }, async () => {
  await assert.rejects(
    () => callFinalizeQuestion({ roomId: "edge-missing-question-id", questionId: undefined }),
    /INTERNAL/
  );
});

test("unknown question ID in an existing room is currently accepted", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-unknown-question",
    playerCount: 2,
    correctCount: 0,
    wrongCount: 0,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  const result = await callFinalizeQuestion({
    roomId: scenario.roomId,
    questionId: "not-the-current-question",
  });
  assert.deepEqual(result, { success: true, skipped: false });
});

test("no answers finishes safely and preserves all scores", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-no-answers",
    playerCount: 4,
    correctCount: 0,
    wrongCount: 0,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.deepEqual(
    state.players.map((player) => player.score).sort((a, b) => a - b),
    scenario.players.map((player) => player.score).sort((a, b) => a - b)
  );
  assert.equal(state.room.questionResultsById[scenario.questionId].answersCount, 0);
});

test("orphan answer does not crash and is present in result maps", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-orphan-answer",
    playerCount: 2,
    correctCount: 1,
    wrongCount: 0,
  });
  scenario.answers.push({
    id: "orphan-answer",
    playerId: "missing-player",
    questionId: scenario.questionId,
    selectedIndex: 1,
    points: 777,
    isCorrect: true,
    answeredAt: 1_800_000_015_000,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  const result = state.room.questionResultsById[scenario.questionId];
  assert.equal(state.players.length, 2);
  assert.equal(result.answersCount, 2);
  assert.equal(result.bonusByPlayer["missing-player"], 777);
});

test("later duplicate answer wins while both documents are counted", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-duplicate-answer",
    playerCount: 1,
    correctCount: 1,
    wrongCount: 0,
  });
  const player = scenario.players[0];
  scenario.answers[0] = {
    ...scenario.answers[0],
    id: "duplicate-early",
    answeredAt: 1_800_000_001_000,
    points: 100,
  };
  scenario.answers.push({
    ...scenario.answers[0],
    id: "duplicate-late",
    answeredAt: 1_800_000_002_000,
    points: 900,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.equal(playerMap(state.players).get(player.id).score, player.score + 900);
  assert.equal(state.room.questionResultsById[scenario.questionId].answersCount, 2);
});

test("client-supplied absurd points are currently trusted", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-untrusted-points",
    playerCount: 1,
    correctCount: 1,
    wrongCount: 0,
  });
  scenario.answers[0].points = 99_999_999;
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.equal(state.players[0].score, scenario.players[0].score + 99_999_999);
});

test("missing optional answer fields become zero/false", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-missing-fields",
    playerCount: 1,
    correctCount: 0,
    wrongCount: 0,
  });
  scenario.answers.push({
    id: "minimal-answer",
    playerId: scenario.players[0].id,
    questionId: scenario.questionId,
    selectedIndex: 0,
    answeredAt: 1_800_000_001_000,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.equal(state.players[0].lastQuestionPoints, 0);
  assert.equal(state.players[0].lastQuestionCorrect, false);
});

test("invalid selectedIndex is ignored", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-invalid-index",
    playerCount: 1,
    correctCount: 0,
    wrongCount: 0,
  });
  scenario.answers.push({
    id: "invalid-index-answer",
    playerId: scenario.players[0].id,
    questionId: scenario.questionId,
    selectedIndex: -1,
    points: 500,
    isCorrect: true,
    answeredAt: 1_800_000_001_000,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.equal(state.room.questionResultsById[scenario.questionId].answersCount, 0);
  assert.equal(state.players[0].score, scenario.players[0].score);
});

test("invalid joker multiplier is labeled x3 and its supplied points remain trusted", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-invalid-joker",
    playerCount: 1,
    correctCount: 1,
    wrongCount: 0,
  });
  scenario.answers[0].jokerApplied = true;
  scenario.answers[0].jokerMultiplier = 99;
  scenario.answers[0].points = 12_345;
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  const result = state.room.questionResultsById[scenario.questionId];
  assert.equal(result.jokerByPlayer[scenario.players[0].id], "x3");
  assert.equal(state.players[0].score, scenario.players[0].score + 12_345);
});

test("callable currently accepts an unauthenticated request", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-no-auth",
    playerCount: 1,
    correctCount: 0,
    wrongCount: 0,
  });
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  const result = await callFinalizeQuestion(scenario, { includeAuth: false });
  assert.deepEqual(result, { success: true, skipped: false });
});

test("writing a new result currently replaces prior questionResultsById entries", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-result-history",
    playerCount: 1,
    correctCount: 0,
    wrongCount: 0,
  });
  scenario.room.questionResultsById = { "previous-question": { questionId: "previous-question" } };
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  await callFinalizeQuestion(scenario);
  const state = await readState(scenario.roomId);
  assert.equal(state.room.questionResultsById["previous-question"], undefined);
  assert.ok(state.room.questionResultsById[scenario.questionId]);
});

test("a fresh processing lock returns the current busy response", { timeout: 30_000 }, async (t) => {
  const scenario = buildScenario({
    roomId: "edge-fresh-lock",
    playerCount: 1,
    correctCount: 0,
    wrongCount: 0,
  });
  scenario.room.processingQuestionId = scenario.questionId;
  scenario.room.processingStartedAtMs = Date.now();
  t.after(() => deleteRoom(scenario.roomId));
  await writeScenario(scenario);
  const result = await callFinalizeQuestion(scenario);
  assert.deepEqual(result, {
    success: false,
    skipped: true,
    reason: "already-processed-or-busy",
  });
});

test("test cleanup removes its synthetic room", { timeout: 30_000 }, async () => {
  const roomId = "edge-cleanup-proof";
  await roomRef(roomId).set({ synthetic: true });
  await deleteRoom(roomId);
  assert.equal((await roomRef(roomId).get()).exists, false);
});
