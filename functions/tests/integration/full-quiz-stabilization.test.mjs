import assert from "node:assert/strict";
import test from "node:test";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";
import { buildDisplaySnapshotFromOfficialResult } from "../../../src/display-official-result.js";
import { createQuizLiveOperations } from "../../../src/quiz-live-operations-core.js";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  emitMetric,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

async function call(operation, data, token) {
  const response = await invokeApi(SERVER_OPERATIONS[operation].endpoint, {
    token,
    action: operation,
    data,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = Object.assign(new Error(response.body?.error?.message || "Quiz request failed"), {
      code: response.body?.error?.code,
      status: response.statusCode,
    });
    throw error;
  }
  return response.body.data;
}

test("Admin Control, controlled Display, and three Players complete two questions and finish without state drift", { timeout: 120_000 }, async (t) => {
  const roomId = "full-quiz-stabilization";
  const questionIds = ["stabilization-q1", "stabilization-q2"];
  const identities = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "stabilization-admin" }),
    createEmulatorIdentity({ label: "stabilization-player-1" }),
    createEmulatorIdentity({ label: "stabilization-player-2" }),
    createEmulatorIdentity({ label: "stabilization-player-3" }),
  ]);
  const tokens = await Promise.all(identities.map(signInEmulatorIdentity));
  const [adminToken, ...playerTokens] = tokens;
  const displayControls = createQuizLiveOperations({
    controlLifecycle: (data) => call("controlQuizLifecycle", data, adminToken),
    finishQuiz: (data) => call("finishQuiz", data, adminToken),
    resetQuizData: (data) => call("resetQuizData", data, adminToken),
    resetPracticeScores: (data) => call("resetPracticeScores", data, adminToken),
    prepareQuestion: (data) => call("prepareQuestion", data, adminToken),
    startQuestion: (data) => call("startQuestion", data, adminToken),
    controlQuestion: (data) => call("controlQuestion", data, adminToken),
  });
  const measure = async (name, action) => {
    const startedAt = performance.now();
    const value = await action();
    emitMetric(`runtime.3.${name}`, performance.now() - startedAt);
    return value;
  };
  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all(identities.map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  assert.equal((await call("initializeQuiz", { roomId }, adminToken)).status, "created");
  assert.equal((await displayControls.resetAndOpenRegistration(roomId)).status, "open-registration");
  const ref = roomRef(roomId);
  await Promise.all(questionIds.map((questionId, index) => ref.collection("questions").doc(questionId).set({
    text: `Stabilization question ${index + 1}`,
    options: ["A", "B", "C"],
    correctIndex: index,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
    order: index + 1,
  })));

  const registrations = await Promise.all(playerTokens.map((token, index) => call("registerPlayer", {
    roomId,
    name: `Public Player ${index + 1}`,
    emoji: String(index + 1),
    fullName: `Private Player ${index + 1}`,
    phone: `05000008${String(index + 1).padStart(2, "0")}`,
  }, token)));
  assert.equal(new Set(registrations.map((registration) => registration.playerId)).size, 3);

  await displayControls.startCompetition(roomId);
  const scoresAfterQuestions = [];
  for (let questionIndex = 0; questionIndex < questionIds.length; questionIndex += 1) {
    const questionId = questionIds[questionIndex];
    if (questionIndex === 1) {
      assert.equal((await measure("activateJoker", () => call("activateJoker", {
        roomId,
        questionId: "next",
        playerId: registrations[0].playerId,
      }, playerTokens[0]))).status, "pending");
    }
    await displayControls.prepareQuestion({ roomId, questionId, questionIndex });
    await measure("startQuestion", () => displayControls.startQuestion({ roomId, questionId }));
    const answeringPlayers = questionIndex === 0 ? registrations.slice(0, 2) : registrations;
    await measure("submitAnswer.batch", () => Promise.all(answeringPlayers.map((registration, playerIndex) => call("submitAnswer", {
      roomId,
      questionId,
      playerId: registration.playerId,
      selectedIndex: playerIndex === 2 ? 2 : questionIndex,
    }, playerTokens[playerIndex]))));
    await measure("endQuestion", () => displayControls.revealQuestion({ roomId, questionId }));
    assert.equal((await measure("finalizeQuestion", () => call("finalizeQuestion", { roomId, questionId }, adminToken))).status, "finalized");
    assert.equal((await call("finalizeQuestion", { roomId, questionId }, adminToken)).status, "already-finalized");

    const [resultDocument, publicPlayers] = await Promise.all([
      ref.collection("questionResults").doc(questionId).get(),
      ref.collection("players").get(),
    ]);
    assert.equal(resultDocument.exists, true);
    const canonicalRows = resultDocument.data().results;
    assert.equal(canonicalRows.every((row) => typeof row.publicDisplayName === "string" && row.publicDisplayName.length > 0), true);
    assert.equal(canonicalRows.every((row) => Object.hasOwn(row, "awardedPoints") && Object.hasOwn(row, "rank") && Object.hasOwn(row, "responseTimeMs")), true);
    if (questionIndex === 0) {
      assert.equal(canonicalRows.find((row) => row.playerId === registrations[0].playerId).answered, true);
      assert.equal(canonicalRows.find((row) => row.playerId === registrations[1].playerId).answered, true);
      assert.equal(canonicalRows.find((row) => row.playerId === registrations[2].playerId).answered, false);
    }
    const publicPlayerRows = publicPlayers.docs.map((document) => ({ id: document.id, ...document.data() }));
    const display = buildDisplaySnapshotFromOfficialResult({
      questionId,
      officialResult: resultDocument.data(),
      players: publicPlayerRows,
    });
    assert.deepEqual(display.leaderboardAfter.map((player) => player.name).sort(), [
      "Public Player 1",
      "Public Player 2",
      "Public Player 3",
    ]);
    assert.equal(display.leaderboardAfter.every((player) => Number.isFinite(player.score)), true);
    assert.deepEqual(display.leaderboardAfter.map((player, index) => index + 1), [1, 2, 3]);
    scoresAfterQuestions.push(Object.fromEntries(publicPlayerRows.map((player) => [player.id, player.score])));
    for (let playerIndex = 0; playerIndex < registrations.length; playerIndex += 1) {
      assert.equal((await call("recoverPlayer", { roomId }, playerTokens[playerIndex])).playerId, registrations[playerIndex].playerId);
    }
  }

  assert.notDeepEqual(scoresAfterQuestions[0], scoresAfterQuestions[1]);
  const firstPlayerAfter = await ref.collection("players").doc(registrations[0].playerId).get();
  assert.equal(firstPlayerAfter.data().jokerUsed, true);
  assert.equal(firstPlayerAfter.data().jokerQuestionId, questionIds[1]);
  const secondResult = (await ref.collection("questionResults").doc(questionIds[1]).get()).data();
  assert.equal(secondResult.results.find((row) => row.playerId === registrations[0].playerId).jokerApplied, true);

  await displayControls.beginFinalCountdown(roomId);
  assert.equal((await displayControls.finishQuiz(roomId)).status, "finished");
  assert.equal((await displayControls.finishQuiz(roomId)).status, "already-finished");
  const finished = (await ref.get()).data();
  assert.equal(finished.stage, "finished");
  assert.equal(finished.gameHistory.length, 1);
  assert.deepEqual(finished.gameHistory[0].players.slice(0, 3).map((player) => player.rank), [1, 2, 3]);
  const publicText = JSON.stringify({
    players: finished.gameHistory[0].players,
    results: await Promise.all(questionIds.map(async (id) => (await ref.collection("questionResults").doc(id).get()).data())),
  });
  for (const hidden of ["Private Player 1", "Private Player 2", "Private Player 3", identities[1].uid]) {
    assert.equal(publicText.includes(hidden), false);
  }
});
