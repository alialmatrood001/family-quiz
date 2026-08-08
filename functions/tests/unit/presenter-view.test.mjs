import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PresenterQuizControls } from "../../../src/presenter-quiz-controls.js";
import {
  getPresenterControlDescriptors,
  PRESENTER_DEFERRED_CONTROLS,
  usePresenterQuizControls,
} from "../../../src/presenter-quiz-controller.js";
import { createQuizLiveOperations } from "../../../src/quiz-live-operations-core.js";
import { APP_VIEWS, resolveRequestedView, viewRequiresAdmin } from "../../../src/view-routing.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mainQuestions = [
  { id: "q1", type: "text" },
  { id: "q2", type: "text" },
];
const practiceQuestions = [{ id: "p1", type: "text" }];
const notVoting = () => false;

function labelsFor(room, overrides = {}) {
  return getPresenterControlDescriptors({
    room,
    mainQuestions,
    practiceQuestions,
    playersCount: 3,
    isVotingQuestion: notVoting,
    ...overrides,
  }).map(({ label }) => label);
}

test("routing exposes only Player, authenticated Display, and Admin Control as primary pages", () => {
  assert.equal(resolveRequestedView("?view=display"), APP_VIEWS.DISPLAY);
  assert.equal(resolveRequestedView("?view=control"), APP_VIEWS.CONTROL);
  assert.equal(resolveRequestedView("?view=presenter"), APP_VIEWS.PLAYER);
  assert.equal(resolveRequestedView("?admin=legacy"), APP_VIEWS.CONTROL);
  assert.equal("PRESENTER" in APP_VIEWS, false);
  assert.equal(viewRequiresAdmin(APP_VIEWS.DISPLAY), true);
  assert.equal(viewRequiresAdmin(APP_VIEWS.CONTROL), true);
  assert.equal(viewRequiresAdmin(APP_VIEWS.PLAYER), false);
});

const stageCases = [
  ["home", ["فتح التسجيل"]],
  ["registration", ["عرض معلومات المسابقة"]],
  ["instructions", ["بدء الأسئلة التجريبية", "بدء المسابقة الفعلية"]],
  ["practiceComplete", ["ابدأ المسابقة الفعلية"]],
  ["ready", ["بدء السؤال الآن"]],
  ["question", ["إنهاء السؤال وإظهار الإجابة", "+10 ثوانٍ"]],
  ["reveal", ["اعتماد وإظهار النتائج"]],
  ["results", ["السؤال الأخير"]],
  ["finished", []],
];

for (const [stage, expected] of stageCases) {
  test(`Display renders only valid server-backed controls during ${stage}`, () => {
    const currentQuestionIndex = ["question", "reveal", "results"].includes(stage) ? 0 : -1;
    const currentQuestion = ["ready", "question", "reveal", "results"].includes(stage) ? mainQuestions[0] : null;
    assert.deepEqual(labelsFor({ stage, currentQuestionIndex, currentQuestion }), expected);
  });
}

test("Display media controls appear only for an unfinished supported media question", () => {
  const labels = labelsFor({ stage: "question", currentQuestionIndex: 0, currentQuestion: mainQuestions[0] }, {
    isMedia: true,
    mediaEnded: false,
  });
  assert.equal(labels.includes("تجاوز المقطع وإظهار الخيارات"), true);
});

test("Display registration chooses the safe start action for the current mode", () => {
  assert.deepEqual(labelsFor({ stage: "registration", practiceFinished: false }), ["عرض معلومات المسابقة"]);
  assert.deepEqual(labelsFor({ stage: "registration", practiceFinished: true }), ["ابدأ المسابقة"]);
});

test("Display results offers finish only after the final question", () => {
  assert.deepEqual(labelsFor({
    stage: "results",
    currentQuestionIndex: 1,
    currentQuestion: mainQuestions[1],
  }), ["إنهاء المسابقة"]);
});

test("the last reveal exposes the secure winner announcement action", () => {
  assert.deepEqual(labelsFor({
    stage: "reveal",
    currentQuestionIndex: 1,
    currentQuestion: mainQuestions[1],
  }), ["اعتماد النتائج وإعلان الفائزين"]);
});

test("voting transitions remain deferred instead of restoring direct Firestore writes", () => {
  const voting = () => true;
  assert.deepEqual(getPresenterControlDescriptors({
    room: { stage: "results", currentQuestionIndex: 0, currentQuestion: mainQuestions[0] },
    mainQuestions,
    playersCount: 3,
    isVotingQuestion: voting,
  }), []);
  assert.deepEqual(PRESENTER_DEFERRED_CONTROLS, [
    "category-vote",
    "reopen-reveal",
    "admin-poll",
    "prize-wheel",
  ]);
});

function DisplayControlsHarness({ room, operations, finalization }) {
  const controller = usePresenterQuizControls({
    room,
    mainQuestions,
    practiceQuestions,
    playersCount: 3,
    finalization,
    isVotingQuestion: notVoting,
    isMediaQuestion: () => false,
    hasMediaEnded: () => true,
    operations,
    roomId: "test-room",
  });
  return React.createElement(PresenterQuizControls, { controller });
}

function findButton(renderer, label) {
  return renderer.root.findAllByType("button").find((button) => button.children.join("") === label);
}

