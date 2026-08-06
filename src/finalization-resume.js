const RESUMABLE_STAGES = new Set(["reveal", "finalizing", "results"]);
const RESUMABLE_STATES = new Set(["processing", "failed", "completed"]);

export const INITIAL_RESULT_WAIT_MS = 1_500;

export function timestampToMillis(value) {
  if (
    (typeof value === "number" || (typeof value === "string" && value.trim())) &&
    Number.isFinite(Number(value))
  ) return Number(value);
  if (value && typeof value.toMillis === "function") {
    const milliseconds = Number(value.toMillis());
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const seconds = Number(value?.seconds ?? value?._seconds);
  const nanoseconds = Number(value?.nanoseconds ?? value?._nanoseconds ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanoseconds)) return null;
  return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
}

export function finalizationStartedAtMs(room) {
  const numeric = Number(
    room?.finalization?.startedAtMs ?? room?.processingStartedAtMs,
  );
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return timestampToMillis(room?.finalization?.startedAt);
}

export function decideFinalizationResume({
  room,
  canFinalize,
  hookReady,
  officialResultLoading,
  initialResultWaitExpired,
  officialResultExists,
  requestActive,
  attemptedQuestionId,
  nowMs = Date.now(),
} = {}) {
  const questionId = String(
    room?.currentQuestion?.questionId ||
      room?.currentQuestion?.id ||
      room?.activeQuestionId ||
      "",
  ).trim();
  const stage = String(room?.stage || "");
  const finalizationState = String(room?.finalization?.status || "");
  const startedAtMs = finalizationStartedAtMs(room);
  const lockAgeMs = startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs);
  const base = {
    questionId,
    activeQuestionId: String(room?.activeQuestionId || ""),
    currentQuestionId: String(
      room?.currentQuestion?.questionId || room?.currentQuestion?.id || "",
    ),
    stage,
    finalizationState,
    lockAgeMs,
    hookReady: hookReady === true,
    initialResultLoaded: officialResultLoading !== true,
    officialResultExists: officialResultExists === true,
    requestActive: requestActive === true,
  };

  if (!canFinalize) return { ...base, shouldResume: false, reason: "auth-not-ready" };
  if (!questionId) return { ...base, shouldResume: false, reason: "no-active-question" };
  if (!hookReady) return { ...base, shouldResume: false, reason: "hook-not-ready" };
  if (!RESUMABLE_STAGES.has(stage)) {
    return { ...base, shouldResume: false, reason: "stage-not-finalizable" };
  }
  const completedRoomIsConsistent =
    finalizationState === "completed" &&
    stage === "results" &&
    String(room?.processedQuestionId || "") === questionId;
  if (officialResultExists && (finalizationState !== "completed" || completedRoomIsConsistent)) {
    return { ...base, shouldResume: false, reason: "result-exists" };
  }
  if (!RESUMABLE_STATES.has(finalizationState)) {
    return { ...base, shouldResume: false, reason: "status-not-resumable" };
  }
  if (officialResultLoading && !initialResultWaitExpired) {
    return { ...base, shouldResume: false, reason: "waiting-for-initial-result" };
  }
  if (requestActive) return { ...base, shouldResume: false, reason: "manual-request-active" };
  if (String(attemptedQuestionId || "") === questionId) {
    return { ...base, shouldResume: false, reason: "already-attempted" };
  }
  return {
    ...base,
    shouldResume: true,
    reason: "resume-request-started",
  };
}

export function createStagingFinalizationResumeLogger(environment, logger = console) {
  if (String(environment?.VITE_APP_ENV || "") !== "staging") return undefined;
  return (decision) => {
    logger.info?.("[staging-finalization-resume]", {
      reason: decision.reason,
      activeQuestionId: decision.activeQuestionId || null,
      currentQuestionId: decision.currentQuestionId || null,
      stage: decision.stage || null,
      finalizationStatus: decision.finalizationState || null,
      resultListenerInitialized: decision.initialResultLoaded,
      resultExists: decision.officialResultExists,
      hookReady: decision.hookReady,
      requestActive: decision.requestActive,
      effectMounted: true,
    });
  };
}

export function attemptFinalizationResume({ context, attemptedRef, request, onDecision } = {}) {
  const decision = decideFinalizationResume({
    ...context,
    attemptedQuestionId: attemptedRef?.current,
  });
  onDecision?.(decision);
  if (!decision.shouldResume) return { decision, promise: null };

  attemptedRef.current = decision.questionId;
  return {
    decision,
    promise: Promise.resolve().then(request),
  };
}
