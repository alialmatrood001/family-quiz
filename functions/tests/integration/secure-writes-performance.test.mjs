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
  const playerIds = [];
  const registrationMetrics = [];
  for (const [start, end] of [[0, 50], [50, 100]]) {
    const registrationStartedAt = performance.now();
    for (let offset = start; offset < end; offset += 10) {
      const registrations = await Promise.all(
        identities.slice(offset, offset + 10).map((identity, index) => {
          const number = offset + index + 1;
          return callCallable(
            "registerPlayer",
            {
              roomId,
              name: `Player ${number}`,
              emoji: "⭐",
              fullName: `Private Player ${number}`,
              phone: `05${String(number).padStart(8, "0")}`,
            },
            { token: tokens[number - 1], timeoutMs: 45_000 }
          );
        })
      );
      playerIds.push(...registrations.map((registration) => registration.playerId));
    }
    registrationMetrics.push({
      totalPlayers: end,
      elapsedMs: performance.now() - registrationStartedAt,
    });
  }
  assert.equal((await ref.collection("players").get()).size, 100);
  assert.equal((await ref.collection("playerPrivate").get()).size, 100);
  registrationMetrics.forEach((metric) =>
    emitMetric(`operation7.registration.to-${metric.totalPlayers}`, metric.elapsedMs)
  );
  const leaderboardStartedAt = performance.now();
  const leaderboardSnapshot = await ref.collection("players").orderBy("score", "desc").get();
  const leaderboardReadMs = performance.now() - leaderboardStartedAt;
  const publicBytes = Buffer.byteLength(JSON.stringify(leaderboardSnapshot.docs[0].data()));
  const privateBytes = Buffer.byteLength(
    JSON.stringify((await ref.collection("playerPrivate").doc(playerIds[0]).get()).data())
  );
  emitMetric("operation7.leaderboard.100", leaderboardReadMs);
  emitMetric("operation7.public-document.approx", publicBytes, "bytes");
  emitMetric("operation7.private-document.approx", privateBytes, "bytes");

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
    const jokerStartedAt = performance.now();
    await callCallable(
      "activateJoker",
      { roomId, questionId: "next", playerId: playerIds[runIndex] },
      { token: tokens[runIndex] }
    );
    const jokerMs = performance.now() - jokerStartedAt;
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
            playerId: playerIds[index],
            selectedIndex: index % 4,
          },
          { token: tokens[index], timeoutMs: 45_000 }
        )
      )
    );
    const answersMs = performance.now() - answersStartedAt;
    assert.equal((await ref.collection("answers").where("questionId", "==", questionId).get()).size, playerCount);

    const endStartedAt = performance.now();
    await callCallable(
      "controlQuestion",
      { roomId, questionId, action: "reveal" },
      { token: adminToken }
    );
    const endMs = performance.now() - endStartedAt;
    const finalizeStartedAt = performance.now();
    await callFinalizeQuestion({ roomId, questionId }, { timeoutMs: 60_000 });
    const finalizeMs = performance.now() - finalizeStartedAt;
    const totalMs = performance.now() - flowStartedAt;
    metrics.push({ playerCount, run: runIndex + 1, jokerMs, startMs, answersMs, endMs, finalizeMs, totalMs });
    emitMetric(`operation6.joker.${playerCount}.run${runIndex + 1}`, jokerMs);
    emitMetric(`operation6.start.${playerCount}.run${runIndex + 1}`, startMs);
    emitMetric(`operation6.answers.${playerCount}.run${runIndex + 1}`, answersMs);
    emitMetric(`operation6.end.${playerCount}.run${runIndex + 1}`, endMs);
    emitMetric(`operation6.finalize.${playerCount}.run${runIndex + 1}`, finalizeMs);
    emitMetric(`operation6.total.${playerCount}.run${runIndex + 1}`, totalMs);
  }
  console.log(
    `OPERATION7_PERFORMANCE_SUMMARY ${JSON.stringify({
      registrationMetrics,
      leaderboardReadMs,
      publicBytes,
      privateBytes,
      flowMetrics: metrics,
    })}`
  );
});