test("real Display React controls call the injected secure operation and catch failures", async () => {
  const calls = [];
  const operations = {
    revealQuestion: async (data) => calls.push(["reveal", data]),
    extendQuestion: async (data) => calls.push(["extend", data]),
  };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayControlsHarness, {
      room: { stage: "question", currentQuestionIndex: 0, currentQuestion: mainQuestions[0] },
      operations,
      finalization: { isBusy: false, requestFinalization: async () => {} },
    }));
  });
  assert.ok(renderer.root.findByProps({ "aria-label": "أدوات تحكم المقدم" }));
  await act(async () => findButton(renderer, "+10 ثوانٍ").props.onClick());
  await act(async () => findButton(renderer, "إنهاء السؤال وإظهار الإجابة").props.onClick());
  assert.deepEqual(calls, [
    ["extend", { roomId: "test-room", questionId: "q1", seconds: 10 }],
    ["reveal", { roomId: "test-room", questionId: "q1" }],
  ]);
  await act(async () => renderer.unmount());
});

test("Display prevents double clicks while a server action is pending", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const operations = { resetAndOpenRegistration: async () => { calls += 1; await pending; } };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayControlsHarness, {
      room: { stage: "home" },
      operations,
      finalization: { isBusy: false, requestFinalization: async () => {} },
    }));
  });
  const button = findButton(renderer, "فتح التسجيل");
  await act(async () => {
    button.props.onClick();
    button.props.onClick();
    await Promise.resolve();
  });
  assert.equal(calls, 1);
  assert.equal(findButton(renderer, "جاري التنفيذ...").props.disabled, true);
  await act(async () => release());
  await act(async () => renderer.unmount());
});

test("Display renders a safe error instead of leaking an unhandled rejection", async () => {
  const operations = { resetAndOpenRegistration: async () => { throw new Error("private server detail"); } };
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DisplayControlsHarness, {
      room: { stage: "home" },
      operations,
      finalization: { isBusy: false, requestFinalization: async () => {} },
    }));
  });
  await act(async () => findButton(renderer, "فتح التسجيل").props.onClick());
  const alert = renderer.root.findByProps({ role: "alert" });
  assert.match(alert.children.join(""), /تعذر تنفيذ الإجراء/);
  assert.equal(alert.children.join("").includes("private server detail"), false);
  await act(async () => renderer.unmount());
});

test("Admin Control and Display share one server-action mapping", async () => {
  const calls = [];
  const record = (operation) => async (data) => calls.push([operation, data]);
  const operations = createQuizLiveOperations({
    controlLifecycle: record("controlQuizLifecycle"),
    finishQuiz: record("finishQuiz"),
    resetAndOpenRegistration: record("resetAndOpenRegistration"),
    resetPracticeScores: record("resetPracticeScores"),
    prepareQuestion: record("prepareQuestion"),
    startCompetitionWithQuestion: record("startCompetitionWithQuestion"),
    startQuestion: record("startQuestion"),
    controlQuestion: record("controlQuestion"),
  });
  await operations.resetAndOpenRegistration("room-1");
  await operations.startCompetitionWithQuestion({ roomId: "room-1", questionId: "q1", questionIndex: 0 });
  await operations.prepareQuestion({ roomId: "room-1", questionId: "q1", questionIndex: 0 });
  await operations.startQuestion({ roomId: "room-1", questionId: "q1" });
  await operations.revealQuestion({ roomId: "room-1", questionId: "q1" });
  await operations.finishQuiz("room-1");
  assert.deepEqual(calls.map(([operation]) => operation), [
    "resetAndOpenRegistration",
    "startCompetitionWithQuestion",
    "prepareQuestion",
    "startQuestion",
    "controlQuestion",
    "finishQuiz",
  ]);
});

test("Display operations contain no direct Firestore write path", async () => {
  const files = await Promise.all([
    readFile(new URL("../../../src/presenter-quiz-controller.js", import.meta.url), "utf8"),
    readFile(new URL("../../../src/presenter-quiz-controls.js", import.meta.url), "utf8"),
    readFile(new URL("../../../src/quiz-live-operations.js", import.meta.url), "utf8"),
    readFile(new URL("../../../src/quiz-live-operations-core.js", import.meta.url), "utf8"),
  ]);
  const source = files.join("\n");
  assert.doesNotMatch(source, /firebase\/firestore|\bsetDoc\b|\bupdateDoc\b|\baddDoc\b|\bdeleteDoc\b/);
  assert.match(source, /controlQuizLifecycleSecurely/);
  assert.match(source, /controlQuestionSecurely/);
  assert.match(source, /finalize|requestFinalization/);
});

test("Display is authenticated, mounts the operational dock, and no presenter route remains", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  const displayBranchStart = source.indexOf(`if (initialView === APP_VIEWS.DISPLAY)`);
  const displayBranchEnd = source.indexOf(`if (!room)`, displayBranchStart);
  const displayBranch = source.slice(
    displayBranchStart,
    displayBranchEnd,
  );
  assert.match(displayBranch, /ControlledDisplayScreen/);
  assert.match(displayBranch, /finalization=\{finalization\}/);
  assert.match(source, /controlDock=\{<PresenterQuizControls controller=\{controller\} \/>\}/);
  assert.doesNotMatch(source, /APP_VIEWS\.PRESENTER|view=presenter|function PresenterScreen/);
  assert.match(source, /viewRequiresAdmin\(requestedView\)/);
  assert.match(source, /adminView === APP_VIEWS\.DISPLAY/);
  assert.doesNotMatch(source, /requestedView === APP_VIEWS\.DISPLAY/);
});

test("Control stays detailed, Display stays visual, and Player route is unchanged", async () => {
  const source = await readFile(new URL("../../../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /return <AdminAuthGate adminView=\{requestedView\} \/>/);
  assert.match(source, /<AdminPanel initialView=\{adminView\} adminSession=\{session\} \/>/);
  assert.match(source, /<AdminControl[\s\S]*room=\{room\}/);
  assert.match(source, /<PlayerPanel \/>/);
  assert.doesNotMatch(source, /<AdminControl[^>]*initialView=\{APP_VIEWS\.DISPLAY\}/);
});
