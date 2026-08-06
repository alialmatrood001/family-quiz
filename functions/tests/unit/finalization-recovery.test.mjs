import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ACTIVE_QUESTION_RESET_MESSAGE,
  getQuizResetErrorMessage,
  isQuizResetBlocked,
  runQuizResetAction,
} from "../../../src/admin-reset-flow.js";
import {
  attemptFinalizationResume,
  decideFinalizationResume,
  finalizationStartedAtMs,
  timestampToMillis,
} from "../../../src/finalization-resume.js";
import { createQuestionFinalizationClient } from "../../../src/finalize-question-client.js";
import { SERVER_OPERATIONS } from "../../../src/server-api-core.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("recent processing is checked again after the result wait window", async () => {
  let finalizeCalls = 0;
  let waitCalls = 0;
  let recoveryCalls = 0;
  const client = createQuestionFinalizationClient({
    firestore: {},
    resultTimeoutMs: 1,
    finalizeOperation: async () => {
      finalizeCalls += 1;
      return { status: finalizeCalls === 1 ? "processing" : "finalized" };
    },
    waitForResult: async () => {
      waitCalls += 1;
      if (waitCalls === 1) throw { code: "deadline-exceeded" };
      return { questionId: "q1", counts: { players: 1 } };
    },
    readResult: async () => null,
  });

  const result = await client.finalizeAndWait({
    roomId: "room",
    questionId: "q1",
    onRecovering: () => { recoveryCalls += 1; },
  });
  assert.equal(result.officialResult.questionId, "q1");
  assert.equal(finalizeCalls, 2);
  assert.equal(waitCalls, 2);
  assert.equal(recoveryCalls, 1);
});

test("reload during processing starts exactly one finalize request on the quiz endpoint", async () => {
  const attemptedRef = { current: null };
  let requests = 0;
  const context = {
    room: {
      stage: "reveal",
      currentQuestion: { questionId: "q1" },
      finalization: { status: "processing", questionId: "q1", startedAtMs: 1_000 },
    },
    canFinalize: true,
    hookReady: true,
    officialResultLoading: false,
    officialResultExists: false,
    requestActive: false,
    nowMs: 2_000,
  };
  const first = attemptFinalizationResume({
    context,
    attemptedRef,
    request: async () => { requests += 1; },
  });
  const second = attemptFinalizationResume({
    context,
    attemptedRef,
    request: async () => { requests += 1; },
  });
  await first.promise;
  assert.equal(second.promise, null);
  assert.equal(requests, 1);
  assert.equal(SERVER_OPERATIONS.finalizeQuestion.endpoint, "quiz");
});

test("Firestore Timestamp values produce the correct finalization age", () => {
  const timestamp = { toMillis: () => 10_000 };
  assert.equal(timestampToMillis(timestamp), 10_000);
  assert.equal(timestampToMillis({ seconds: 10, nanoseconds: 500_000_000 }), 10_500);
  assert.equal(finalizationStartedAtMs({ finalization: { startedAt: timestamp } }), 10_000);
  assert.equal(
    decideFinalizationResume({
      room: {
        stage: "reveal",
        currentQuestion: { questionId: "q1" },
        finalization: { status: "processing", startedAt: timestamp },
      },
      canFinalize: true,
      hookReady: true,
      officialResultLoading: false,
      officialResultExists: false,
      requestActive: false,
      nowMs: 50_000,
    }).lockAgeMs,
    40_000,
  );
});

test("a question arriving after the room snapshot triggers only after hook initialization", async () => {
  const attemptedRef = { current: null };
  let requests = 0;
  const base = {
    canFinalize: true,
    officialResultLoading: false,
    officialResultExists: false,
    requestActive: false,
  };
  const early = attemptFinalizationResume({
    context: { ...base, room: { stage: "reveal", finalization: { status: "processing" } }, hookReady: false },
    attemptedRef,
    request: async () => { requests += 1; },
  });
  assert.equal(early.decision.reason, "question-not-ready");
  assert.equal(attemptedRef.current, null);
  const ready = attemptFinalizationResume({
    context: {
      ...base,
      room: {
        stage: "reveal",
        activeQuestionId: "q1",
        finalization: { status: "processing" },
      },
      hookReady: true,
    },
    attemptedRef,
    request: async () => { requests += 1; },
  });
  await ready.promise;
  assert.equal(requests, 1);
});

test("an active manual request delays reload resume without consuming its single attempt", async () => {
  const attemptedRef = { current: null };
  let requests = 0;
  const context = {
    room: {
      stage: "reveal",
      currentQuestion: { questionId: "q1" },
      finalization: { status: "processing" },
    },
    canFinalize: true,
    hookReady: true,
    officialResultLoading: false,
    officialResultExists: false,
  };
  const busy = attemptFinalizationResume({
    context: { ...context, requestActive: true },
    attemptedRef,
    request: async () => { requests += 1; },
  });
  assert.equal(busy.decision.reason, "request-active");
  assert.equal(attemptedRef.current, null);
  const resumed = attemptFinalizationResume({
    context: { ...context, requestActive: false },
    attemptedRef,
    request: async () => { requests += 1; },
  });
  await resumed.promise;
  assert.equal(requests, 1);
});

