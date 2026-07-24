import { createSingleFlightCallable } from "./callable-client.js";

const adjust = createSingleFlightCallable("adjustPlayerScore", "تعذر تعديل النقاط.");
const resetPractice = createSingleFlightCallable(
  "resetPracticeScores",
  "تعذر إنهاء التدريب وإعادة النقاط.",
);
const resetQuiz = createSingleFlightCallable("resetQuizData", "تعذر مسح بيانات المسابقة.");
const getPrivateDetails = createSingleFlightCallable(
  "getPlayerPrivateDetails",
  "تعذر قراءة بيانات المتسابق الخاصة.",
);
const deletePlayer = createSingleFlightCallable("deletePlayer", "تعذر حذف المتسابق.");

export const adjustPlayerScoreSecurely = (data) =>
  adjust(data, `score/${data.roomId}/${data.playerId}`);
export const resetPracticeScoresSecurely = (data) =>
  resetPractice(data, `practice-reset/${data.roomId}`);
export const resetQuizDataSecurely = (data) =>
  resetQuiz(data, `quiz-reset/${data.roomId}/${data.mode}`);
export const getPlayerPrivateDetailsSecurely = (data) =>
  getPrivateDetails(data, `private/${data.roomId}/${data.playerId}`);
export const deletePlayerSecurely = (data) =>
  deletePlayer(data, `delete/${data.roomId}/${data.playerId}`);
