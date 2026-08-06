import { useCallback, useEffect, useRef, useState } from "react";
import { questionFinalizationClient } from "./finalize-question-client.js";
import {
  INITIAL_RESULT_WAIT_MS,
  attemptFinalizationResume,
} from "./finalization-resume.js";

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

export function useQuestionFinalization({
  room,
  canFinalize,
  officialResultState,
  onResumeDecision,
  finalizationClient = questionFinalizationClient,
  initialResultWaitMs = INITIAL_RESULT_WAIT_MS,
}) {
  const [state, setState] = useState(INITIAL_STATE);
  const [requestActive, setRequestActive] = useState(false);
  const [initializedQuestionId, setInitializedQuestionId] = useState("");
  const [resultWaitExpiredQuestionId, setResultWaitExpiredQuestionId] = useState("");
  const abortRef = useRef(null);
  const requestRef = useRef(null);
  const attemptedResumeRef = useRef(null);
  const questionId = room?.currentQuestion?.questionId || room?.currentQuestion?.id || "";

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    requestRef.current = null;
    attemptedResumeRef.current = null;
    setResultWaitExpiredQuestionId("");
    setRequestActive(false);
    setState(INITIAL_STATE);
    setInitializedQuestionId(questionId);
  }, [questionId]);

  useEffect(() => {
    const resultStateMatchesQuestion =
      String(officialResultState?.questionId || "") === String(questionId);
    if (
      !questionId ||
      (resultStateMatchesQuestion && officialResultState?.loading !== true)
    ) return undefined;
    const timer = setTimeout(
      () => setResultWaitExpiredQuestionId(String(questionId)),
      Math.max(0, Number(initialResultWaitMs) || 0),
    );
    return () => clearTimeout(timer);
  }, [
    initialResultWaitMs,
    officialResultState?.loading,
    officialResultState?.questionId,
    questionId,
  ]);

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
        const result = await finalizationClient.finalizeAndWait({
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
  }, [canFinalize, finalizationClient, questionId]);

  useEffect(() => {
    const resultStateMatchesQuestion =
      String(officialResultState?.questionId || "") === String(questionId);
    const { promise } = attemptFinalizationResume({
      context: {
        room,
        canFinalize,
        hookReady: initializedQuestionId === questionId,
        officialResultLoading:
          !resultStateMatchesQuestion || officialResultState?.loading === true,
        initialResultWaitExpired:
          resultWaitExpiredQuestionId === String(questionId),
        officialResultExists:
          resultStateMatchesQuestion && officialResultState?.exists === true,
        requestActive,
      },
      attemptedRef: attemptedResumeRef,
      request: requestFinalization,
      onDecision: onResumeDecision,
    });
    promise?.catch((error) => {
      if (error?.code !== "cancelled" && import.meta.env.DEV) {
        console.error("Automatic finalization resume failed.", error?.code);
      }
    });
  }, [
    canFinalize,
    initializedQuestionId,
    officialResultState?.exists,
    officialResultState?.loading,
    officialResultState?.questionId,
    onResumeDecision,
    questionId,
    requestActive,
    requestFinalization,
    resultWaitExpiredQuestionId,
    room,
  ]);

  return {
    ...state,
    hasActiveRequest: requestActive,
    isBusy: ["requesting", "processing", "recovering"].includes(state.status),
    message: state.error ? getFinalizeErrorMessage(state.error.code) : "",
    requestFinalization,
  };
}
