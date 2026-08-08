import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { buildDisplaySnapshotFromOfficialResult } from "../../../src/display-official-result.js";
import { DisplayNavigationControls } from "../../../src/display-navigation-controls.js";
import {
  isQuizStageTransitionAllowed,
  nextDisplayPreview,
  previousDisplayPreview,
  publicPlayerDisplayName,
  QUIZ_STAGES,
  runHandledUiAction,
} from "../../../src/quiz-state-machine.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("official-result fallback renders public names, points, and ranking", () => {
  const snapshot = buildDisplaySnapshotFromOfficialResult({
    questionId: "q2",
    players: [
      { id: "p1", displayName: "Public One", fullName: "Private One", phone: "0500000001", authUid: "uid-1" },
      { id: "p2", name: "Public Two", fullName: "Private Two", phone: "0500000002", authUid: "uid-2" },
    ],
    officialResult: {
      questionId: "q2",
      results: [
        { playerId: "p1", answered: true, isCorrect: true, points: 40, scoreBefore: 10, scoreAfter: 50, rankMovement: 1 },
        { playerId: "p2", answered: true, isCorrect: false, points: 0, scoreBefore: 30, scoreAfter: 30, rankMovement: -1 },
      ],
    },
  });
  assert.deepEqual(snapshot.leaderboardAfter.map(({ name, score }) => ({ name, score })), [
    { name: "Public One", score: 50 },
    { name: "Public Two", score: 30 },
  ]);
  assert.deepEqual(snapshot.leaderboardAfter.map((player, index) => ({ name: player.name, rank: index + 1 })), [
    { name: "Public One", rank: 1 },
    { name: "Public Two", rank: 2 },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("Private One"), false);
  assert.equal(JSON.stringify(snapshot).includes("0500000001"), false);
  assert.equal(JSON.stringify(snapshot).includes("uid-1"), false);
  assert.equal(publicPlayerDisplayName({ displayName: "Visible", name: "Legacy" }), "Visible");
});

test("the central state map validates the core quiz lifecycle", () => {
  const lifecycle = [
    QUIZ_STAGES.HOME,
    QUIZ_STAGES.REGISTRATION,
    QUIZ_STAGES.INSTRUCTIONS,
    QUIZ_STAGES.READY,
    QUIZ_STAGES.QUESTION,
    QUIZ_STAGES.REVEAL,
    QUIZ_STAGES.RESULTS,
    QUIZ_STAGES.FINAL_COUNTDOWN,
    QUIZ_STAGES.FINISHED,
  ];
  for (let index = 1; index < lifecycle.length; index += 1) {
    assert.equal(isQuizStageTransitionAllowed(lifecycle[index - 1], lifecycle[index]), true);
  }
  assert.equal(isQuizStageTransitionAllowed(QUIZ_STAGES.QUESTION, QUIZ_STAGES.RESULTS), false);
  assert.equal(isQuizStageTransitionAllowed(QUIZ_STAGES.FINISHED, QUIZ_STAGES.QUESTION), false);
});

test("DisplayView previous, next, and return-to-live navigation remains deterministic", () => {
  assert.deepEqual(previousDisplayPreview({
    displayStage: QUIZ_STAGES.RESULTS,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: QUIZ_STAGES.REVEAL, questionIndex: 1 });
  assert.deepEqual(previousDisplayPreview({
    displayStage: QUIZ_STAGES.QUESTION,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: QUIZ_STAGES.RESULTS, questionIndex: 0 });
  assert.deepEqual(nextDisplayPreview({
    liveStage: QUIZ_STAGES.RESULTS,
    previewStage: QUIZ_STAGES.REVEAL,
    displayStage: QUIZ_STAGES.REVEAL,
    displayQuestionIndex: 1,
    currentQuestionIndex: 1,
  }), { stage: null, questionIndex: null });
});

test("operational button failures are caught instead of becoming unhandled promises", async () => {
  const expected = Object.assign(new Error("failed"), { code: "failed-precondition" });
  let captured;
  assert.equal(await runHandledUiAction(async () => { throw expected; }, (error) => { captured = error; }), false);
  assert.equal(captured, expected);
});

test("the real Admin and Display wiring uses safe handlers and local-only display controls", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /async function handleAdvanceFromDashboardClick\(\)/);
  assert.match(source, /onClick=\{handleAdvanceFromDashboardClick\}/);
  assert.doesNotMatch(source, /onClick=\{advanceFromDashboard\}/);
  assert.match(source, /import \{ DisplayNavigationControls \} from "\.\/display-navigation-controls\.js"/);
  assert.match(source, /<DisplayNavigationControls[\s\S]*stage=\{displayStage\}/);
  assert.match(source, /enabled:\s*initialView !== "display"/);
});

