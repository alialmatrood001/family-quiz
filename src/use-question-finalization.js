import { useCallback, useEffect, useRef, useState } from "react";
import { questionFinalizationClient } from "./finalize-question-client.js";

const INITIAL_STATE = { status: "idle", error: null, result: null };

export function getFinalizeErrorMessage(code) {
  const messages = {
    unauthenticated: "يجب تسجيل الدخول بحساب إداري.",
    "permission-denied": "الحساب لا يملك صلاحية الإدارة.",
    "invalid-argument": "بيانات السؤال غير مكتملة.",
    "not-found": "الغرفة أو السؤال غير موجود.",
    "failed-precondition": "لا يمكن إنهاء السؤال في حالته الحالية.",
    "already-finalized": "تم احتساب هذا السؤال سابقًا.",
    "already-processed-or-busy": "توجد عملية احتساب جارية.",
    aborted: "توجد عملية احتساب جارية؛ ننتظر نتيجتها.",
    internal: "حدث خطأ غير متوقع أثناء الاحتساب.",
    "deadline-exceeded": "تأخر وصول النتيجة الرسمية. يمكنك إعادة المحاولة بأمان.",
  };
  return messages[code] || "تعذر إنهاء السؤال. حاول مرة أخرى.";
}

export function useQuestionFinalization({ room, canFinalize }) {
  const [state, setState] = useState(INITIAL_STATE);
  const [requestActive, setRequestActive] = useState(false);
  const abortRef = useRef(null);
  const requestRef = useRef(null);
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || "";

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestRef.current = null;
    setRequestActive(false);
    setState(INITIAL_STATE);
  }, [questionId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!questionId) return;
    if (String(room?.processedQuestionId || "") === String(questionId)) {
      setState((current) => (
        current.status === "completed"
          ? current
          : { status: "completed", error: null, result: current.result }
      ));
    } else if (
      String(room?.processingQuestionId || room?.finalization?.questionId || "") === String(questionId)
    ) {
      setState((current) => (
        current.status === "requesting"
          ? current
          : { ...current, status: "processing", error: null }
      ));
    }
  }, [questionId, room?.processedQuestionId, room?.processingQuestionId, room?.finalization?.questionId]);

  const requestFinalization = useCallback(() => {
    if (requestRef.current) {
      return requestRef.current;
    }
    if (!canFinalize) {
      const error = { code: "permission-denied" };
      setState({ status: "error", error, result: null });
      return Promise.reject(error);
    }
    if (!questionId) {
      const error = { code: "invalid-argument" };
      setState({ status: "error", error, result: null });
      return Promise.reject(error);
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRequestActive(true);
    setState({ status: "requesting", error: null, result: null });

    const operation = (async () => {
      try {
        const result = await questionFinalizationClient.finalizeAndWait({
          roomId: "family-quiz-001",
          questionId,
          signal: controller.signal,
          onAccepted: () => setState({ status: "processing", error: null, result: null }),
          onRecovering: () => setState({ status: "recovering", error: null, result: null }),
        });
        setState({ status: "completed", error: null, result: result.officialResult });
        return result;
      } catch (error) {
        if (error?.code !== "cancelled") {
          setState({ status: "error", error, result: null });
        }
        throw error;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (requestRef.current === operation) {
          requestRef.current = null;
        }
        setRequestActive(false);
      }
    })();
    requestRef.current = operation;
    return operation;
  }, [canFinalize, questionId]);

  return {
    ...state,
    hasActiveRequest: requestActive,
    isBusy: ["requesting", "processing", "recovering"].includes(state.status),
    message: state.error ? getFinalizeErrorMessage(state.error.code) : "",
    requestFinalization,
  };
}
