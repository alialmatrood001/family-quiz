import assert from "node:assert/strict";
import test from "node:test";
import {
  callCallable,
  callFinalizeQuestion,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";

test("staging smoke flow runs only on emulators with public/private player isolation", { timeout: 60_000 }, async (t) => {
  const roomId = "operation7-staging-smoke";
  const questionId = "staging-smoke-question";
  const [admin, first, second] = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "staging-smoke-admin" }),
    createEmulatorIdentity({ label: "staging-smoke-first" }),
    createEmulatorIdentity({ label: "staging-smoke-second" }),
  ]);
  const [adminToken, firstToken, secondToken] = await Promise.all([
    signInEmulatorIdentity(admin),
    signInEmulatorIdentity(first),
    signInEmulatorIdentity(second),
  ]);
  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, first, second].map(({ uid }) => deleteEmulatorIdentity(uid)));
  });

  const ref = roomRef(roomId);
  await ref.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  await ref.collection("questions").doc(questionId).set({
    text: "Staging smoke question",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });
  const firstRegistration = await callCallable(
    "registerPlayer",
    {
      roomId,
      name: "Smoke One",
      emoji: "1️⃣",
      fullName: "Smoke Private One",
      phone: "0500000401",
    },
    { token: firstToken }
  );
  const secondRegistration = await callCallable(
    "registerPlayer",
    {
      roomId,
      name: "Smoke Two",
      emoji: "2️⃣",
      fullName: "Smoke Private Two",
      phone: "0500000402",
    },
    { token: secondToken }
  );
  await callCallable(
    "activateJoker",
    { roomId, questionId: "next", playerId: firstRegistration.playerId },
    { token: firstToken }
  );
  await callCallable(
    "prepareQuestion",
    { roomId, questionId, questionIndex: 0 },
    { token: adminToken }
  );
  await callCallable("startQuestion", { roomId, questionId }, { token: adminToken });
  await Promise.all([
    callCallable(
      "submitAnswer",
      { roomId, questionId, playerId: firstRegistration.playerId, selectedIndex: 0 },
      { token: firstToken }
    ),
    callCallable(
      "submitAnswer",
      { roomId, questionId, playerId: secondRegistration.playerId, selectedIndex: 1 },
      { token: secondToken }
    ),
  ]);
  await callCallable(
    "controlQuestion",
    { roomId, questionId, action: "reveal" },
    { token: adminToken }
  );
  await callFinalizeQuestion({ roomId, questionId });
  await callCallable(
    "adjustPlayerScore",
    {
      roomId,
      playerId: secondRegistration.playerId,
      delta: 10,
      reason: "اختبار Staging المحلي",
    },
    { token: adminToken }
  );

  const [result, room, audit, publicPlayers] = await Promise.all([
    ref.collection("questionResults").doc(questionId).get(),
    ref.get(),
    ref.collection("auditLogs").get(),
    ref.collection("players").get(),
  ]);
  assert.equal(result.exists, true);
  assert.equal(result.data().results.length, 2);
  const publicText = JSON.stringify(publicPlayers.docs.map((document) => document.data()));
  const resultText = JSON.stringify(result.data());
  const roomText = JSON.stringify(room.data().resultsDisplaySnapshot);
  const auditText = JSON.stringify(audit.docs.map((document) => document.data()));
  for (const privateValue of [
    "0500000401",
    "0500000402",
    "Smoke Private One",
    "Smoke Private Two",
    first.uid,
    second.uid,
  ]) {
    assert.equal(publicText.includes(privateValue), false);
    assert.equal(resultText.includes(privateValue), false);
    assert.equal(roomText.includes(privateValue), false);
    assert.equal(auditText.includes(privateValue), false);
  }
});
