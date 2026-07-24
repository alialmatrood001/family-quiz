import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase.js";

const RESULT_WAIT_TIMEOUT_MS = 25_000;

export function normalizeFinalizeError(error) {
  const rawCode = String(error?.code || "internal");
  const code = rawCode.replace(/^functions\//, "");
  return {
    code,
    message: String(error?.message || "تعذر إنهاء السؤال."),
  };
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

export function createQuestionFinalizationClient({
  firestore,
  functionsInstance,
  resultTimeoutMs = RESULT_WAIT_TIMEOUT_MS,
}) {
  const callable = httpsCallable(functionsInstance, "finalizeQuestion");
  const inFlight = new Map();

  async function finalizeAndWait({ roomId, questionId, signal, onAccepted } = {}) {
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
      try {
        const response = await callable({ roomId: safeRoomId, questionId: safeQuestionId });
        onAccepted?.(response.data);
      } catch (error) {
        const normalized = normalizeFinalizeError(error);
        if (normalized.code !== "aborted" && normalized.code !== "already-exists") {
          throw normalized;
        }
        onAccepted?.({ status: "processing" });
      }

      const officialResult = await waitForOfficialQuestionResult(firestore, {
        roomId: safeRoomId,
        questionId: safeQuestionId,
        timeoutMs: resultTimeoutMs,
        signal,
      });
      return { officialResult };
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
  functionsInstance: functions,
});