const DISPLAY_NAVIGATION_CASES = [
  { stage: QUIZ_STAGES.HOME, buttons: [] },
  { stage: QUIZ_STAGES.REGISTRATION, buttons: ["السابق"] },
  { stage: QUIZ_STAGES.QUESTION, buttons: ["السابق"] },
  { stage: QUIZ_STAGES.REVEAL, buttons: ["السابق"] },
  { stage: QUIZ_STAGES.RESULTS, buttons: ["السابق"] },
  { stage: QUIZ_STAGES.FINISHED, buttons: ["السابق", "نتائج السؤال الأخير"] },
];

function renderDisplayNavigation(stage, overrides = {}) {
  return renderToStaticMarkup(React.createElement(DisplayNavigationControls, {
    stage,
    previewStage: null,
    finalQuestion: { questionId: "q-last" },
    showFinalQuestionResults: false,
    canPrevious: stage !== QUIZ_STAGES.HOME,
    canNext: false,
    onPrevious: () => {},
    onNext: () => {},
    onReturnToLive: () => {},
    onToggleFinalQuestionResults: () => {},
    ...overrides,
  }));
}

for (const { stage, buttons } of DISPLAY_NAVIGATION_CASES) {
  test(`the real Display navigation renders the intended controls during ${stage}`, () => {
    const html = renderDisplayNavigation(stage);
    for (const label of ["التالي", "السابق", "العرض الحالي", "نتائج السؤال الأخير", "العودة للفائزين"]) {
      assert.equal(html.includes(`>${label}<`), buttons.includes(label), `${label} visibility during ${stage}`);
    }
    assert.equal(html.includes("/api/admin"), false);
    assert.equal(html.includes("/api/quiz"), false);
  });
}

test("finished Display toggles between final-question results and winners locally", () => {
  const html = renderDisplayNavigation(QUIZ_STAGES.FINISHED, { showFinalQuestionResults: true });
  assert.match(html, />العودة للفائزين</);
  assert.doesNotMatch(html, />نتائج السؤال الأخير</);
});

test("preview mode keeps return-to-live visible and enabled", () => {
  const html = renderDisplayNavigation(QUIZ_STAGES.RESULTS, {
    previewStage: QUIZ_STAGES.REVEAL,
    canNext: true,
  });
  assert.match(html, />العرض الحالي</);
  assert.match(html, />التالي</);
});

test("return-to-live is absent live, appears in preview, and removes preview when clicked", async () => {
  let requests = 0;
  function DisplayNavigationHarness() {
    const [previewStage, setPreviewStage] = useState(QUIZ_STAGES.REVEAL);
    return React.createElement(DisplayNavigationControls, {
      stage: QUIZ_STAGES.RESULTS,
      previewStage,
      finalQuestion: { questionId: "q-last" },
      showFinalQuestionResults: false,
      canPrevious: true,
      canNext: !!previewStage,
      onPrevious: () => {},
      onNext: () => {},
      onReturnToLive: () => setPreviewStage(null),
      onToggleFinalQuestionResults: () => {},
    });
  }

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayNavigationHarness));
  });
  const returnButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "العرض الحالي");
  assert.ok(returnButton);
  await act(async () => returnButton.props.onClick());
  assert.equal(renderer.root.findAllByType("button").some((button) => button.children.join("") === "العرض الحالي"), false);
  assert.equal(requests, 0);
  await act(async () => renderer.unmount());
});

test("Desktop Display CSS anchors the visible toolbar inside the 16:9 frame", async () => {
  const css = await readFile(new URL("../../../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.display-frame\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.display-history-nav\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*8[^}]*display:\s*flex/s);
  assert.doesNotMatch(css, /\.display-history-nav\s*\{[^}]*display:\s*none/s);
});
