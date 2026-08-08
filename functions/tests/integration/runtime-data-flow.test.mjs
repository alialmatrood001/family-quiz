import assert from "node:assert/strict";
import test from "node:test";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";
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
  const startedAt = performance.now();
  const response = await invokeApi(SERVER_OPERATIONS[operation].endpoint, {
    token,
    action: operation,
    data,
  });
  const elapsedMs = performance.now() - startedAt;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error(response.body?.error?.message || "request failed"), {
      code: response.body?.error?.code,
      status: response.statusCode,
      elapsedMs,
    });
  }
  return { data: response.body.data, elapsedMs };
}

test("an acknowledged answer survives a near-simultaneous reveal/finalize race", { timeout: 90_000 }, async (t) => {
  const roomId = "runtime-data-flow-race";
  const questionId = "race-q1";
  const [admin, player] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "runtime-race-admin" }),
    createEmulatorIdentity({ label: "runtime-race-player" }),
  ]);
  const [adminToken, playerToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(player),
  ]);
  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, player].map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  await call("initializeQuiz", { roomId }, adminToken);
  await call("controlQuizLifecycle", { roomId, action: "open-registration" }, adminToken);
  const registration = await call("registerPlayer", {
    roomId,
    name: "Race Player",
    emoji: "R",
    fullName: "Private Race Player",
    phone: "0500012345",
  }, playerToken);
  await roomRef(roomId).collection("questions").doc(questionId).set({
    text: "Race",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
    order: 1,
  });
  await call("controlQuizLifecycle", { roomId, action: "start-competition" }, adminToken);
  await call("prepareQuestion", { roomId, questionId, questionIndex: 0 }, adminToken);
  await call("startQuestion", { roomId, questionId }, adminToken);

  const submitPromise = call("submitAnswer", {
    roomId,
    questionId,
    playerId: registration.data.playerId,
    selectedIndex: 0,
  }, playerToken);
  const finalizePromise = (async () => {
    await call("controlQuestion", { roomId, questionId, action: "reveal" }, adminToken);
    return call("finalizeQuestion", { roomId, questionId }, adminToken);
  })();
  const [submit, finalize] = await Promise.allSettled([submitPromise, finalizePromise]);
  assert.equal(finalize.status, "fulfilled");

  const result = (await roomRef(roomId).collection("questionResults").doc(questionId).get()).data();
  const row = result.results.find((item) => item.playerId === registration.data.playerId);
  if (submit.status === "fulfilled") {
    assert.equal(submit.value.data.status, "received");
    assert.equal(row.answered, true, "a server-acknowledged answer must be in the official result");
  } else {
    assert.ok(["failed-precondition", "not-found"].includes(submit.reason.code));
    assert.equal(row.answered, false, "a request closed before acknowledgment must not be shown as accepted");
  }
  assert.equal((await roomRef(roomId).collection("answers").get()).size, row.answered ? 1 : 0);
  emitMetric("runtime.race.submit", submit.status === "fulfilled" ? submit.value.elapsedMs : submit.reason.elapsedMs);
  emitMetric("runtime.race.finalize", finalize.value.elapsedMs);
});
