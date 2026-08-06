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
import { createQuestionFinalizationClient } from "../../../src/finalize-question-client.js";

const root = path.resolve(import.meta.dirname, "../../..");

test("a missing result after a stale-lock window is read directly and finalized once more", async () => {
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
