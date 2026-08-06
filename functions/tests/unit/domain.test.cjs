const assert = require("node:assert/strict");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const {
  requireAdmin,
  resolveOfficialJoker,
  selectOfficialAnswers,
  sortLeaderboard,
  validateInput,
  validateQuestion,
} = require("../../finalize-question/domain");

test("input accepts only safe roomId and questionId strings", () => {
  assert.deepEqual(validateInput({ roomId: "room_1", questionId: "question-1" }), {
    roomId: "room_1",
    questionId: "question-1",
  });
  assert.throws(() => validateInput({ roomId: "../room", questionId: "q" }));
  assert.throws(() => validateInput({ roomId: "room", questionId: "q", points: 1 }));
});

test("admin claim is mandatory", () => {
  assert.doesNotThrow(() => requireAdmin({ token: { admin: true } }));
  assert.throws(() => requireAdmin(null), (error) => error.code === "unauthenticated");
  assert.throws(
    () => requireAdmin({ token: {} }),
    (error) => error.code === "permission-denied"
  );
});

test("finalization rejects an activeQuestionId mismatch with a stable conflict", () => {
  assert.throws(
    () => validateQuestion({ activeQuestionId: "q2", currentQuestion: { questionId: "q1" } }, "q1"),
    (error) =>
      error.code === "failed-precondition" &&
      error.message === "The active question id does not match the requested question",
  );
});

test("first valid server-timestamped answer wins deterministically", () => {
  const answers = [
    {
      id: "late",
      playerId: "p1",
      questionId: "q1",
      selectedIndex: 0,
      createdAt: Timestamp.fromMillis(2_000),
    },
    {
      id: "early",
      playerId: "p1",
      questionId: "q1",
      selectedIndex: 1,
      createdAt: Timestamp.fromMillis(1_000),
    },
  ];
  const result = selectOfficialAnswers(answers, "q1", new Set(["p1"]));
  assert.equal(result.selected.get("p1").id, "early");
  assert.equal(result.diagnostics.duplicateAnswerCount, 1);
});

test("joker requires official timing, multiplier, question, and server lock time", () => {
  const question = { questionId: "q1", answerStartAtMs: 2_000 };
  const answer = { createdAtMs: 5_000 };
  assert.deepEqual(
    resolveOfficialJoker(
      {
        jokerUsed: true,
        jokerQuestionId: "q1",
        jokerTiming: "before",
        jokerMultiplier: 3,
        jokerLockedAt: Timestamp.fromMillis(1_000),
      },
      question,
      answer
    ),
    { applied: true, multiplier: 3, invalid: false }
  );
  assert.deepEqual(
    resolveOfficialJoker(
      {
        jokerUsed: true,
        jokerQuestionId: "q1",
        jokerTiming: "before",
        jokerMultiplier: 99,
        jokerLockedAt: Timestamp.fromMillis(1_000),
      },
      question,
      answer
    ),
    { applied: false, multiplier: null, invalid: true }
  );
});

test("ranking uses score descending then playerId ascending", () => {
  assert.deepEqual(
    sortLeaderboard([
      { id: "b", score: 10 },
      { id: "a", score: 10 },
      { id: "c", score: 20 },
    ]).map((player) => player.id),
    ["c", "a", "b"]
  );
});
