import assert from "node:assert/strict";
import test from "node:test";
import {
  callCallable,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const roomId = "operation10-vercel-load";

function endpointFor(action) {
  if (["prepareQuestion", "startQuestion", "controlQuestion", "finalizeQuestion"].includes(action)) {
    return "quiz";
  }
  return "player";
}

async function vercelCall(action, data, token) {
  const result = await invokeApi(endpointFor(action), { token, action, data });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const error = new Error(`${action} failed: ${result.body?.error?.code}`);
    error.result = result;
    throw error;
  }
  return result.body.data;
}

test("local Vercel transport handles 50 and 100 player competition loads", { timeout: 300_000 }, async (t) => {
  const admin = await createEmulatorIdentity({ admin: true, label: "operation10-load-admin" });
  const identities = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      createEmulatorIdentity({ label: `operation10-load-${index + 1}` }),
    ),
  );
  const [adminToken, ...tokens] = await Promise.all([
    signInEmulatorIdentity(admin),
    ...identities.map(signInEmulatorIdentity),
  ]);
  const room = roomRef(roomId);
  const playerIds = [];

  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, ...identities].map((identity) => deleteEmulatorIdentity(identity.uid)));
  });

  await room.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });

  const registrationStartedAt = performance.now();
  for (let offset = 0; offset < 100; offset += 10) {
    const registrations = await Promise.all(
      identities.slice(offset, offset + 10).map((_identity, index) => {
        const number = offset + index + 1;
        return vercelCall(
          "registerPlayer",
          {
            roomId,
            name: `Load Player ${number}`,
            emoji: "LP",
            fullName: `Load Private ${number}`,
            phone: `056${String(number).padStart(7, "0")}`,
          },
          tokens[number - 1],
        );
      }),
    );
    playerIds.push(...registrations.map((registration) => registration.playerId));
  }
  const registrationMs = performance.now() - registrationStartedAt;
  assert.equal((await room.collection("players").get()).size, 100);
  assert.equal((await room.collection("playerPrivate").get()).size, 100);

  const metrics = [];
  for (const [runIndex, playerCount] of [50, 100].entries()) {
    const questionId = `vercel-load-${playerCount}`;
    await room.collection("questions").doc(questionId).set({
      text: `Vercel load ${playerCount}`,
      options: ["A", "B", "C", "D"],
      correctIndex: 1,
      maxPoints: 1000,
      minPoints: 100,
      seconds: 120,
      answerRevealDelaySeconds: 0,
    });

    const jokerStart = runIndex === 0 ? 0 : 10;
    const jokerCount = 10;
    await Promise.all(
      Array.from({ length: jokerCount }, (_, index) => {
        const playerIndex = jokerStart + index;
        return vercelCall(
          "activateJoker",
          { roomId, questionId: "next", playerId: playerIds[playerIndex] },
          tokens[playerIndex],
        );
      }),
    );

    await vercelCall(
      "prepareQuestion",
      { roomId, questionId, questionIndex: runIndex },
      adminToken,
    );
    await vercelCall("startQuestion", { roomId, questionId }, adminToken);

    const answersStartedAt = performance.now();
    const settled = await Promise.allSettled(
      Array.from({ length: playerCount }, (_, index) =>
        vercelCall(
          "submitAnswer",
          {
            roomId,
            questionId,
            playerId: playerIds[index],
            selectedIndex: index % 4,
          },
          tokens[index],
        ),
      ),
    );
    const answersMs = performance.now() - answersStartedAt;
    const errors = settled.filter((entry) => entry.status === "rejected");
    assert.equal(errors.length, 0);
    assert.equal(
      (await room.collection("answers").where("questionId", "==", questionId).get()).size,
      playerCount,
    );

    await vercelCall("controlQuestion", { roomId, questionId, action: "reveal" }, adminToken);
    const finalizeStartedAt = performance.now();
    const finalized = await vercelCall("finalizeQuestion", { roomId, questionId }, adminToken);
    const finalizeMs = performance.now() - finalizeStartedAt;
    const repeated = await vercelCall("finalizeQuestion", { roomId, questionId }, adminToken);
    assert.equal(finalized.status, "finalized");
    assert.equal(repeated.status, "already-finalized");
    assert.equal(finalized.runId, repeated.runId);
    assert.equal(finalized.counts.players, 100);
    assert.equal(finalized.counts.validAnswers, playerCount);
    assert.equal(finalized.counts.jokerApplied, jokerCount);

    metrics.push({
      transport: "vercel",
      playerCount,
      registrationMs: runIndex === 0 ? registrationMs : 0,
      answersMs,
      finalizeMs,
      errors: 0,
      timeouts: 0,
      answersCounted: finalized.counts.validAnswers,
      jokerConsumed: finalized.counts.jokerApplied,
      resultPlayers: finalized.counts.players,
    });
  }

  console.log(`OPERATION10_LOAD ${JSON.stringify(metrics)}`);
});

test("callable load harness contract remains available for the same demo emulator", async () => {
  assert.equal(typeof callCallable, "function");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-family-quiz");
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});
