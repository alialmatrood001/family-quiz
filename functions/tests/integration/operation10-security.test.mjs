import assert from "node:assert/strict";
import test from "node:test";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  createEmulatorIdentity,
  deleteEmulatorIdentity,
  deleteRoom,
  roomRef,
  signInEmulatorIdentity,
} from "../helpers/emulator.mjs";
import { invokeApi } from "../helpers/local-vercel-api.mjs";

const roomId = "operation10-security";
const questionId = "security-question";

async function register(token, number) {
  return invokeApi("player", {
    token,
    action: "registerPlayer",
    data: {
      roomId,
      name: `Security Player ${number}`,
      emoji: `S${number}`,
      fullName: `Sensitive Name ${number}`,
      phone: `05510000${String(number).padStart(2, "0")}`,
    },
  });
}

test("Operation 10 identity, claim, privacy, timing and concurrency controls", { timeout: 180_000 }, async (t) => {
  const identities = await Promise.all([
    createEmulatorIdentity({ admin: true, label: "operation10-admin" }),
    createEmulatorIdentity({ label: "operation10-player-a" }),
    createEmulatorIdentity({ label: "operation10-player-b" }),
    createEmulatorIdentity({ label: "admin-email-without-claim" }),
    createEmulatorIdentity({ label: "operation10-admin-false" }),
    createEmulatorIdentity({ label: "operation10-unregistered" }),
  ]);
  await getAuth(getApps()[0]).setCustomUserClaims(identities[4].uid, { admin: false });
  const tokens = await Promise.all(identities.map(signInEmulatorIdentity));
  const [adminToken, tokenA, tokenB, adminEmailToken, adminFalseToken, unregisteredToken] = tokens;
  const room = roomRef(roomId);

  t.after(async () => {
    await deleteRoom(roomId);
    await deleteRoom(`${roomId}-admin-reset`);
    await Promise.all(identities.map((identity) => deleteEmulatorIdentity(identity.uid)));
  });

  await room.set({
    stage: "registration",
    currentQuestion: null,
    acceptingAnswers: false,
    activeQuestionId: null,
  });
  await room.collection("questions").doc(questionId).set({
    text: "Security boundary question",
    options: ["A", "B"],
    correctIndex: 0,
    maxPoints: 1000,
    minPoints: 100,
    seconds: 30,
    answerRevealDelaySeconds: 0,
  });

  const [registrationA, registrationB] = await Promise.all([register(tokenA, 1), register(tokenB, 2)]);
  assert.equal(registrationA.statusCode, 200);
  assert.equal(registrationB.statusCode, 200);
  const playerA = registrationA.body.data.playerId;
  const playerB = registrationB.body.data.playerId;

  await t.test("registration and recovery are idempotent and responses remain public", async () => {
    const repeated = await register(tokenA, 1);
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.body.data.status, "already-registered");
    assert.equal(repeated.body.data.playerId, playerA);
    const recoveries = await Promise.all([
      invokeApi("player", { token: tokenA, action: "recoverPlayer", data: { roomId } }),
      invokeApi("player", { token: tokenA, action: "recoverPlayer", data: { roomId } }),
    ]);
    assert.ok(recoveries.every((entry) => entry.statusCode === 200));
    assert.ok(recoveries.every((entry) => entry.body.data.playerId === playerA));
    for (const value of [registrationA.body.data, repeated.body.data, ...recoveries.map((r) => r.body.data)]) {
      assert.doesNotMatch(
        JSON.stringify(value),
        /0551000001|Sensitive Name 1|phoneNormalized|authUid|recoveryNameNormalized/,
      );
    }
  });

  await t.test("player identity spoofing is rejected across player operations", async () => {
    for (const [action, data] of [
      ["submitAnswer", { roomId, questionId, playerId: playerB, selectedIndex: 0 }],
      ["activateJoker", { roomId, questionId, playerId: playerB }],
      ["cancelJoker", { roomId, playerId: playerB }],
      ["updatePlayerProfile", { roomId, playerId: playerB, name: "Spoofed" }],
    ]) {
      const result = await invokeApi("player", { token: tokenA, action, data });
      assert.equal(result.statusCode, 403, action);
      assert.equal(result.body.error.code, "permission-denied", action);
      assert.equal(Object.hasOwn(result.body.error, "stack"), false);
    }
  });

  await t.test("uid/authUid body injection and unregistered answer are rejected", async () => {
    for (const injected of [{ uid: identities[1].uid }, { authUid: identities[1].uid }]) {
      const result = await invokeApi("player", {
        token: tokenA,
        action: "updatePlayerProfile",
        data: { roomId, playerId: playerA, name: "No change", ...injected },
      });
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, "invalid-argument");
    }
    const result = await invokeApi("player", {
      token: unregisteredToken,
      action: "submitAnswer",
      data: { roomId, questionId, playerId: playerA, selectedIndex: 0 },
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.error.code, "permission-denied");
  });

  await t.test("missing, forged and different-project-shaped tokens fail safely", async () => {
    const forged = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify({ aud: "other-project", sub: "attacker" })).toString("base64url") +
      ".";
    for (const token of [undefined, "forged-token", forged]) {
      const result = await invokeApi("player", {
        token,
        action: "recoverPlayer",
        data: { roomId },
      });
      assert.equal(result.statusCode, 401);
      assert.ok(["missing-token", "invalid-token"].includes(result.body.error.code));
      assert.doesNotMatch(JSON.stringify(result.body), /forged-token|other-project|attacker/);
    }
  });

  await t.test("admin access depends only on admin:true claim", async () => {
    for (const token of [tokenA, adminEmailToken, adminFalseToken]) {
      const denied = await invokeApi("admin", {
        token,
        action: "getPlayerPrivateDetails",
        data: { roomId, playerId: playerA },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.body.error.code, "permission-denied");
      assert.doesNotMatch(JSON.stringify(denied.body), /admin-email|claim|token/i);
    }
    const allowed = await invokeApi("admin", {
      token: adminToken,
      action: "getPlayerPrivateDetails",
      data: { roomId, playerId: playerA },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.data.details.phone, "0551000001");
  });

  await t.test("concurrent joker activation consumes no more than one joker", async () => {
    const activations = await Promise.all([
      invokeApi("player", {
        token: tokenA,
        action: "activateJoker",
        data: { roomId, questionId: "next", playerId: playerA },
      }),
      invokeApi("player", {
        token: tokenA,
        action: "activateJoker",
        data: { roomId, questionId: "next", playerId: playerA },
      }),
    ]);
    assert.ok(activations.every((entry) => entry.statusCode === 200));
    assert.deepEqual(
      new Set(activations.map((entry) => entry.body.data.status)),
      new Set(["pending", "already-pending"]),
    );
    const pending = (await room.collection("players").doc(playerA).get()).data();
    assert.equal(pending.pendingJoker, true);
    assert.equal(pending.jokerUsed, false);
  });

  await t.test("admin operations retain their current authorization and contracts", async () => {
    const adjustedFirst = await invokeApi("admin", {
      token: adminToken,
      action: "adjustPlayerScore",
      data: { roomId, playerId: playerB, delta: 10, reason: "operation10" },
    });
    const adjustedSecond = await invokeApi("admin", {
      token: adminToken,
      action: "adjustPlayerScore",
      data: { roomId, playerId: playerB, delta: 10, reason: "operation10-repeat" },
    });
    assert.equal(adjustedFirst.statusCode, 200);
    assert.equal(adjustedSecond.statusCode, 200);
    assert.equal((await room.collection("players").doc(playerB).get()).data().score, 20);

    const resetRoomId = `${roomId}-admin-reset`;
    const resetRoom = roomRef(resetRoomId);
    await resetRoom.set({ stage: "practiceComplete", acceptingAnswers: false });
    await resetRoom.collection("players").doc("practice-player").set({ score: 25, practiceScore: 25 });
    const practice = await invokeApi("admin", {
      token: adminToken,
      action: "resetPracticeScores",
      data: { roomId: resetRoomId, reason: "operation10 test reset" },
    });
    assert.equal(practice.statusCode, 200);
    const reset = await invokeApi("admin", {
      token: adminToken,
      action: "resetQuizData",
      data: { roomId: resetRoomId, mode: "full", reason: "operation10-test" },
    });
    assert.equal(reset.statusCode, 200);

  });

  await t.test("answers before start and client timestamps are not trusted", async () => {
    const before = await invokeApi("player", {
      token: tokenA,
      action: "submitAnswer",
      data: {
        roomId,
        questionId,
        playerId: playerA,
        selectedIndex: 0,
        timestamp: 0,
      },
    });
    assert.ok([400, 409].includes(before.statusCode));
    assert.ok(["invalid-argument", "failed-precondition"].includes(before.body.error.code));
  });

  await invokeApi("quiz", {
    token: adminToken,
    action: "prepareQuestion",
    data: { roomId, questionId, questionIndex: 0 },
  });
  await invokeApi("quiz", {
    token: adminToken,
    action: "startQuestion",
    data: { roomId, questionId },
  });

  await t.test("concurrent submitAnswer creates exactly one immutable answer", async () => {
    const results = await Promise.all([
      invokeApi("player", {
        token: tokenA,
        action: "submitAnswer",
        data: { roomId, questionId, playerId: playerA, selectedIndex: 0 },
      }),
      invokeApi("player", {
        token: tokenA,
        action: "submitAnswer",
        data: { roomId, questionId, playerId: playerA, selectedIndex: 1 },
      }),
    ]);
    assert.equal(results.filter((entry) => entry.statusCode === 200).length, 1);
    assert.equal(results.filter((entry) => entry.body?.error?.code === "already-exists").length, 1);
    const answers = await room.collection("answers").where("playerId", "==", playerA).get();
    assert.equal(answers.size, 1);
    assert.ok(typeof answers.docs[0].data().createdAt?.toMillis === "function");
  });

  await t.test("answer at an expired server window is rejected", async () => {
    await room.update({
      "currentQuestion.answerEndAtMs": Date.now() - 1,
      answerEndAtMs: Date.now() - 1,
    });
    const expired = await invokeApi("player", {
      token: tokenB,
      action: "submitAnswer",
      data: { roomId, questionId, playerId: playerB, selectedIndex: 0 },
    });
    assert.equal(expired.statusCode, 409);
    assert.equal(expired.body.error.code, "failed-precondition");
  });

  const revealed = await invokeApi("quiz", {
    token: adminToken,
    action: "controlQuestion",
    data: { roomId, questionId, action: "reveal" },
  });
  const revealedAgain = await invokeApi("quiz", {
    token: adminToken,
    action: "controlQuestion",
    data: { roomId, questionId, action: "reveal" },
  });
  assert.equal(revealed.body.data.status, "revealed");
  assert.equal(revealedAgain.body.data.status, "already-revealed");

  await t.test("answer and joker cancellation after closing are rejected", async () => {
    const answer = await invokeApi("player", {
      token: tokenB,
      action: "submitAnswer",
      data: { roomId, questionId, playerId: playerB, selectedIndex: 0 },
    });
    assert.equal(answer.statusCode, 409);
    assert.equal(answer.body.error.code, "failed-precondition");
    const cancel = await invokeApi("player", {
      token: tokenA,
      action: "cancelJoker",
      data: { roomId, playerId: playerA },
    });
    assert.equal(cancel.statusCode, 409);
    assert.equal(cancel.body.error.code, "failed-precondition");

    const deleted = await invokeApi("admin", {
      token: adminToken,
      action: "deletePlayer",
      data: { roomId, playerId: playerB, reason: "operation10-test" },
    });
    assert.equal(deleted.statusCode, 200);
  });

  await t.test("concurrent finalization is idempotent and ranking is stable", async () => {
    const [first, second] = await Promise.all([
      invokeApi("quiz", {
        token: adminToken,
        action: "finalizeQuestion",
        data: { roomId, questionId },
      }),
      invokeApi("quiz", {
        token: adminToken,
        action: "finalizeQuestion",
        data: { roomId, questionId },
      }),
    ]);
    const concurrent = [first, second];
    const successful = concurrent.filter((entry) => entry.statusCode === 200);
    assert.ok(successful.length >= 1);
    assert.ok(successful.some((entry) => entry.body.data.status === "finalized"));
    const contender = concurrent.find((entry) => entry.statusCode !== 200);
    if (contender) {
      assert.equal(contender.statusCode, 409);
      assert.equal(contender.body.error.code, "aborted");
    }
    assert.equal((await room.collection("questionResults").get()).size, 1);
    const score = (await room.collection("players").doc(playerA).get()).data().score;
    const again = await invokeApi("quiz", {
      token: adminToken,
      action: "finalizeQuestion",
      data: { roomId, questionId },
    });
    assert.equal(again.body.data.status, "already-finalized");
    assert.equal((await room.collection("players").doc(playerA).get()).data().score, score);
  });

  await t.test("public documents and public responses exclude private identity fields", async () => {
    const publicPlayer = (await room.collection("players").doc(playerA).get()).data();
    for (const field of [
      "phone",
      "phoneNormalized",
      "fullName",
      "authUid",
      "recoveryNameNormalized",
    ]) {
      assert.equal(publicPlayer[field], undefined);
      assert.equal(registrationA.body.data[field], undefined);
      assert.equal(registrationA.body.data.player?.[field], undefined);
    }
  });
});