test("an existing official result prevents a reload resume request", () => {
  const attemptedRef = { current: null };
  const outcome = attemptFinalizationResume({
    context: {
      room: {
        stage: "reveal",
        currentQuestion: { questionId: "q1" },
        finalization: { status: "processing" },
      },
      canFinalize: true,
      hookReady: true,
      officialResultLoading: false,
      officialResultExists: true,
      requestActive: false,
    },
    attemptedRef,
    request: async () => assert.fail("resume request must not be sent"),
  });
  assert.equal(outcome.promise, null);
  assert.equal(outcome.decision.reason, "official-result-exists");
});

test("failed finalization is eligible for one safe resume", () => {
  const decision = decideFinalizationResume({
    room: {
      stage: "reveal",
      currentQuestion: { questionId: "q1" },
      finalization: { status: "failed" },
    },
    canFinalize: true,
    hookReady: true,
    officialResultLoading: false,
    officialResultExists: false,
    requestActive: false,
  });
  assert.equal(decision.shouldResume, true);
  assert.equal(decision.reason, "resume-failed");
});

test("a direct result read after timeout avoids another finalization request", async () => {
  let finalizeCalls = 0;
  const client = createQuestionFinalizationClient({
    firestore: {},
    finalizeOperation: async () => {
      finalizeCalls += 1;
      return { status: "processing" };
    },
    waitForResult: async () => { throw { code: "deadline-exceeded" }; },
    readResult: async () => ({ questionId: "q1", runId: "official-run" }),
  });
  const result = await client.finalizeAndWait({ roomId: "room", questionId: "q1" });
  assert.equal(result.officialResult.runId, "official-run");
  assert.equal(finalizeCalls, 1);
});

test("an HTTP request timeout waits for the possibly committed official result", async () => {
  let waited = false;
  const client = createQuestionFinalizationClient({
    firestore: {},
    finalizeOperation: async () => { throw { code: "request-timeout" }; },
    waitForResult: async () => {
      waited = true;
      return { questionId: "q1", runId: "completed-after-http-timeout" };
    },
  });
  const result = await client.finalizeAndWait({ roomId: "room", questionId: "q1" });
  assert.equal(waited, true);
  assert.equal(result.officialResult.runId, "completed-after-http-timeout");
});

test("a genuine finalization conflict is surfaced and is not masked as processing", async () => {
  let waited = false;
  const client = createQuestionFinalizationClient({
    firestore: {},
    finalizeOperation: async () => {
      throw { code: "failed-precondition", message: "stage mismatch", status: 409 };
    },
    waitForResult: async () => { waited = true; },
  });
  await assert.rejects(
    client.finalizeAndWait({ roomId: "room", questionId: "q1" }),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(waited, false);
});

test("quiz reset remains blocked during an active question or finalization", () => {
  assert.equal(isQuizResetBlocked({ stage: "question" }), true);
  assert.equal(isQuizResetBlocked({ stage: "reveal" }), true);
  assert.equal(isQuizResetBlocked({ stage: "results", finalizationStatus: "processing" }), true);
  assert.equal(isQuizResetBlocked({ stage: "results", serverFinalizationStatus: "processing" }), true);
  assert.equal(isQuizResetBlocked({ stage: "results", finalizationStatus: "completed" }), false);
});

test("active-question reset conflict is handled without an unhandled rejection", async () => {
  let visibleMessage = "";
  const outcome = await runQuizResetAction(
    async () => {
      throw Object.assign(new Error("Quiz data cannot be reset during an active question"), {
        code: "failed-precondition",
        status: 409,
      });
    },
    { onError: (message) => { visibleMessage = message; } },
  );
  assert.equal(outcome.ok, false);
  assert.equal(visibleMessage, ACTIVE_QUESTION_RESET_MESSAGE);
  assert.equal(getQuizResetErrorMessage(outcome.error), ACTIVE_QUESTION_RESET_MESSAGE);
});

test("admin setup buttons use the guarded reset handler and active state", async () => {
  const source = await readFile(path.join(root, "src/App.jsx"), "utf8");
  assert.match(source, /disabled=\{setupBlocked \|\| setupActionBusy\}/);
  assert.match(source, /void handleSetupReset\(resetAndStartRegistration\)/);
  assert.match(source, /void handleSetupReset\(hardResetGame\)/);
  assert.doesNotMatch(source, /resetAndStartRegistration\(\);\s*\}\}>فتح جديد/);
});
