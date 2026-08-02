import assert from "node:assert/strict";
import test from "node:test";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";
import {
  callCallable,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

function normalizedCallableCode(error) {
  return String(error?.body?.error?.status || error?.code || "internal")
    .toLowerCase()
    .replaceAll("_", "-");
}

test("all eighteen operations share stable error semantics across callable and Vercel", { timeout: 120_000 }, async (t) => {
  const [admin, player] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "operation10-parity-admin" }),
    createEmulatorIdentity({ label: "operation10-parity-player" }),
  ]);
  const [adminToken, playerToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(player),
  ]);
  t.after(() => Promise.all([admin, player].map((identity) => deleteEmulatorIdentity(identity.uid))));

  const rows = [];
  for (const [operation, definition] of Object.entries(SERVER_OPERATIONS)) {
    const adminOperation = definition.endpoint !== "player";
    const token = adminOperation ? adminToken : playerToken;
    let callableCode;
    try {
      await callCallable(operation, {}, { token });
      callableCode = "success";
    } catch (error) {
      callableCode = normalizedCallableCode(error);
    }
    const vercel = await invokeApi(definition.endpoint, {
      token,
      action: operation,
      data: {},
    });
    const vercelCode =
      vercel.statusCode >= 200 && vercel.statusCode < 300
        ? "success"
        : vercel.body.error.code;
    assert.equal(vercelCode, callableCode, operation);
    rows.push({ operation, callable: callableCode, vercel: vercelCode });
  }
  assert.equal(rows.length, 18);
  console.log(`OPERATION10_PARITY ${JSON.stringify(rows)}`);
});

async function invokeTransport(transport, operation, data, token, endpoint) {
  if (transport === "callable") return callCallable(operation, data, { token, timeoutMs: 45_000 });
  const result = await invokeApi(endpoint, { token, action: operation, data });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`${transport}:${operation}:${result.body?.error?.code}`);
  }
  return result.body.data;
}

