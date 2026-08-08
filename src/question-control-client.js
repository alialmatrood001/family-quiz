import { createSingleFlightCallable } from "./callable-client.js";

const prepare = createSingleFlightCallable("prepareQuestion", "تعذر تجهيز السؤال.");
const startCompetitionWithQuestion = createSingleFlightCallable(
  "startCompetitionWithQuestion",
  "تعذر بدء المسابقة وتجهيز السؤال.",
);
const start = createSingleFlightCallable("startQuestion", "تعذر بدء السؤال.");
const control = createSingleFlightCallable("controlQuestion", "تعذر التحكم في السؤال.");

export const prepareQuestionSecurely = (data) =>
  prepare(data, `prepare/${data.roomId}/${data.questionId}`);
export const startCompetitionWithQuestionSecurely = (data) =>
  startCompetitionWithQuestion(data, `competition-start/${data.roomId}/${data.questionId}`);
export const startQuestionSecurely = (data) =>
  start(data, `start/${data.roomId}/${data.questionId}`);
export const controlQuestionSecurely = (data) =>
  control(data, `control/${data.roomId}/${data.questionId}/${data.action}`);
