import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
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
    const error = new Error(response.body?.error?.message || "Smoke request failed");
    error.code = response.body?.error?.code;
    error.status = response.statusCode;
    throw error;
  }
  return response.body.data;
}

test("mocked Staging release completes the admin and player contest lifecycle", { timeout: 120_000 }, async (t) => {
  const roomId = "staging-release-smoke";
  const questionId = "staging-release-question";
  const [admin, player, nonAdmin] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "release-smoke-admin" }),
    createEmulatorIdentity({ label: "release-smoke-player" }),
    createEmulatorIdentity({ label: "release-smoke-non-admin" }),
  ]);
  const [adminToken, playerToken, nonAdminToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(player),
    signInEmulatorIdentity(nonAdmin),
  ]);
  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, player, nonAdmin].map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  await assert.rejects(
    call("initializeQuiz", { roomId }, nonAdminToken),
    (error) => error.status === 403 && error.code === "permission-denied",
  );
  await assert.rejects(
    call("initializeQuiz", { roomId, uid: admin.uid }, adminToken),
    (error) => error.status === 400 && error.code === "invalid-argument",
  );

  assert.equal((await call("initializeQuiz", { roomId }, adminToken)).status, "created");
  assert.equal(
    (await call("controlQuizLifecycle", { roomId, action: "open-registration" }, adminToken)).status,
    "open-registration",
  );
  const room = roomRef(roomId);
  await room.collection("questions").doc(questionId).set({
    text: "Staging release smoke",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });

  const registration = await call("registerPlayer", {
    roomId,
    name: "Release Player",
    emoji: "R",
    fullName: "Release Private Name",
    phone: "0500000991",
  }, playerToken);
  assert.equal(registration.status, "registered");
  const playerId = registration.playerId;
  assert.equal((await call("recoverPlayer", { roomId }, playerToken)).playerId, playerId);
  const firstJoker = await call(
    "activateJoker",
    { roomId, questionId: "next", playerId },
    playerToken,
  );
  const repeatedJoker = await call(
    "activateJoker",
    { roomId, questionId: "next", playerId },
    playerToken,
  );
  assert.equal(firstJoker.status, "pending");
  assert.equal(repeatedJoker.status, "already-pending");

  await call("controlQuizLifecycle", { roomId, action: "start-competition" }, adminToken);
  await call("prepareQuestion", { roomId, questionId, questionIndex: 0 }, adminToken);
  await call("startQuestion", { roomId, questionId }, adminToken);
  assert.equal(
    (await call("submitAnswer", { roomId, questionId, playerId, selectedIndex: 0 }, playerToken)).status,
    "received",
  );
  await assert.rejects(
    call("submitAnswer", { roomId, questionId, playerId, selectedIndex: 1 }, playerToken),
    (error) => error.status === 409 && error.code === "already-exists",
  );
  await call("controlQuestion", { roomId, questionId, action: "reveal" }, adminToken);
  assert.equal((await call("finalizeQuestion", { roomId, questionId }, adminToken)).status, "finalized");
  assert.equal(
    (await call("finalizeQuestion", { roomId, questionId }, adminToken)).status,
    "already-finalized",
  );
  await call(
    "controlQuizLifecycle",
    { roomId, action: "begin-final-countdown" },
    adminToken,
  );
  assert.equal((await call("finishQuiz", { roomId }, adminToken)).status, "finished");
  assert.equal((await call("finishQuiz", { roomId }, adminToken)).status, "already-finished");

  const [finishedRoom, publicPlayer, privatePlayer, answers] = await Promise.all([
    room.get(),
    room.collection("players").doc(playerId).get(),
    room.collection("playerPrivate").doc(playerId).get(),
    room.collection("answers").get(),
  ]);
  assert.equal(finishedRoom.data().stage, "finished");
  assert.equal(finishedRoom.data().gameHistory.length, 1);
  assert.equal(finishedRoom.data().gameHistory[0].answers[0].isCorrect, true);
  assert.ok(finishedRoom.data().gameHistory[0].answers[0].points > 0);
  assert.deepEqual(finishedRoom.data().gameHistory[0].questions[0].options, ["A", "B"]);
  assert.equal(answers.size, 1);
  const publicText = JSON.stringify({
    player: publicPlayer.data(),
    history: finishedRoom.data().gameHistory,
  });
  for (const privateValue of ["0500000991", "Release Private Name", player.uid]) {
    assert.equal(publicText.includes(privateValue), false);
  }
  assert.equal(privatePlayer.data().authUid, player.uid);
});

test("critical Staging lifecycle functions do not perform browser-side privileged writes", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  for (const functionName of [
    "returnToRegistrationKeepingPlayers",
    "showInstructionsPage",
    "resetAndStartRegistration",
    "beginFinalCountdown",
    "finishGame",
  ]) {
    const start = source.indexOf(`async function ${functionName}`);
    const next = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.ok(start >= 0, `${functionName} must exist`);
    assert.doesNotMatch(body, /\b(setDoc|updateDoc|runTransaction|deleteDoc|addDoc)\s*\(/);
  }
});
