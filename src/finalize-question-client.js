import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase.js";
import { normalizeServerError, serverApiClient } from "./server-api-client.js";

const RESULT_WAIT_TIMEOUT_MS = 35_000;
const RECOVERABLE_REQUEST_CODES = new Set([
  "aborted",
  "already-exists",
  "deadline-exceeded",
  "request-timeout",
]);

export function normalizeFinalizeError(error) {
  return normalizeServerError(error, "تعذر إنهاء السؤال.");
}

export function waitForOfficialQuestionResult(
  firestore,
  { roomId, questionId, timeoutMs = RESULT_WAIT_TIMEOUT_MS, signal } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      unsubscribe();
      callback(value);
    };
    const handleAbort = () => finish(reject, { code: "cancelled", message: "تم إلغاء انتظار النتيجة." });
    const timeout = setTimeout(
      () => finish(reject, { code: "deadline-exceeded", message: "تأخر وصول النتيجة الرسمية." }),
      timeoutMs,
    );

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });

    unsubscribe = onSnapshot(
      doc(firestore, "rooms", roomId, "questionResults", questionId),
      (snapshot) => {
        if (snapshot.exists()) {
          finish(resolve, { id: snapshot.id, ...snapshot.data() });
        }
      },
      (error) => finish(reject, normalizeFinalizeError(error)),
    );
  });
}

export async function readOfficialQuestionResult(firestore, { roomId, questionId } = {}) {
  const snapshot = await getDoc(doc(firestore, "rooms", roomId, "questionResults", questionId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

export function createQuestionFinalizationClient({
  firestore,
  finalizeOperation = serverApiClient.finalizeQuestion,
  resultTimeoutMs = RESULT_WAIT_TIMEOUT_MS,
  waitForResult = waitForOfficialQuestionResult,
  readResult = readOfficialQuestionResult,
  maxRecoveryAttempts = 1,
}) {
  const inFlight = new Map();

  async function finalizeAndWait({ roomId, questionId, signal, onAccepted, onRecovering } = {}) {
    const safeRoomId = String(roomId || "").trim();
    const safeQuestionId = String(questionId || "").trim();
    if (!safeRoomId || !safeQuestionId) {
      throw { code: "invalid-argument", message: "بيانات السؤال غير مكتملة." };
    }

    const key = `${safeRoomId}/${safeQuestionId}`;
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }

    const operation = (async () => {
      const requestFinalization = async () => {
        try {
          const response = await finalizeOperation(
            { roomId: safeRoomId, questionId: safeQuestionId },
            { signal },
          );
          onAccepted?.(response);
          return response;
        } catch (error) {
          const normalized = normalizeFinalizeError(error);
          if (!RECOVERABLE_REQUEST_CODES.has(normalized.code)) {
            throw normalized;
          }
          onAccepted?.({ status: "processing" });
          return { status: "processing", uncertain: true };
        }
      };

      const accepted = await requestFinalization();
      if (
        accepted?.officialResult &&
        String(accepted.officialResult.questionId || "") === safeQuestionId &&
        Array.isArray(accepted.officialResult.results)
      ) {
        return { officialResult: accepted.officialResult, source: "server-response" };
      }
      let recoveryAttempt = 0;
      while (true) {
        try {
          const officialResult = await waitForResult(firestore, {
            roomId: safeRoomId,
            questionId: safeQuestionId,
            timeoutMs: resultTimeoutMs,
            signal,
          });
          return { officialResult };
        } catch (error) {
          const normalized = normalizeFinalizeError(error);
          if (normalized.code !== "deadline-exceeded") throw normalized;

          const existingResult = await readResult(firestore, {
            roomId: safeRoomId,
            questionId: safeQuestionId,
          });
          if (existingResult) return { officialResult: existingResult };
          if (recoveryAttempt >= maxRecoveryAttempts) throw normalized;

          recoveryAttempt += 1;
          onRecovering?.({ attempt: recoveryAttempt });
          await requestFinalization();
        }
      }
    })().finally(() => {
      inFlight.delete(key);
    });

    inFlight.set(key, operation);
    return operation;
  }

  return { finalizeAndWait };
}

export const questionFinalizationClient = createQuestionFinalizationClient({
  firestore: db,
});
