import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  buildDisplaySnapshotFromOfficialResult,
  DisplayOfficialResultController,
  resolveDisplayResult,
} from "../../../src/display-official-result.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const room = {
  stage: "results",
  activeQuestionId: "q1",
  currentQuestion: { questionId: "q1" },
  processedQuestionId: "q1",
  finalization: { status: "completed", questionId: "q1" },
};
const players = [{ id: "p1", name: "Player One", emoji: "⭐" }];
const officialResult = {
  questionId: "q1",
  finalizedAtMs: 123,
  results: [{
    playerId: "p1",
    answered: true,
    isCorrect: true,
    points: 100,
    scoreBefore: 50,
    scoreAfter: 150,
    rankMovement: 0,
    jokerApplied: false,
  }],
};

function DisplayHarness({ listenerState, readResult, fallbackDelayMs = 20 }) {
  return React.createElement(DisplayOfficialResultController, {
    room,
    players,
    listenerState,
    readResult,
    fallbackDelayMs,
    render: ({ displayResult }) => React.createElement(
      "output",
      {
        "data-status": displayResult.status,
        "data-source": displayResult.source || "",
      },
      displayResult.snapshot?.leaderboardAfter?.[0]?.name || displayResult.status,
    ),
  });
}

test("DisplayView without admin auth renders a completed official result and sends no server request", async () => {
  let directReads = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayHarness, {
      listenerState: { questionId: "q1", loading: false, exists: true, result: officialResult },
      readResult: async () => {
        directReads += 1;
        throw new Error("unexpected fallback read");
      },
    }));
  });
  assert.equal(renderer.toJSON().props["data-status"], "ready");
  assert.equal(renderer.toJSON().props["data-source"], "official-result");
  assert.equal(renderer.toJSON().children.join(""), "Player One");
  assert.equal(directReads, 0);
  await act(async () => renderer.unmount());
});

test("a delayed official result snapshot removes the DisplayView wait state", async () => {
  let directReads = 0;
  const readResult = async () => {
    directReads += 1;
    return { exists: false, result: null };
  };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayHarness, {
      listenerState: { questionId: "q1", loading: true, exists: false, result: null },
      readResult,
      fallbackDelayMs: 100,
    }));
  });
  assert.equal(renderer.toJSON().props["data-status"], "loading");
  await act(async () => {
    renderer.update(React.createElement(DisplayHarness, {
      listenerState: { questionId: "q1", loading: false, exists: true, result: officialResult },
      readResult,
      fallbackDelayMs: 100,
    }));
  });
  assert.equal(renderer.toJSON().props["data-status"], "ready");
  assert.equal(directReads, 0);
  await act(async () => renderer.unmount());
});

test("a stalled snapshot listener falls back to a direct canonical document read", async () => {
  let directReads = 0;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayHarness, {
      listenerState: { questionId: "q1", loading: true, exists: false, result: null },
      readResult: async (questionId) => {
        directReads += 1;
        assert.equal(questionId, "q1");
        return { exists: true, result: officialResult };
      },
      fallbackDelayMs: 5,
    }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  assert.equal(directReads, 1);
  assert.equal(renderer.toJSON().props["data-status"], "ready");
  assert.equal(renderer.toJSON().props["data-source"], "official-result");
  await act(async () => renderer.unmount());
});

test("DisplayView reports a missing official result after the safe fallback completes", async () => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayHarness, {
      listenerState: { questionId: "q1", loading: false, exists: false, result: null },
      readResult: async () => ({ exists: false, result: null }),
      fallbackDelayMs: 5,
    }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  assert.equal(renderer.toJSON().props["data-status"], "missing");
  await act(async () => renderer.unmount());
});

test("a result document whose payload identifies another question is not displayed", async () => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayHarness, {
      listenerState: {
        questionId: "q1",
        loading: false,
        exists: true,
        result: { ...officialResult, questionId: "q-other" },
      },
      readResult: async () => ({
        exists: true,
        result: { ...officialResult, questionId: "q-other" },
      }),
      fallbackDelayMs: 5,
    }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
  assert.equal(renderer.toJSON().props["data-status"], "missing");
  await act(async () => renderer.unmount());
});

test("official results are adapted for display without private player fields", () => {
  const snapshot = buildDisplaySnapshotFromOfficialResult({
    questionId: "q1",
    officialResult,
    players: [{ ...players[0], phone: "hidden", fullName: "Hidden Name", authUid: "hidden-uid" }],
  });
  assert.equal(snapshot.leaderboardAfter[0].score, 150);
  assert.equal(snapshot.leaderboardBefore[0].score, 50);
  assert.equal("phone" in snapshot.leaderboardAfter[0], false);
  assert.equal("fullName" in snapshot.leaderboardAfter[0], false);
  assert.equal("authUid" in snapshot.leaderboardAfter[0], false);
  assert.equal(resolveDisplayResult({ room, players, officialResultState: {
    exists: true,
    result: officialResult,
  } }).status, "ready");
});

test("legacy public displayName remains visible when name is absent", () => {
  const snapshot = buildDisplaySnapshotFromOfficialResult({
    questionId: "q1",
    officialResult,
    players: [{ id: "p1", displayName: "Legacy Public Name", fullName: "Hidden" }],
  });
  assert.equal(snapshot.leaderboardAfter[0].name, "Legacy Public Name");
  assert.equal(JSON.stringify(snapshot).includes("Hidden"), false);
});
