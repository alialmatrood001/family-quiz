import React from "react";
import { QUIZ_STAGES } from "./quiz-state-machine.js";

const NAVIGATION_HIDDEN_STAGES = new Set([
  QUIZ_STAGES.HOME,
  QUIZ_STAGES.READY,
  QUIZ_STAGES.PRIZE_WHEEL,
  QUIZ_STAGES.FINAL_COUNTDOWN,
]);

export function shouldRenderDisplayNavigation(stage) {
  return !NAVIGATION_HIDDEN_STAGES.has(stage);
}

export function DisplayNavigationControls({
  stage,
  previewStage,
  finalQuestion,
  showFinalQuestionResults,
  onPrevious,
  onNext,
  onReturnToLive,
  onToggleFinalQuestionResults,
}) {
  if (!shouldRenderDisplayNavigation(stage)) return null;

  const isPreviewing = !!previewStage;
  return React.createElement(
    "div",
    {
      className: "display-history-nav",
      "aria-label": "التنقل بين مراحل العرض",
      "data-display-stage": stage,
      "data-preview-active": String(isPreviewing),
    },
    React.createElement(
      "button",
      {
        type: "button",
        className: "display-nav-button display-next-button",
        onClick: onNext,
        disabled: !isPreviewing,
      },
      "التالي",
    ),
    React.createElement(
      "button",
      {
        type: "button",
        className: "display-nav-button display-back-button",
        onClick: onPrevious,
      },
      "السابق",
    ),
    React.createElement(
      "button",
      {
        type: "button",
        className: "display-nav-button display-current-stage-button",
        onClick: onReturnToLive,
        disabled: !isPreviewing,
        "aria-pressed": !isPreviewing,
      },
      "العرض الحالي",
    ),
    stage === QUIZ_STAGES.FINISHED && !isPreviewing
      ? React.createElement(
          "button",
          {
            type: "button",
            className: "display-nav-button display-current-stage-button",
            onClick: onToggleFinalQuestionResults,
            disabled: !finalQuestion,
          },
          showFinalQuestionResults ? "العودة للفائزين" : "نتائج السؤال الأخير",
        )
      : null,
  );
}
