import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { createQuestionFinalizationClient } from "../../../src/finalize-question-client.js";
import { createServerApiClient } from "../../../src/server-api-core.js";
import { useQuestionFinalization } from "../../../src/use-question-finalization.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function FinalizationHarness({ room, resultState, client, decisions }) {
  const finalization = useQuestionFinalization({
    room,
    canFinalize: true,
    officialResultState: resultState,
    onResumeDecision: (decision) => decisions.push(decision.reason),
    finalizationClient: client,
    initialResultWaitMs: 50,
  });
  return React.createElement(
    "output",
    { "data-status": finalization.status },
    finalization.isBusy ? "جاري اعتماد النتائج..." : finalization.status,
  );
}

function DisabledDisplayFinalizationHarness({ room, resultState, client, decisions }) {
  const finalization = useQuestionFinalization({
    enabled: false,
    room,
    canFinalize: false,
    officialResultState: resultState,
    onResumeDecision: (decision) => decisions.push(decision.reason),
    finalizationClient: client,
    initialResultWaitMs: 1,
  });
  return React.createElement("output", { "data-status": finalization.status }, finalization.status);
}

test("DisplayView does not run admin finalization recovery or its staging diagnostic", async () => {
  let requests = 0;
  const decisions = [];
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisabledDisplayFinalizationHarness, {
      room: {
        stage: "results",
        activeQuestionId: "q1",
        currentQuestion: { questionId: "q1" },
        finalization: { status: "completed", questionId: "q1" },
      },
      resultState: { questionId: "q1", loading: false, exists: false, result: null },
      client: { finalizeAndWait: async () => { requests += 1; } },
      decisions,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  assert.equal(renderer.toJSON().props["data-status"], "idle");
  assert.equal(requests, 0);
  assert.deepEqual(decisions, []);
  await act(async () => renderer.unmount());
});

test("the real hook resumes once after reload snapshots and POSTs to /api/quiz", async () => {
  const requests = [];
  const decisions = [];
  let finishResult;
  const resultPromise = new Promise((resolve) => { finishResult = resolve; });
  const serverClient = createServerApiClient({
    transport: "vercel",
    auth: { currentUser: { getIdToken: async () => "test-id-token" } },
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { status: "processing" } }),
      };
    },
  });
  const client = createQuestionFinalizationClient({
    firestore: {},
    finalizeOperation: serverClient.finalizeQuestion,
    waitForResult: () => resultPromise,
  });
  const loadingResult = { questionId: "q1", loading: true, exists: false, result: null };
  const missingResult = { ...loadingResult, loading: false };
  const liveRoom = {
    stage: "reveal",
    activeQuestionId: "q1",
    currentQuestion: { questionId: "q1", text: "question" },
    finalization: { status: "processing", questionId: "q1", startedAtMs: 1_000 },
    processedQuestionId: null,
  };

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(FinalizationHarness, {
      room: null,
      resultState: { questionId: "", loading: false, exists: false, result: null },
      client,
      decisions,
    }));
  });
  await act(async () => {
    renderer.update(React.createElement(FinalizationHarness, {
      room: liveRoom,
      resultState: loadingResult,
      client,
      decisions,
    }));
  });
  assert.match(renderer.toJSON().children.join(""), /جاري اعتماد النتائج/);
  assert.equal(requests.length, 0);

  await act(async () => {
    renderer.update(React.createElement(FinalizationHarness, {
      room: liveRoom,
      resultState: missingResult,
      client,
      decisions,
    }));
    await Promise.resolve();
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/quiz");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, {
    action: "finalizeQuestion",
    data: { roomId: "family-quiz-001", questionId: "q1" },
  });
  assert.ok(decisions.includes("hook-not-ready"));
  assert.ok(decisions.includes("waiting-for-initial-result"));
  assert.ok(decisions.includes("resume-request-started"));

  await act(async () => {
    finishResult({ questionId: "q1" });
    await resultPromise;
  });
  await act(async () => renderer.unmount());
});

test("the real hook cannot remain blocked when the initial result snapshot never settles", async () => {
  let requests = 0;
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const client = {
    finalizeAndWait: () => {
      requests += 1;
      return pendingRequest;
    },
  };
  const room = {
    stage: "reveal",
    activeQuestionId: "q1",
    currentQuestion: { questionId: "q1" },
    finalization: { status: "processing", questionId: "q1" },
  };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(FinalizationHarness, {
      room,
      resultState: { questionId: "q1", loading: true, exists: false, result: null },
      client,
      decisions: [],
    }));
  });
  assert.equal(requests, 0);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 70));
  });
  assert.equal(requests, 1);
  await act(async () => {
    finishRequest({ officialResult: { questionId: "q1" } });
    await pendingRequest;
  });
  await act(async () => renderer.unmount());
});

test("the real hook accepts the canonical result and leaves no completed wait state", async () => {
  let requests = 0;
  const client = {
    finalizeAndWait: async () => {
      requests += 1;
      return { officialResult: { questionId: "q1" } };
    },
  };
  const room = {
    stage: "results",
    activeQuestionId: "q1",
    currentQuestion: { questionId: "q1" },
    processedQuestionId: "q1",
    finalization: { status: "completed", questionId: "q1" },
  };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(FinalizationHarness, {
      room,
      resultState: {
        questionId: "q1",
        loading: false,
        exists: true,
        result: { questionId: "q1", runId: "official-run" },
      },
      client,
      decisions: [],
    }));
  });
  assert.equal(requests, 0);
  assert.equal(renderer.toJSON().props["data-status"], "completed");
  assert.doesNotMatch(renderer.toJSON().children.join(""), /جاري اعتماد النتائج/);
  await act(async () => renderer.unmount());
});
