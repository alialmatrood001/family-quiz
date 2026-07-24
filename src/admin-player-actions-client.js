import { createSingleFlightCallable } from "./callable-client.js";

const adjust = createSingleFlightCallable("adjustPlayerScore", "تعذر تعديل النقاط.");
const resetPractice = createSingleFlightCallable(
  "resetPracticeScores",
  "تعذر إنهاء التدريب وإعادة النقاط.",
);
const resetQuiz = createSingleFlightCallable("resetQuizData", "تعذر مسح بيانات المسابقة.");

export const adjustPlayerScoreSecurely = (data) =>
  adjust(data, `score/${data.roomId}/${data.playerId}`);
export const resetPracticeScoresSecurely = (data) =>
  resetPractice(data, `practice-reset/${data.roomId}`);
export const resetQuizDataSecurely = (data) =>
  resetQuiz(data, `quiz-reset/${data.roomId}/${data.mode}`);
