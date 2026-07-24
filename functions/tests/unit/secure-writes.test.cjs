"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  exactInput,
  normalizePhone,
  normalizeRecoveryName,
  publicPlayerData,
  publicQuestionData,
  requirePlayerOwner,
  validateScoreAdjustment,
  validateSelectedIndex,
} = require("../../secure-writes/domain");

test("answer input accepts only the minimal contract", () => {
  assert.deepEqual(
    exactInput(
      { roomId: "room", questionId: "q1", playerId: "p1", selectedIndex: 2 },
      ["roomId", "questionId", "playerId", "selectedIndex"]
    ),
    { roomId: "room", questionId: "q1", playerId: "p1", selectedIndex: 2 }
  );
  assert.throws(() =>
    exactInput(
      { roomId: "room", questionId: "q1", playerId: "p1", selectedIndex: 2, points: 999 },
      ["roomId", "questionId", "playerId", "selectedIndex"]
    )
  );
});

test("player ownership is bound to authenticated UID", () => {
  assert.equal(requirePlayerOwner({ authUid: "uid-1" }, { uid: "uid-1" }), "uid-1");
  assert.throws(
    () => requirePlayerOwner({ authUid: "uid-2" }, { uid: "uid-1" }),
    (error) => error.code === "permission-denied"
  );
});

test("public player data excludes identity and contact fields", () => {
  const publicPlayer = publicPlayerData({
    name: "Display",
    emoji: "⭐",
    createdAt: "server-time",
  });
  assert.equal(publicPlayer.name, "Display");
  assert.equal(publicPlayer.displayName, "Display");
  assert.equal(publicPlayer.authUid, undefined);
  assert.equal(publicPlayer.fullName, undefined);
  assert.equal(publicPlayer.phone, undefined);
  assert.equal(publicPlayer.phoneNormalized, undefined);
});

test("private registration fields are normalized without weak hashing", () => {
  assert.equal(normalizePhone("050-000-0001"), "0500000001");
  assert.deepEqual(normalizeRecoveryName("  Full   Name  "), {
    fullName: "Full Name",
    recoveryNameNormalized: "full name",
  });
  assert.throws(() => normalizePhone("123"));
});

test("selectedIndex and manual score adjustment are bounded", () => {
  assert.equal(validateSelectedIndex(3), 3);
  assert.throws(() => validateSelectedIndex(-1));
  assert.deepEqual(
    validateScoreAdjustment({ roomId: "room", playerId: "p1", delta: -50, reason: "تصحيح إداري" }),
    { roomId: "room", playerId: "p1", delta: -50, reason: "تصحيح إداري" }
  );
  assert.throws(() =>
    validateScoreAdjustment({ roomId: "room", playerId: "p1", delta: 10001, reason: "invalid" })
  );
});

test("public question strips every correct-answer field", () => {
  const { publicQuestion, secret } = publicQuestionData(
    {
      text: "Question",
      options: ["A", "B"],
      correctIndex: 1,
      correctOption: "B",
      maxPoints: 1000,
      minPoints: 100,
      seconds: 20,
    },
    "q1"
  );
  assert.equal(publicQuestion.correctIndex, undefined);
  assert.equal(publicQuestion.correctOption, undefined);
  assert.equal(secret.correctIndex, 1);
});
