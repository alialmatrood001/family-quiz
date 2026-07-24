import assert from "node:assert/strict";
import test from "node:test";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  callCallable,
  callFinalizeQuestion,
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";

const roomId = "operation6-secure-flow";
const questionId = "secure-question-01";

test(
  "secure callable flow enforces identity, server time, idempotency, joker and audit",
  { timeout: 60_000 },
  async (t) => {
    const [admin, firstIdentity, secondIdentity, thirdIdentity] = await Promise.all([
      createEmulatorIdentity({ admin: true, label: "operation6-admin" }),
      createEmulatorIdentity({ label: "operation6-player-1" }),
      createEmulatorIdentity({ label: "operation6-player-2" }),
      createEmulatorIdentity({ label: "operation6-player-3" }),
    ]);
    const [adminToken, firstToken, secondToken, thirdToken] = await Promise.all([
      signInEmulatorIdentity(admin),
      signInEmulatorIdentity(firstIdentity),
      signInEmulatorIdentity(secondIdentity),
      signInEmulatorIdentity(thirdIdentity),
    ]);
    t.after(async () => {
      await deleteRoom(roomId);
      await Promise.all(
        [admin, firstIdentity, secondIdentity, thirdIdentity].map((identity) =>
          deleteEmulatorIdentity(identity.uid)
        )
      );
    });

    const ref = roomRef(roomId);
    await ref.set({
      stage: "registration",
      currentQuestion: null,
      acceptingAnswers: false,
      activeQuestionId: null,
    });
    await ref.collection("questions").doc(questionId).set({
      text: "Server-owned question",
      options: ["A", "B", "C"],
      correctIndex: 1,
      maxPoints: 1000,
      minPoints: 100,
      seconds: 20,
      answerRevealDelaySeconds: 0,
    });

    const register = (token, name, phone) =>
      callCallable(
        "registerPlayer",
        { roomId, name, emoji: "⭐", fullName: `${name} Full`, phone },
        { token }
      );
    const [firstRegistration, secondRegistration, thirdRegistration] = await Promise.all([
      register(firstToken, "Player One", "0500000001"),
      register(secondToken, "Player Two", "0500000002"),
      register(thirdToken, "Player Three", "0500000003"),
    ]);
    const playerOne = firstRegistration.playerId;
    const playerTwo = secondRegistration.playerId;
    const playerThree = thirdRegistration.playerId;
    const [publicPlayer, privatePlayer] = await Promise.all([
      ref.collection("players").doc(playerOne).get(),
      ref.collection("playerPrivate").doc(playerOne).get(),
    ]);
    assert.equal(publicPlayer.data().authUid, undefined);
    assert.equal(publicPlayer.data().fullName, undefined);
    assert.equal(publicPlayer.data().phone, undefined);
    assert.equal(publicPlayer.data().phoneNormalized, undefined);
    assert.equal(privatePlayer.data().authUid, firstIdentity.uid);
    assert.equal(privatePlayer.data().phoneNormalized, "0500000001");
    const recovered = await callCallable("recoverPlayer", { roomId }, { token: firstToken });
    assert.equal(recovered.playerId, playerOne);
    assert.equal(recovered.player.fullName, undefined);
    assert.equal(recovered.player.phone, undefined);

    await assert.rejects(
      callCallable("submitAnswer", {
        roomId,
        questionId,
        playerId: playerOne,
        selectedIndex: 1,
      }),
      (error) => error.code === "UNAUTHENTICATED"
    );
    const pendingJoker = await callCallable(
      "activateJoker",
      { roomId, questionId: "next", playerId: playerOne },
      { token: firstToken }
    );
    assert.equal(pendingJoker.multiplier, 3);
    const cancelledJoker = await callCallable(
      "cancelJoker",
      { roomId, playerId: playerOne },
      { token: firstToken }
    );
    assert.equal(cancelledJoker.status, "cancelled");

    await assert.rejects(
      callCallable("startQuestion", { roomId, questionId }, { token: firstToken }),
      (error) => error.code === "PERMISSION_DENIED"
    );
    await callCallable(
      "prepareQuestion",
      { roomId, questionId, questionIndex: 0 },
      { token: adminToken }
    );
    const prepared = (await ref.get()).data();
    assert.equal(prepared.currentQuestion.correctIndex, undefined);

    const started = await callCallable(
      "startQuestion",
      { roomId, questionId },
      { token: adminToken }
    );
    const startedAgain = await callCallable(
      "startQuestion",
      { roomId, questionId },
      { token: adminToken }
    );
    assert.equal(started.status, "started");
    assert.equal(startedAgain.status, "already-started");
    assert.equal(started.questionStartedAtMs, startedAgain.questionStartedAtMs);
    await ref.collection("questionSecrets").doc("different-question").set({
      questionId: "different-question",
      correctIndex: 0,
      maxPoints: 1000,
      minPoints: 100,
      seconds: 20,
      answerStartAtMs: started.questionStartedAtMs,
      answerEndAtMs: started.questionStartedAtMs + 20_000,
    });
    await assert.rejects(
      callCallable(
        "startQuestion",
        { roomId, questionId: "different-question" },
        { token: adminToken }
      ),
      (error) => error.code === "FAILED_PRECONDITION"
    );

    const joker = await callCallable(
      "activateJoker",
      { roomId, questionId, playerId: playerOne },
      { token: firstToken }
    );
    assert.equal(joker.multiplier, 2);
    await assert.rejects(
      callCallable("cancelJoker", { roomId, playerId: playerOne }, { token: firstToken }),
      (error) => error.code === "FAILED_PRECONDITION"
    );
    await assert.rejects(
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerOne, selectedIndex: 1, points: 9999 },
        { token: firstToken }
      ),
      (error) => error.code === "INVALID_ARGUMENT"
    );
    await assert.rejects(
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerTwo, selectedIndex: 1 },
        { token: firstToken }
      ),
      (error) => error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerTwo, selectedIndex: 99 },
        { token: secondToken }
      ),
      (error) => error.code === "INVALID_ARGUMENT"
    );

    const concurrent = await Promise.allSettled([
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerOne, selectedIndex: 1 },
        { token: firstToken }
      ),
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerOne, selectedIndex: 0 },
        { token: firstToken }
      ),
    ]);
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(
      concurrent.filter(
        (item) => item.status === "rejected" && item.reason.code === "ALREADY_EXISTS"
      ).length,
      1
    );
    await callCallable(
      "submitAnswer",
      { roomId, questionId, playerId: playerTwo, selectedIndex: 0 },
      { token: secondToken }
    );
    const answers = await ref.collection("answers").get();
    assert.equal(answers.size, 2);
    for (const answer of answers.docs.map((item) => item.data())) {
      assert.ok(answer.createdAt?.toMillis() >= started.questionStartedAtMs);
      assert.equal(answer.points, undefined);
      assert.equal(answer.isCorrect, undefined);
    }

    await callCallable(
      "controlQuestion",
      { roomId, questionId, action: "reveal" },
      { token: adminToken }
    );
    await assert.rejects(
      callCallable(
        "submitAnswer",
        { roomId, questionId, playerId: playerThree, selectedIndex: 1 },
        { token: thirdToken }
      ),
      (error) => error.code === "FAILED_PRECONDITION"
    );
    await callFinalizeQuestion({ roomId, questionId });
    const finalState = (await ref.get()).data();
    assert.equal(finalState.stage, "results");
    assert.equal(finalState.currentQuestion.correctIndex, 1);

    const beforeScore = (await ref.collection("players").doc(playerTwo).get()).data().score;
    await assert.rejects(
      callCallable(
        "adjustPlayerScore",
        { roomId, playerId: playerTwo, delta: 75, reason: "غير مصرح" },
        { token: firstToken }
      ),
      (error) => error.code === "PERMISSION_DENIED"
    );
    const adjusted = await callCallable(
      "adjustPlayerScore",
      { roomId, playerId: playerTwo, delta: 75, reason: "تصحيح نتيجة موثق" },
      { token: adminToken }
    );
    assert.equal(adjusted.afterPoints, beforeScore + 75);
    await Promise.all([
      callCallable(
        "adjustPlayerScore",
        { roomId, playerId: playerTwo, delta: 30, reason: "تعديل متزامن أول" },
        { token: adminToken }
      ),
      callCallable(
        "adjustPlayerScore",
        { roomId, playerId: playerTwo, delta: 45, reason: "تعديل متزامن ثان" },
        { token: adminToken }
      ),
    ]);
    assert.equal(
      (await ref.collection("players").doc(playerTwo).get()).data().score,
      beforeScore + 150
    );
    const audit = await ref.collection("auditLogs").get();
    assert.ok(audit.docs.some((item) => item.data().type === "adjust-player-score"));
  }
);

