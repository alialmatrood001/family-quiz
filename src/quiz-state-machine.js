export const QUIZ_STAGES = Object.freeze({
  HOME: "home",
  INSTRUCTIONS: "instructions",
  REGISTRATION: "registration",
  PRACTICE_COMPLETE: "practiceComplete",
  CATEGORY_VOTE: "categoryVote",
  READY: "ready",
  QUESTION: "question",
  REVEAL: "reveal",
  RESULTS: "results",
  FINAL_COUNTDOWN: "finalCountdown",
  PRIZE_WHEEL: "prizeWheel",
  FINISHED: "finished",
});

export const QUIZ_STAGE_TRANSITIONS = Object.freeze({
  [QUIZ_STAGES.HOME]: [QUIZ_STAGES.REGISTRATION],
  [QUIZ_STAGES.REGISTRATION]: [QUIZ_STAGES.INSTRUCTIONS, QUIZ_STAGES.READY, QUIZ_STAGES.CATEGORY_VOTE],
  [QUIZ_STAGES.INSTRUCTIONS]: [QUIZ_STAGES.REGISTRATION, QUIZ_STAGES.READY, QUIZ_STAGES.CATEGORY_VOTE],
  [QUIZ_STAGES.PRACTICE_COMPLETE]: [QUIZ_STAGES.READY, QUIZ_STAGES.CATEGORY_VOTE],
  [QUIZ_STAGES.CATEGORY_VOTE]: [QUIZ_STAGES.READY],
  [QUIZ_STAGES.READY]: [QUIZ_STAGES.QUESTION],
  [QUIZ_STAGES.QUESTION]: [QUIZ_STAGES.REVEAL],
  [QUIZ_STAGES.REVEAL]: [QUIZ_STAGES.RESULTS, QUIZ_STAGES.FINAL_COUNTDOWN],
  [QUIZ_STAGES.RESULTS]: [QUIZ_STAGES.READY, QUIZ_STAGES.CATEGORY_VOTE, QUIZ_STAGES.FINAL_COUNTDOWN, QUIZ_STAGES.FINISHED],
  [QUIZ_STAGES.FINAL_COUNTDOWN]: [QUIZ_STAGES.FINISHED],
  [QUIZ_STAGES.PRIZE_WHEEL]: Object.values(QUIZ_STAGES).filter((stage) => stage !== QUIZ_STAGES.PRIZE_WHEEL),
  [QUIZ_STAGES.FINISHED]: [QUIZ_STAGES.REGISTRATION],
});

export function isQuizStageTransitionAllowed(from, to) {
  if (from === to) return true;
  return QUIZ_STAGE_TRANSITIONS[from]?.includes(to) === true;
}

export function previousDisplayPreview({ displayStage, displayQuestionIndex, currentQuestionIndex }) {
  if (displayStage === QUIZ_STAGES.FINISHED) {
    return { stage: QUIZ_STAGES.RESULTS, questionIndex: currentQuestionIndex };
  }
  if (displayStage === QUIZ_STAGES.RESULTS) {
    return { stage: QUIZ_STAGES.REVEAL, questionIndex: displayQuestionIndex };
  }
  if (displayStage === QUIZ_STAGES.REVEAL) {
    return { stage: QUIZ_STAGES.QUESTION, questionIndex: displayQuestionIndex };
  }
  if (displayStage === QUIZ_STAGES.QUESTION && displayQuestionIndex > 0) {
    return { stage: QUIZ_STAGES.RESULTS, questionIndex: displayQuestionIndex - 1 };
  }
  if (displayStage === QUIZ_STAGES.QUESTION) {
    return { stage: QUIZ_STAGES.REGISTRATION, questionIndex: null };
  }
  if (displayStage === QUIZ_STAGES.REGISTRATION) {
    return { stage: QUIZ_STAGES.INSTRUCTIONS, questionIndex: null };
  }
  if (displayStage === QUIZ_STAGES.INSTRUCTIONS) {
    return { stage: QUIZ_STAGES.HOME, questionIndex: null };
  }
  return null;
}

export function nextDisplayPreview({
  liveStage,
  previewStage,
  displayStage,
  displayQuestionIndex,
  currentQuestionIndex,
}) {
  if (!previewStage) return null;
  if (displayStage === QUIZ_STAGES.HOME) {
    return { stage: QUIZ_STAGES.INSTRUCTIONS, questionIndex: null };
  }
  if (displayStage === QUIZ_STAGES.INSTRUCTIONS) {
    return { stage: QUIZ_STAGES.REGISTRATION, questionIndex: null };
  }
  if (displayStage === QUIZ_STAGES.REGISTRATION && currentQuestionIndex >= 0) {
    return { stage: QUIZ_STAGES.QUESTION, questionIndex: 0 };
  }
  if (displayStage === QUIZ_STAGES.QUESTION) {
    return { stage: QUIZ_STAGES.REVEAL, questionIndex: displayQuestionIndex };
  }
  if (displayStage === QUIZ_STAGES.REVEAL) {
    if (displayQuestionIndex === currentQuestionIndex && liveStage === QUIZ_STAGES.RESULTS) {
      return { stage: null, questionIndex: null };
    }
    return { stage: QUIZ_STAGES.RESULTS, questionIndex: displayQuestionIndex };
  }
  if (displayStage === QUIZ_STAGES.RESULTS && displayQuestionIndex < currentQuestionIndex) {
    return { stage: QUIZ_STAGES.QUESTION, questionIndex: displayQuestionIndex + 1 };
  }
  return { stage: null, questionIndex: null };
}

export async function runHandledUiAction(action, onError) {
  try {
    await action();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

export function publicPlayerDisplayName(player) {
  return String(player?.displayName || player?.name || "").trim();
}
