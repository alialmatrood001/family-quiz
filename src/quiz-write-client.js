import { createSingleFlightCallable } from "./callable-client.js";
import { ensureAnonymousPlayerAuth } from "./player-auth.js";

const callRegisterPlayer = createSingleFlightCallable(
  "registerPlayer",
  "تعذر تسجيل المتسابق.",
);
const callSubmitAnswer = createSingleFlightCallable(
  "submitAnswer",
  "تعذر إرسال الإجابة.",
);
const callRecoverPlayer = createSingleFlightCallable(
  "recoverPlayer",
  "تعذر استعادة تسجيل المتسابق.",
);
const callUpdatePlayerProfile = createSingleFlightCallable(
  "updatePlayerProfile",
  "تعذر تحديث بيانات المتسابق.",
);
const callActivateJoker = createSingleFlightCallable(
  "activateJoker",
  "تعذر تفعيل الجوكر.",
);
const callCancelJoker = createSingleFlightCallable(
  "cancelJoker",
  "تعذر إلغاء الجوكر.",
);

async function authenticatedCall(callable, data, key) {
  await ensureAnonymousPlayerAuth();
  return callable(data, key);
}

export const registerPlayerSecurely = (data) =>
  authenticatedCall(callRegisterPlayer, data, `register/${data.roomId}`);

export const recoverPlayerSecurely = (data) =>
  authenticatedCall(callRecoverPlayer, data, `recover/${data.roomId}`);

export const updatePlayerProfileSecurely = (data) =>
  authenticatedCall(
    callUpdatePlayerProfile,
    data,
    `profile/${data.roomId}/${data.playerId}`,
  );

export const submitAnswerSecurely = (data) =>
  authenticatedCall(
    callSubmitAnswer,
    data,
    `answer/${data.roomId}/${data.questionId}/${data.playerId}`,
  );

export const activateJokerSecurely = (data) =>
  authenticatedCall(
    callActivateJoker,
    data,
    `joker/${data.roomId}/${data.questionId}/${data.playerId}`,
  );

export const cancelJokerSecurely = (data) =>
  authenticatedCall(callCancelJoker, data, `joker-cancel/${data.roomId}/${data.playerId}`);
