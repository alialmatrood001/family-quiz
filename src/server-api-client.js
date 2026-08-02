import { httpsCallable } from "firebase/functions";
import { auth, functions } from "./firebase.js";
import {
  SERVER_OPERATIONS,
  ServerApiError,
  createServerApiClient,
  normalizeServerError,
  resolveServerTransport,
} from "./server-api-core.js";

export function createFirebaseCallableInvoker(functionsInstance = functions) {
  const callables = new Map();
  return async (operation, data) => {
    if (!callables.has(operation)) {
      callables.set(operation, httpsCallable(functionsInstance, operation));
    }
    const response = await callables.get(operation)(data);
    return response.data;
  };
}

const viteEnvironment = import.meta.env || {};
export const serverTransport = resolveServerTransport(
  viteEnvironment.VITE_SERVER_TRANSPORT,
);

export const serverApiClient = createServerApiClient({
  transport: serverTransport,
  auth,
  callableInvoker: createFirebaseCallableInvoker(functions),
});

export {
  SERVER_OPERATIONS,
  ServerApiError,
  createServerApiClient,
  normalizeServerError,
  resolveServerTransport,
};

export const registerPlayer = (data, options) => serverApiClient.registerPlayer(data, options);
export const recoverPlayer = (data, options) => serverApiClient.recoverPlayer(data, options);
export const submitAnswer = (data, options) => serverApiClient.submitAnswer(data, options);
export const activateJoker = (data, options) => serverApiClient.activateJoker(data, options);
export const cancelJoker = (data, options) => serverApiClient.cancelJoker(data, options);
export const updatePlayerProfile = (data, options) =>
  serverApiClient.updatePlayerProfile(data, options);
export const prepareQuestion = (data, options) => serverApiClient.prepareQuestion(data, options);
export const startQuestion = (data, options) => serverApiClient.startQuestion(data, options);
export const controlQuestion = (data, options) => serverApiClient.controlQuestion(data, options);
export const finalizeQuestion = (data, options) => serverApiClient.finalizeQuestion(data, options);
export const controlQuizLifecycle = (data, options) =>
  serverApiClient.controlQuizLifecycle(data, options);
export const finishQuiz = (data, options) => serverApiClient.finishQuiz(data, options);
export const adjustPlayerScore = (data, options) =>
  serverApiClient.adjustPlayerScore(data, options);
export const getPlayerPrivateDetails = (data, options) =>
  serverApiClient.getPlayerPrivateDetails(data, options);
export const initializeQuiz = (data, options) => serverApiClient.initializeQuiz(data, options);
export const deletePlayer = (data, options) => serverApiClient.deletePlayer(data, options);
export const resetPracticeScores = (data, options) =>
  serverApiClient.resetPracticeScores(data, options);
export const resetQuizData = (data, options) => serverApiClient.resetQuizData(data, options);
