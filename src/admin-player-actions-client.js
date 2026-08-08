import { createSingleFlightCallable } from "./callable-client.js";

const adjust = createSingleFlightCallable("adjustPlayerScore", "تعذر تعديل النقاط.");
const resetPractice = createSingleFlightCallable(
  "resetPracticeScores",
  "تعذر إنهاء التدريب وإعادة النقاط.",
);
const resetQuiz = createSingleFlightCallable("resetQuizData", "تعذر مسح بيانات المسابقة.");
const resetAndOpenRegistration = createSingleFlightCallable(
  "resetAndOpenRegistration",
  "تعذر فتح التسجيل.",
);
const getPrivateDetails = createSingleFlightCallable(
  "getPlayerPrivateDetails",
  "تعذر قراءة بيانات المتسابق الخاصة.",
);
const initialize = createSingleFlightCallable(
  "initializeQuiz",
  "تعذر إنشاء المسابقة. حاول مرة أخرى.",
);
const deletePlayer = createSingleFlightCallable("deletePlayer", "تعذر حذف المتسابق.");

const controlLifecycle = createSingleFlightCallable(
  "controlQuizLifecycle",
  "Unable to update the quiz stage.",
);
const finish = createSingleFlightCallable("finishQuiz", "Unable to finish the quiz.");

export const adjustPlayerScoreSecurely = (data) =>
  adjust(data, `score/${data.roomId}/${data.playerId}`);
export const resetPracticeScoresSecurely = (data) =>
  resetPractice(data, `practice-reset/${data.roomId}`);
export const resetQuizDataSecurely = (data) =>
  resetQuiz(data, `quiz-reset/${data.roomId}/${data.mode}`);
export const resetAndOpenRegistrationSecurely = (data) =>
  resetAndOpenRegistration(data, `registration-reset/${data.roomId}`);
export const getPlayerPrivateDetailsSecurely = (data) =>
  getPrivateDetails(data, `private/${data.roomId}/${data.playerId}`);
export const initializeQuizSecurely = (data) =>
  initialize(data, `quiz-initialize/${data.roomId}`);
export const deletePlayerSecurely = (data) =>
  deletePlayer(data, `delete/${data.roomId}/${data.playerId}`);
export const controlQuizLifecycleSecurely = (data) =>
  controlLifecycle(data, `quiz-lifecycle/${data.roomId}/${data.action}`);
export const finishQuizSecurely = (data) => finish(data, `quiz-finish/${data.roomId}`);