test("Firestore rules reject direct sensitive writes", { timeout: 30_000 }, async (t) => {
  const identity = await createEmulatorIdentity({ label: "operation6-rules-player" });
  const app = initializeApp(
    {
      apiKey: "demo-api-key",
      authDomain: "demo-family-quiz.firebaseapp.com",
      projectId: "demo-family-quiz",
    },
    `operation6-rules-${Date.now()}`
  );
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  const firestore = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  await signInWithEmailAndPassword(auth, identity.email, identity.password);
  const rulesRoomId = "operation6-rules";
  const rulesRoom = roomRef(rulesRoomId);
  await rulesRoom.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  await rulesRoom.collection("players").doc("owner").set({
    name: "Owner",
    score: 0,
  });
  await rulesRoom.collection("playerPrivate").doc("owner").set({
    authUid: identity.uid,
    fullName: "Private Owner",
    phoneNormalized: "0500000099",
  });
  await rulesRoom.collection("questionSecrets").doc("q1").set({ correctIndex: 1 });

  t.after(async () => {
    await deleteApp(app);
    await deleteRoom(rulesRoomId);
    await deleteEmulatorIdentity(identity.uid);
  });

  await assert.rejects(
    setDoc(doc(firestore, "rooms", rulesRoomId, "answers", "q1_owner"), {
      playerId: "owner",
      questionId: "q1",
      selectedIndex: 1,
    }),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    updateDoc(doc(firestore, "rooms", rulesRoomId, "players", "owner"), { score: 9999 }),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    updateDoc(doc(firestore, "rooms", rulesRoomId), {
      stage: "question",
      acceptingAnswers: true,
    }),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    getDoc(doc(firestore, "rooms", rulesRoomId, "questionSecrets", "q1")),
    (error) => error.code === "permission-denied"
  );
  await assert.rejects(
    updateDoc(doc(firestore, "rooms", rulesRoomId, "players", "owner"), {
      name: "Owner Updated",
    }),
    (error) => error.code === "permission-denied"
  );
});
