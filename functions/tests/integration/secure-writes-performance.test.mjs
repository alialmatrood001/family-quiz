import assert from "node:assert/strict";
import test from "node:test";
import {
  callCallable,
  callFinalizeQuestion,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  emitMetric,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";

test("official secure flow handles 50 players three times and 100 players once", { timeout: 240_000 }, async (t) => {
  const roomId = "operation6-performance";
  const admin = await createEmulatorIdentity({ admin: true, label: "operation6-perf-admin" });
  const identities = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      createEmulatorIdentity({ label: `operation6-perf-${index + 1}` })
    )
  );
  const [adminToken, ...tokens] = await Promise.all([
    signInEmulatorIdentity(admin),
    ...identities.map(signInEmulatorIdentity),
  ]);
  const ref = roomRef(roomId);

  t.after(async () => {
    await deleteRoom(roomId);
    await Promise.all([admin, ...identities].map((identity) => deleteEmulatorIdentity(identity.uid)));
  });

  await ref.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  for (let offset = 0; offset < identities.length; offset += 400) {
    const batch = ref.firestore.batch();
    identities.slice(offset, offset + 400).forEach((identity, index) => {
      const number = offset + index + 1;
      batch.set(ref.collection("players").doc(`player-${number}`), {
        authUid: identity.uid,
        name: `Player ${number}`,
        score: 0,
        answeredCount: 0,
        pendingJoker: number <= 10,
        jokerUsed: false,
      });
    });
    await batch.commit();
  }

  const runs = [50, 50, 50, 100];
  const metrics = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const playerCount = runs[runIndex];
    const questionId = `performance-q-${runIndex + 1}`;
    await ref.collection("questions").doc(questionId).set({
      text: `Performance question ${runIndex + 1}`,
      options: ["A", "B", "C", "D"],
      correctIndex: 1,
      maxPoints: 1000,
      minPoints: 100,
      seconds: 120,
      answerRevealDelaySeconds: 0,
    });

    const flowStartedAt = performance.now();
    const startStartedAt = performance.now();
    await callCallable(
      "prepareQuestion",
      { roomId, questionId, questionIndex: runIndex },
      { token: adminToken }
    );
    await callCallable("startQuestion", { roomId, questionId }, { token: adminToken });
    const startMs = performance.now() - startStartedAt;

    const answersStartedAt = performance.now();
    await Promise.all(
      Array.from({ length: playerCount }, (_, index) =>
        callCallable(
          "submitAnswer",
          {
            roomId,
            questionId,
            playerId: `player-${index + 1}`,
            selectedIndex: index % 4,
          },
          { token: tokens[index], timeoutMs: 45_000 }
        )
      )
    );
    const answersMs = performance.now() - answersStartedAt;
    assert.equal((await ref.collection("answers").where("questionId", "==", questionId).get()).size, playerCount);

    await callCallable(
      "controlQuestion",
      { roomId, questionId, action: "reveal" },
      { token: adminToken }
    );
    const finalizeStartedAt = performance.now();
    await callFinalizeQuestion({ roomId, questionId }, { timeoutMs: 60_000 });
    const finalizeMs = performance.now() - finalizeStartedAt;
    const totalMs = performance.now() - flowStartedAt;
    metrics.push({ playerCount, run: runIndex + 1, startMs, answersMs, finalizeMs, totalMs });
    emitMetric(`operation6.start.${playerCount}.run${runIndex + 1}`, startMs);
    emitMetric(`operation6.answers.${playerCount}.run${runIndex + 1}`, answersMs);
    emitMetric(`operation6.finalize.${playerCount}.run${runIndex + 1}`, finalizeMs);
    emitMetric(`operation6.total.${playerCount}.run${runIndex + 1}`, totalMs);
  }
  console.log(`OPERATION6_PERFORMANCE_SUMMARY ${JSON.stringify(metrics)}`);
});