async function runSuccessScenario(transport, { adminToken, playerToken }) {
  const roomId = `operation10-parity-success-${transport}`;
  const practiceRoomId = `${roomId}-practice`;
  const questionId = "parity-question";
  const room = roomRef(roomId);
  await room.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  await room.collection("questions").doc(questionId).set({
    text: "Parity success",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });
  const call = (operation, data, role = "player") =>
    invokeTransport(
      transport,
      operation,
      data,
      role === "admin" ? adminToken : playerToken,
      role === "admin"
        ? SERVER_OPERATIONS[operation].endpoint
        : SERVER_OPERATIONS[operation].endpoint,
    );

  const statuses = {};
  statuses.initializeQuiz = (
    await call("initializeQuiz", { roomId }, "admin")
  ).status;
  statuses.controlQuizLifecycle = (
    await call(
      "controlQuizLifecycle",
      { roomId, action: "open-registration" },
      "admin",
    )
  ).status;
  const registration = await call("registerPlayer", {
    roomId,
    name: "Parity Player",
    emoji: "PP",
    fullName: "Parity Private",
    phone: "0570000010",
  });
  statuses.registerPlayer = registration.status;
  const playerId = registration.playerId;
  statuses.recoverPlayer = (await call("recoverPlayer", { roomId })).status;
  statuses.updatePlayerProfile = (
    await call("updatePlayerProfile", { roomId, playerId, name: "Parity Updated", emoji: "PU" })
  ).status;
  statuses.activateJoker = (
    await call("activateJoker", { roomId, questionId: "next", playerId })
  ).status;
  statuses.cancelJoker = (await call("cancelJoker", { roomId, playerId })).status;
  statuses.prepareQuestion = (
    await call("prepareQuestion", { roomId, questionId, questionIndex: 0 }, "admin")
  ).status;
  statuses.startQuestion = (
    await call("startQuestion", { roomId, questionId }, "admin")
  ).status;
  statuses.submitAnswer = (
    await call("submitAnswer", { roomId, questionId, playerId, selectedIndex: 0 })
  ).status;
  statuses.controlQuestion = (
    await call("controlQuestion", { roomId, questionId, action: "reveal" }, "admin")
  ).status;
  const finalized = await call("finalizeQuestion", { roomId, questionId }, "admin");
  statuses.finalizeQuestion = finalized.status;
  statuses.finishQuiz = (
    await call("finishQuiz", { roomId }, "admin")
  ).status;
  statuses.adjustPlayerScore = (
    await call(
      "adjustPlayerScore",
      { roomId, playerId, delta: 10, reason: "operation10 parity" },
      "admin",
    )
  ).status;
  const details = await call(
    "getPlayerPrivateDetails",
    { roomId, playerId },
    "admin",
  );
  statuses.getPlayerPrivateDetails = details.status;
  const adminUpdate = await call(
    "updatePlayerProfile",
    { roomId, playerId, name: "Parity Admin Updated" },
    "admin",
  );
  assert.equal(adminUpdate.status, "updated");

  const practiceRoom = roomRef(practiceRoomId);
  await practiceRoom.set({ stage: "practiceComplete", acceptingAnswers: false });
  statuses.resetPracticeScores = (
    await call(
      "resetPracticeScores",
      { roomId: practiceRoomId, reason: "operation10 parity" },
      "admin",
    )
  ).status;

  const [publicBeforeDelete, privateBeforeDelete, resultDocument] = await Promise.all([
    room.collection("players").doc(playerId).get(),
    room.collection("playerPrivate").doc(playerId).get(),
    room.collection("questionResults").doc(questionId).get(),
  ]);
  statuses.deletePlayer = (
    await call(
      "deletePlayer",
      { roomId, playerId, reason: "operation10 parity" },
      "admin",
    )
  ).status;
  statuses.resetQuizData = (
    await call(
      "resetQuizData",
      { roomId, mode: "full", reason: "operation10 parity" },
      "admin",
    )
  ).status;

  const publicData = publicBeforeDelete.data();
  const privateData = privateBeforeDelete.data();
  const resultData = resultDocument.data();
  await Promise.all([deleteRoom(roomId), deleteRoom(practiceRoomId)]);
  return {
    statuses,
    score: publicData.score,
    rank: publicData.rank,
    jokerUsed: publicData.jokerUsed,
    finalCounts: resultData.counts,
    publicPrivateFields: [
      "phone",
      "phoneNormalized",
      "fullName",
      "authUid",
      "recoveryNameNormalized",
    ].filter((field) => Object.hasOwn(publicData, field)),
    privateHasIdentity: Boolean(
      privateData.phoneNormalized && privateData.fullName && privateData.authUid,
    ),
    deletedAfterScenario: !(await room.collection("players").doc(playerId).get()).exists,
  };
}

test("all eighteen operations complete the same logical success scenario on both transports", { timeout: 180_000 }, async (t) => {
  const [admin, player] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "operation10-success-admin" }),
    createEmulatorIdentity({ label: "operation10-success-player" }),
  ]);
  const [adminToken, playerToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(player),
  ]);
  t.after(() => Promise.all([admin, player].map((identity) => deleteEmulatorIdentity(identity.uid))));
  const callable = await runSuccessScenario("callable", { adminToken, playerToken });
  const vercel = await runSuccessScenario("vercel", { adminToken, playerToken });
  assert.deepEqual(
    { ...vercel, score: "server-time-dependent" },
    { ...callable, score: "server-time-dependent" },
  );
  assert.ok(callable.score >= 110 && callable.score <= 1010);
  assert.ok(vercel.score >= 110 && vercel.score <= 1010);
  assert.ok(Math.abs(callable.score - vercel.score) <= 50);
  assert.equal(Object.keys(callable.statuses).length, 18);
  assert.deepEqual(callable.publicPrivateFields, []);
  assert.equal(callable.privateHasIdentity, true);
  assert.equal(callable.deletedAfterScenario, true);
  console.log(`OPERATION10_SUCCESS_PARITY ${JSON.stringify({ callable, vercel })}`);
});
